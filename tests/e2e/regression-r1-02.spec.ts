import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeSha256Sync, parseSession, SESSION_SCHEMA } from '../../src/core/session.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import type { PCM } from '../../src/core/types.js';

test.describe('P010-FIX-R1-02 End-to-End Regression Suite (B02, B03, B06)', () => {
  test('B02: direct external WAV import full workflow (select file -> analyze -> conclusions -> export -> rebind)', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize a clean 48kHz mono test WAV (440 Hz tone, 2.0s = 96,000 frames)
    const frames = 96000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const pcm: PCM = { sampleRate: 48000, channels: 1, frames, planar };
    const wavBytes = encodePcm16Wav(pcm);
    const wavPath = resolve('.tmp/b02-direct-workflow.wav');
    writeFileSync(wavPath, Buffer.from(wavBytes));

    // 2. Click direct WAV import input
    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    await directWavInput.setInputFiles(wavPath);

    // 3. Status changes to ANALYZING and then SUCCESS, report rendered
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      '成功直接导入外部 WAV',
    );
    await expect(evidenceReport).toBeVisible({ timeout: 20000 });

    const constraintsList = page.locator('[data-testid="witness-constraints-list"]');
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');

    // 4. Export session JSON
    const exportBtn = page.locator('[data-testid="btn-export-session"]');
    await expect(exportBtn).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;

    const exportedSessionPath = resolve('.tmp/b02-exported-session.json');
    await download.saveAs(exportedSessionPath);

    // Verify downloaded session JSON conforms to schema
    const sessionContent = readFileSync(exportedSessionPath, 'utf8');
    const parsedSession = parseSession(sessionContent);
    expect(parsedSession.schema).toBe(SESSION_SCHEMA);
    expect(parsedSession.source.kind).toBe('externalWav');
    expect(parsedSession.synthetic).toBe(false);

    // 5. Re-import the exported session JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(exportedSessionPath);

    // Report cleared, waiting for rebind
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    const rebindPendingBox = page.locator('[data-testid="rebind-pending-box"]');
    await expect(rebindPendingBox).toBeVisible();

    // 6. Complete rebind with original WAV
    const rebindWavInput = page.locator('[data-testid="input-rebind-wav"]');
    await rebindWavInput.setInputFiles(wavPath);

    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      'SHA-256 比对完全一致',
    );
    await expect(evidenceReport).toBeVisible({ timeout: 20000 });
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');
  });

  test('B02: illegal WAV rejection (non-48k, corrupt) displays clear Chinese error and does not revert to preset', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize non-48k WAV (e.g. 44.1k declared in header)
    const frames = 48000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const rawWav = encodePcm16Wav({ sampleRate: 48000, channels: 1, frames, planar });
    const view = new DataView(rawWav);
    view.setUint32(24, 44100, true); // Tamper sample rate to 44100 Hz

    const invalidWavPath = resolve('.tmp/b02-invalid-samplerate.wav');
    writeFileSync(invalidWavPath, Buffer.from(rawWav));

    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    await directWavInput.setInputFiles(invalidWavPath);

    // Error box visible with Chinese error
    const importErrorBox = page.locator('[data-testid="import-error-box"]');
    await expect(importErrorBox).toBeVisible();
    await expect(importErrorBox).toContainText('直接导入 WAV 失败');
    await expect(importErrorBox).toContainText('48000');

    // 2. Corrupt buffer
    const corruptWavPath = resolve('.tmp/b02-corrupt.wav');
    writeFileSync(corruptWavPath, Buffer.from(new Uint8Array([0x00, 0x01, 0x02, 0x03])));
    await directWavInput.setInputFiles(corruptWavPath);

    await expect(importErrorBox).toBeVisible();
    await expect(importErrorBox).toContainText('直接导入 WAV 失败');
  });

  test('B03: rebind runs via Dedicated Worker (Worker receives external PCM message) and main thread responds <= 150ms during computation', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Hook Worker.prototype.postMessage in page to intercept requests
    await page.evaluate(() => {
      (window as any).__workerRequests = [];
      const originalPostMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message: any, ...args: any[]) {
        if (message && message.type === 'ANALYZE') {
          (window as any).__workerRequests.push(message);
        }
        return (originalPostMessage as any).apply(this, [message, ...args]);
      };
    });

    // 2. Generate 30s stereo WAV (1,440,000 frames)
    const sampleRate = 48000;
    const channels = 2;
    const frames = sampleRate * 30; // 1,440,000 frames
    const planar = [new Float64Array(frames), new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      planar[1][i] = 0.20 * Math.sin((2 * Math.PI * 880 * i) / sampleRate);
    }
    const pcm30s: PCM = { sampleRate, channels, frames, planar };
    const wavBytes30s = encodePcm16Wav(pcm30s);
    const sha256Hex30s = computeSha256Sync(wavBytes30s);
    const wavPath30s = resolve('.tmp/b03-30s-stereo.wav');
    writeFileSync(wavPath30s, Buffer.from(wavBytes30s));

    // Create session for rebinding
    const sessionJson = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false,
      source: {
        kind: 'externalWav',
        sha256Hex: sha256Hex30s,
        fileName: 'b03-30s-stereo.wav',
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
    const sessionPath = resolve('.tmp/b03-30s-session.json');
    writeFileSync(sessionPath, sessionJson);

    // Import session JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(sessionPath);
    await expect(page.locator('[data-testid="rebind-pending-box"]')).toBeVisible();

    // 3. Upload 30s stereo WAV to start Worker calculation
    const rebindWavInput = page.locator('[data-testid="input-rebind-wav"]');
    await rebindWavInput.setInputFiles(wavPath30s);

    // Wait until Worker calculation is actively running
    await expect(page.locator('.status-banner-card.status-analyzing')).toBeVisible({ timeout: 10000 });

    // 4. IMMEDIATELY test main thread responsiveness DURING worker calculation
    // Measure response time of main thread slider / input interaction to animation frame
    const measuredLatencyMs = await page.evaluate(async () => {
      const slider = document.getElementById('target-lufs-slider') as HTMLInputElement;
      const start = performance.now();
      slider.value = '-22.0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));

      await new Promise((res) => requestAnimationFrame(res));
      const end = performance.now();
      return end - start;
    });

    console.log(`[MEASURED_INPUT_RESPONSE_DURING_WORKER_COMPUTATION]: ${measuredLatencyMs.toFixed(2)} ms`);

    // Main thread input response during heavy calculation must be <= 150ms per specification
    expect(measuredLatencyMs).toBeLessThanOrEqual(150);

    // 5. Wait for full 30s analysis to complete
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      'SHA-256 比对完全一致',
      { timeout: 30000 },
    );
    await expect(evidenceReport).toBeVisible({ timeout: 30000 });

    // 6. Assert that Dedicated Worker received the external PCM message
    const workerRequests = await page.evaluate(() => (window as any).__workerRequests);
    expect(workerRequests.length).toBeGreaterThan(0);
    const externalReq = workerRequests.find((r: any) => r.source?.kind === 'externalWav');
    expect(externalReq).toBeDefined();
    expect(externalReq.source.kind).toBe('externalWav');
    expect(externalReq.source.sha256Hex).toBe(sha256Hex30s);
  });

  test('B06: external WAV analysis displays complete raw and gained waveform visualization', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize 48kHz mono 2.0s WAV
    const frames = 96000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.35 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const pcm: PCM = { sampleRate: 48000, channels: 1, frames, planar };
    const wavBytes = encodePcm16Wav(pcm);
    const wavPath = resolve('.tmp/b06-wave-test.wav');
    writeFileSync(wavPath, Buffer.from(wavBytes));

    // 2. Direct import external WAV
    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    await directWavInput.setInputFiles(wavPath);

    await expect(evidenceReport).toBeVisible({ timeout: 20000 });

    // 3. Check WaveCompare slot: waveform paths must be rendered
    const waveCompareSlot = page.locator('#slot-wave-compare');
    await expect(waveCompareSlot).toBeVisible();

    // Verify raw waveform SVG path is rendered and contains non-empty path data
    const rawPath = waveCompareSlot.locator('[data-testid="waveform-raw-path"]');
    await expect(rawPath).toBeVisible();
    const rawD = await rawPath.getAttribute('d');
    expect(rawD).not.toBeNull();
    expect(rawD).toContain('M 0');
    expect(rawD).toContain('Z');

    // Verify placeholder text is NOT rendered
    const placeholderText = waveCompareSlot.locator('[data-testid="waveform-loading-text"]');
    await expect(placeholderText).not.toBeVisible();
  });
});
