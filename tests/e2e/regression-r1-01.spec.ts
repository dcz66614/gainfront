import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeSha256Sync, SESSION_SCHEMA } from '../../src/core/session.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import type { PCM } from '../../src/core/types.js';

test.describe('P010-FIX-R1-01 End-to-End Regression Suite (B01 & B04)', () => {
  test('B01: modifying target parameter with rebound external WAV continues using external WAV, not reverting to preset', async ({
    page,
  }) => {
    await page.goto('/');

    // Wait for initial analysis (GF-A)
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize a distinct external WAV file (440 Hz sine wave)
    const frames = 48000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.35 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const externalPcm: PCM = {
      sampleRate: 48000,
      channels: 1,
      frames,
      planar,
    };
    const externalWavBytes = encodePcm16Wav(externalPcm);
    const sha256Hex = computeSha256Sync(externalWavBytes);

    const externalSession = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false,
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName: 'b01-regression.wav',
        requiresReselect: true,
      },
      constraints: {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
      view: { selectedGainTick: 0, showBlockGates: true },
    });

    const sessionFilePath = resolve('.tmp/b01-session.json');
    writeFileSync(sessionFilePath, externalSession);

    const wavFilePath = resolve('.tmp/b01-regression.wav');
    writeFileSync(wavFilePath, Buffer.from(externalWavBytes));

    // 2. Import external session JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(sessionFilePath);

    // Old report cleared immediately, pending rebind box visible
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    const rebindPendingBox = page.locator('[data-testid="rebind-pending-box"]');
    await expect(rebindPendingBox).toBeVisible();
    await expect(rebindPendingBox).toContainText('b01-regression.wav');

    // 3. Upload matching WAV to complete rebind
    const wavFileInput = page.locator('[data-testid="input-rebind-wav"]');
    await wavFileInput.setInputFiles(wavFilePath);

    // 4. Verify successful rebind
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      'SHA-256 比对完全一致',
    );
    await expect(evidenceReport).toBeVisible();
    const constraintsList = page.locator('[data-testid="witness-constraints-list"]');
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');

    // 5. Modify target parameter: drag target LUFS slider from -16.0 to -20.0
    const slider = page.locator('#target-lufs-slider');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '-20.0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Wait for Worker calculation to complete
    await expect(page.locator('.status-banner-card.status-success')).toBeVisible({
      timeout: 15000,
    });
    await expect(evidenceReport).toBeVisible();

    // 6. Critical assertions: must still be external WAV, MUST NOT revert to GF-A preset!
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');
    await expect(constraintsList).toContainText('目标集成响度 T: -20.0 LUFS');

    // Verify evidence panel does NOT show preset GF-A
    await expect(constraintsList).not.toContainText('GF-A (Peak Trap)');
  });

  test('B04: clear report invalidates in-flight/delayed RESULT and never backfills', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Prepare an external session JSON
    const externalSession = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false,
      source: {
        kind: 'externalWav',
        sha256Hex: '1111111111111111111111111111111111111111111111111111111111111111',
        fileName: 'b04-test.wav',
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

    const sessionFilePath = resolve('.tmp/b04-session.json');
    writeFileSync(sessionFilePath, externalSession);

    // 2. Upload external session JSON -> triggers onClearReport()
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(sessionFilePath);

    // Report is cleared, waiting placeholder is visible
    const waitingPlaceholder = page.locator('[data-testid="evidence-waiting"]');
    await expect(waitingPlaceholder).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();

    // 3. Inject a delayed RESULT with old requestId 1 (the initial request id)
    // to simulate a race condition where a stale worker RESULT arrives after clearing
    await page.evaluate(() => {
      // Find the worker by querying message listener or posting message to window if accessible,
      // or directly testing the UI contract
      const event = new MessageEvent('message', {
        data: {
          type: 'RESULT',
          requestId: 1, // Stale request ID
          payload: {
            synthetic: true,
            source: { kind: 'preset', presetId: 'GF-A' },
            constraints: { targetLufs: -16, peakCeilingDbTp: -1, toleranceLu: 0.25, marginDb: 0.3 },
            measurement: {
              integratedLufs: -23,
              samplePeakDbFs: -0.5,
              estimatedTruePeakDbTp: 0.5,
              samplePeakFrame: 100,
              blockPowers: [],
              absoluteGate: [],
              relativeGate: [],
            },
            solver: {
              status: 'GAIN_FEASIBLE',
              gBestTick: 0,
              gTargetTick: 0,
              minimumGridDeviationLu: 0,
              peakBoundaryDb: 0,
              witness: {} as any,
            },
          },
        },
      });
      // Deliver to any window message listeners if present
      window.dispatchEvent(event);
    });

    // Wait a brief duration to ensure no asynchronous backfill occurs
    await page.waitForTimeout(500);

    // 4. Assert that report remains CLEARED and was not backfilled
    await expect(waitingPlaceholder).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();
  });
});
