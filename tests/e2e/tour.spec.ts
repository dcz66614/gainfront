import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodePcm16Wav } from '../../src/core/wav.js';
import { computeSha256Sync, createSession, exportSession } from '../../src/core/session.js';
import type { PCM } from '../../src/core/types.js';

test.describe('P010-T015 End-to-End Tour Spec', () => {
  test('executes complete real flow: GF-A blocked witness -> target switch -> GF-B feasible -> export -> re-import preset & external WAV rebind', async ({
    page,
  }) => {
    // 1. Visit application root (built static bundle served by vite preview)
    await page.goto('/');

    // 2. Wait for real Dedicated Worker initial analysis for GF-A (default: T=-16.0, C=-1.0)
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    const statusBadge = page.locator('[data-testid="evidence-status-badge"]');
    await expect(statusBadge).toContainText('GAIN_BLOCKED_PEAK_OR_RANGE');

    // Verify numerical witness values for GF-A
    const gBest = page.locator('[data-testid="evidence-g-best"]');
    const gTarget = page.locator('[data-testid="evidence-g-target"]');
    const deviation = page.locator('[data-testid="evidence-deviation"]');
    const peakBoundary = page.locator('[data-testid="evidence-peak-boundary"]');

    await expect(gBest).toHaveText('+0.6 dB');
    await expect(gTarget).toHaveText('+7.0 dB');
    await expect(deviation).toContainText('6.4005 LU');
    await expect(peakBoundary).toHaveText('0.60 dB');

    // Capture screenshot: GF-A blocked witness
    const screenshot1Path = resolve('evidence/validation-logs/T015-tour-01-gf-a-blocked.png');
    await page.screenshot({ path: screenshot1Path, fullPage: true });

    // 3. Switch target / peak ceiling parameters
    const targetInput = page.locator('#target-lufs-input');
    await targetInput.fill('-20.0');
    await targetInput.dispatchEvent('change');

    // Wait for worker re-calculation to settle
    await expect(page.locator('[data-testid="witness-constraints-list"]')).toContainText(
      '目标集成响度 T: -20.0 LUFS',
    );

    const screenshot2Path = resolve('evidence/validation-logs/T015-tour-02-params-adjusted.png');
    await page.screenshot({ path: screenshot2Path, fullPage: true });

    // 4. Switch to preset GF-B (Safe Gain)
    const gfbPill = page.locator('button.preset-pill:has-text("GF-B")');
    await gfbPill.click();

    // Verify GF-B feasible state
    await expect(statusBadge).toContainText('GAIN_FEASIBLE');
    await expect(gBest).toHaveText('+3.0 dB');
    await expect(deviation).toContainText('0.0036 LU');

    const screenshot3Path = resolve('evidence/validation-logs/T015-tour-03-gf-b-feasible.png');
    await page.screenshot({ path: screenshot3Path, fullPage: true });

    // 5. Export session JSON
    const exportBtn = page.locator('[data-testid="btn-export-session"]');
    await expect(exportBtn).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('gainfront-session-GF-B.json');
    const exportedFilePath = resolve('.tmp/exported-session-GF-B.json');
    await download.saveAs(exportedFilePath);

    // 6. Re-import the exported preset session JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(exportedFilePath);

    // Verify import success and restored state
    const importSuccessBox = page.locator('[data-testid="import-success-box"]');
    await expect(importSuccessBox).toBeVisible();
    await expect(importSuccessBox).toContainText('GF-B');
    await expect(statusBadge).toContainText('GAIN_FEASIBLE');

    const screenshot4Path = resolve('evidence/validation-logs/T015-tour-04-preset-reimported.png');
    await page.screenshot({ path: screenshot4Path, fullPage: true });

    // 7. External WAV workflow:
    // Generate an independent valid 48kHz mono 16-bit WAV file and session JSON
    const frames = 48000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    }
    const testPcm: PCM = {
      sampleRate: 48000,
      channels: 1,
      frames,
      planar,
    };
    const wavBytes = encodePcm16Wav(testPcm);
    const sha256Hex = computeSha256Sync(wavBytes);
    const externalWavPath = resolve('.tmp/tour-external-test.wav');
    writeFileSync(externalWavPath, Buffer.from(wavBytes));

    const externalSession = createSession({
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName: 'tour-external-test.wav',
        requiresReselect: true,
      },
      constraints: {
        targetLufs: -18.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
      synthetic: false,
    });
    const externalSessionJsonPath = resolve('.tmp/tour-external-session.json');
    writeFileSync(externalSessionJsonPath, exportSession(externalSession));

    // Upload the external WAV session JSON
    await jsonFileInput.setInputFiles(externalSessionJsonPath);

    // Contract verification: old report is cleared immediately, pending rebind box is shown
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    const rebindPendingBox = page.locator('[data-testid="rebind-pending-box"]');
    await expect(rebindPendingBox).toBeVisible();
    await expect(rebindPendingBox).toContainText('tour-external-test.wav');
    await expect(rebindPendingBox).toContainText(sha256Hex);

    // Upload the matching WAV file to rebind
    const wavFileInput = page.locator('[data-testid="input-rebind-wav"]');
    await wavFileInput.setInputFiles(externalWavPath);

    // Verify successful rebind and fresh report calculation
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      'SHA-256 比对完全一致',
    );
    await expect(evidenceReport).toBeVisible();
    await expect(page.locator('[data-testid="witness-constraints-list"]')).toContainText(
      '声源性质: 外部 WAV 本地分析',
    );

    const screenshot5Path = resolve(
      'evidence/validation-logs/T015-tour-05-external-wav-rebound.png',
    );
    await page.screenshot({ path: screenshot5Path, fullPage: true });
  });
});
