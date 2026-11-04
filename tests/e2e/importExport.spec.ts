import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSession, SESSION_SCHEMA } from '../../src/core/session.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import type { PCM } from '../../src/core/types.js';

test.describe('P010-T015 Session Import/Export Contract Spec', () => {
  test('exports session JSON and verifies full read-back with T009 parseSession', async ({
    page,
  }) => {
    await page.goto('/');

    // Wait for initial analysis (GF-A)
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // Click export button and catch the download
    const exportBtn = page.locator('[data-testid="btn-export-session"]');
    await expect(exportBtn).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;

    const exportedPath = resolve('.tmp/t015-export-verify.json');
    await download.saveAs(exportedPath);

    // Read exported JSON string
    const rawJson = readFileSync(exportedPath, 'utf8');

    // Parse strictly using core T009 parseSession
    const parsedSession = parseSession(rawJson);

    // Contract assertions
    expect(parsedSession.schema).toBe(SESSION_SCHEMA);
    expect(parsedSession.projectId).toBe('P010');
    expect(parsedSession.specVersion).toBe('1.0.0');
    expect(parsedSession.synthetic).toBe(true);
    expect(parsedSession.source).toEqual({ kind: 'preset', presetId: 'GF-A' });
    expect(parsedSession.constraints).toEqual({
      targetLufs: -16.0,
      peakCeilingDbTp: -1.0,
      toleranceLu: 0.25,
      marginDb: 0.3,
    });

    // Verify critical numerical metrics in audit section
    expect(parsedSession.audit).toBeDefined();
    const auditSolver = parsedSession.audit?.solver;
    expect(auditSolver).toBeDefined();
    expect(auditSolver?.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
    expect(auditSolver?.gBestTick).toBe(6);
    expect(auditSolver?.gTargetTick).toBe(70);
    expect(auditSolver?.minimumGridDeviationLu).toBeCloseTo(6.4005, 3);
    expect(auditSolver?.peakBoundaryDb).toBeCloseTo(0.60, 2);
  });

  test('rejects tampered session JSON (modified specVersion) and clears old conclusion', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // Prepare tampered JSON with invalid specVersion
    const tamperedVersionJson = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '9.9.9', // Tampered version
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
      view: { selectedGainTick: 0, showBlockGates: true },
    });

    const tamperedVersionPath = resolve('.tmp/tampered-version.json');
    writeFileSync(tamperedVersionPath, tamperedVersionJson);

    // Upload tampered JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(tamperedVersionPath);

    // Verify rejection: error box appears
    const importErrorBox = page.locator('[data-testid="import-error-box"]');
    await expect(importErrorBox).toBeVisible();
    await expect(importErrorBox).toContainText('导入失败');

    // Verify old conclusion is cleared per contract
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();

    const screenshot1Path = resolve(
      'evidence/validation-logs/T015-import-01-tampered-version-rejected.png',
    );
    await page.screenshot({ path: screenshot1Path, fullPage: true });
  });

  test('rejects tampered SHA-256 external WAV session and keeps old report cleared', async ({
    page,
  }) => {
    await page.goto('/');

    // Switch to GF-B to have an active valid report
    await page.locator('button.preset-pill:has-text("GF-B")').click();
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="evidence-status-badge"]')).toContainText(
      'GAIN_FEASIBLE',
    );

    // Prepare external session with tampered SHA-256 (64 zeros)
    const tamperedShaHex = '0000000000000000000000000000000000000000000000000000000000000000';
    const tamperedShaSession = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false,
      source: {
        kind: 'externalWav',
        sha256Hex: tamperedShaHex,
        fileName: 'tampered-test.wav',
        requiresReselect: true,
      },
      constraints: {
        targetLufs: -18.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
      view: { selectedGainTick: 0, showBlockGates: true },
    });

    const tamperedShaSessionPath = resolve('.tmp/tampered-sha-session.json');
    writeFileSync(tamperedShaSessionPath, tamperedShaSession);

    // Upload session with tampered SHA
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(tamperedShaSessionPath);

    // Old report must be cleared immediately
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();

    const rebindPendingBox = page.locator('[data-testid="rebind-pending-box"]');
    await expect(rebindPendingBox).toBeVisible();

    // Generate real WAV file (its SHA will definitely not be all zeros)
    const frames = 48000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    }
    const pcm: PCM = { sampleRate: 48000, channels: 1, frames, planar };
    const wavBytes = encodePcm16Wav(pcm);
    const wavPath = resolve('.tmp/tampered-test.wav');
    writeFileSync(wavPath, Buffer.from(wavBytes));

    // Try to rebind with the real WAV file
    const wavFileInput = page.locator('[data-testid="input-rebind-wav"]');
    await wavFileInput.setInputFiles(wavPath);

    // Verify rejection: rebind error box appears with SHA-256 hash mismatch
    const rebindErrorBox = page.locator('[data-testid="rebind-error-box"]');
    await expect(rebindErrorBox).toBeVisible();
    await expect(rebindErrorBox).toContainText('SHA-256');

    // Old report remains cleared
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();

    const screenshot2Path = resolve(
      'evidence/validation-logs/T015-import-02-tampered-sha-rejected.png',
    );
    await page.screenshot({ path: screenshot2Path, fullPage: true });
  });
});
