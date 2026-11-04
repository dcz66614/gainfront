import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeSha256Sync, parseSession, SESSION_SCHEMA } from '../../src/core/session.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import type { PCM } from '../../src/core/types.js';

function createSineWav(seconds: number, channels: 1 | 2, sampleRate: 48000 = 48000, freq = 440) {
  const frames = Math.round(seconds * sampleRate);
  const planar: Float64Array[] = [];
  for (let c = 0; c < channels; c++) {
    const channelData = new Float64Array(frames);
    const channelFreq = freq * (c === 1 ? 1.5 : 1.0);
    const channelAmp = c === 1 ? 0.25 : 0.35;
    for (let i = 0; i < frames; i++) {
      channelData[i] = channelAmp * Math.sin((2 * Math.PI * channelFreq * i) / sampleRate);
    }
    planar.push(channelData);
  }
  const pcm: PCM = { sampleRate: 48000, channels, frames, planar };
  const wavBytes = encodePcm16Wav(pcm);
  const sha256Hex = computeSha256Sync(wavBytes);
  return { pcm, wavBytes, sha256Hex };
}

test.describe('P010-FIX-R1-03 E2E Verification Suite (R1 Blockers Full Coverage)', () => {
  test('Item 1 (Journey): direct import external WAV -> modify parameters -> export session JSON -> clear report -> import session JSON -> rebind same WAV -> verify conclusions restored and match pre-export', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize a clean 2.0s 48kHz mono external WAV
    const { wavBytes, sha256Hex } = createSineWav(2.0, 1, 48000, 440);
    const wavPath = resolve('.tmp/r1-03-journey.wav');
    writeFileSync(wavPath, Buffer.from(wavBytes));

    // 2. Direct import external WAV
    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    await directWavInput.setInputFiles(wavPath);

    // Wait for analysis to complete
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      '成功直接导入外部 WAV',
      { timeout: 20000 },
    );
    await expect(evidenceReport).toBeVisible();

    const constraintsList = page.locator('[data-testid="witness-constraints-list"]');
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');
    await expect(constraintsList).not.toContainText('GF-A');

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-journey-01-direct-wav-analyzed.png'),
    });

    // 3. Modify target parameters: change Target LUFS slider from -16.0 to -20.0
    const slider = page.locator('#target-lufs-slider');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '-20.0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Wait for Worker calculation with new parameters
    await expect(page.locator('.status-banner-card.status-success')).toBeVisible({
      timeout: 15000,
    });
    await expect(evidenceReport).toBeVisible();

    // Critical assertion: conclusion must STILL belong to external WAV, NOT reverting to preset!
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');
    await expect(constraintsList).toContainText('目标集成响度 T: -20.0 LUFS');
    await expect(constraintsList).not.toContainText('GF-A');

    // Extract pre-export metrics to verify recovery later
    const preExportGBest = (await page.locator('[data-testid="evidence-g-best"]').textContent())?.trim();
    const preExportGTarget = (await page.locator('[data-testid="evidence-g-target"]').textContent())?.trim();
    const preExportDeviation = (await page.locator('[data-testid="evidence-deviation"]').textContent())?.trim();
    const preExportPeakBoundary = (await page.locator('[data-testid="evidence-peak-boundary"]').textContent())?.trim();
    const preExportSamplePeak = (await page.locator('[data-testid="evidence-sample-peak"]').textContent())?.trim();

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-journey-02-params-modified.png'),
    });

    // 4. Export session JSON
    const exportBtn = page.locator('[data-testid="btn-export-session"]');
    await expect(exportBtn).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;

    const exportedSessionPath = resolve('.tmp/r1-03-journey-session.json');
    await download.saveAs(exportedSessionPath);

    // Verify session JSON validity
    const rawSessionJson = readFileSync(exportedSessionPath, 'utf8');
    const parsed = parseSession(rawSessionJson);
    expect(parsed.schema).toBe(SESSION_SCHEMA);
    expect(parsed.source.kind).toBe('externalWav');
    if (parsed.source.kind === 'externalWav') {
      expect(parsed.source.sha256Hex).toBe(sha256Hex);
    }
    expect(parsed.constraints.targetLufs).toBe(-20.0);

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-journey-03-session-exported.png'),
    });

    // 5. Clear report and import session JSON
    // Importing external session JSON immediately clears old report per security contract
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(exportedSessionPath);

    // Assert report is CLEARED: waiting placeholder visible, evidence report hidden, rebind box active
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();

    const rebindPendingBox = page.locator('[data-testid="rebind-pending-box"]');
    await expect(rebindPendingBox).toBeVisible();
    await expect(rebindPendingBox).toContainText('必须重新绑定外部 WAV 音频文件');
    await expect(rebindPendingBox).toContainText(sha256Hex);

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-journey-04-report-cleared-pending-rebind.png'),
    });

    // 6. Rebind original WAV
    const rebindWavInput = page.locator('[data-testid="input-rebind-wav"]');
    await rebindWavInput.setInputFiles(wavPath);

    // Assert rebind succeeded via Dedicated Worker and conclusion is restored
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      'SHA-256 比对完全一致',
      { timeout: 20000 },
    );
    await expect(evidenceReport).toBeVisible();

    // 7. Verify restored conclusion is identical to pre-export state
    const restoredGBest = (await page.locator('[data-testid="evidence-g-best"]').textContent())?.trim();
    const restoredGTarget = (await page.locator('[data-testid="evidence-g-target"]').textContent())?.trim();
    const restoredDeviation = (await page.locator('[data-testid="evidence-deviation"]').textContent())?.trim();
    const restoredPeakBoundary = (await page.locator('[data-testid="evidence-peak-boundary"]').textContent())?.trim();
    const restoredSamplePeak = (await page.locator('[data-testid="evidence-sample-peak"]').textContent())?.trim();

    expect(restoredGBest).toBe(preExportGBest);
    expect(restoredGTarget).toBe(preExportGTarget);
    expect(restoredDeviation).toBe(preExportDeviation);
    expect(restoredPeakBoundary).toBe(preExportPeakBoundary);
    expect(restoredSamplePeak).toBe(preExportSamplePeak);

    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');
    await expect(constraintsList).toContainText('目标集成响度 T: -20.0 LUFS');

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-journey-05-rebound-restored.png'),
    });
  });

  test('Item 2 (Waveform): direct import external WAV renders complete raw and gained waveforms without placeholder', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize 2.0s 48kHz mono external WAV
    const { wavBytes } = createSineWav(2.0, 1, 48000, 500);
    const wavPath = resolve('.tmp/r1-03-waveform.wav');
    writeFileSync(wavPath, Buffer.from(wavBytes));

    // 2. Direct import external WAV
    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    await directWavInput.setInputFiles(wavPath);

    await expect(evidenceReport).toBeVisible({ timeout: 20000 });

    // 3. Inspect WaveCompare slot
    const waveCompareSlot = page.locator('#slot-wave-compare');
    await expect(waveCompareSlot).toBeVisible();

    // Assert raw waveform SVG path is rendered and non-empty
    const rawPath = waveCompareSlot.locator('[data-testid="waveform-raw-path"]');
    await expect(rawPath).toBeVisible();
    const rawD = await rawPath.getAttribute('d');
    expect(rawD).not.toBeNull();
    expect(rawD).toContain('M 0');
    expect(rawD).toContain('Z');
    expect(rawD!.length).toBeGreaterThan(100);

    // Assert gained waveform SVG path is rendered and non-empty
    const gainedPath = waveCompareSlot.locator('[data-testid="waveform-gained-path"]');
    await expect(gainedPath).toBeVisible();
    const gainedD = await gainedPath.getAttribute('d');
    expect(gainedD).not.toBeNull();
    expect(gainedD).toContain('M 0');
    expect(gainedD).toContain('Z');
    expect(gainedD!.length).toBeGreaterThan(100);

    // Assert placeholder text is strictly not rendered
    const placeholderText = waveCompareSlot.locator('[data-testid="waveform-loading-text"]');
    await expect(placeholderText).not.toBeVisible();

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-wave-01-dual-waveforms-rendered.png'),
    });
  });

  test('Item 3 (Clear Invalidation): clearing report while external analysis is in flight discards delayed RESULT and never backfills', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize heavy 30s stereo WAV (1,440,000 frames) to guarantee non-instant calculation
    const { wavBytes: wavBytes30s } = createSineWav(30.0, 2, 48000, 440);
    const wavPath30s = resolve('.tmp/r1-03-inflight-30s.wav');
    writeFileSync(wavPath30s, Buffer.from(wavBytes30s));

    // Prepare an external session JSON whose loading will clear the report
    const sessionJson = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false,
      source: {
        kind: 'externalWav',
        sha256Hex: '2222222222222222222222222222222222222222222222222222222222222222',
        fileName: 'another-pending.wav',
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
    const sessionPath = resolve('.tmp/r1-03-inflight-session.json');
    writeFileSync(sessionPath, sessionJson);

    // 2. Start external WAV analysis with 30s stereo WAV
    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    await directWavInput.setInputFiles(wavPath30s);

    // Worker is now actively analyzing in the background thread.
    // 3. IMMEDIATELY clear report through the full UI journey by importing session JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(sessionPath);

    // Report is cleared immediately
    const waitingPlaceholder = page.locator('[data-testid="evidence-waiting"]');
    await expect(waitingPlaceholder).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();
    await expect(page.locator('[data-testid="rebind-pending-box"]')).toBeVisible();

    // 4. Wait for any delayed in-flight Worker calculation to finish
    // Dedicated Worker computes 30s stereo in ~1.5-2.0s. Wait 3.5s to ensure message arrives.
    await page.waitForTimeout(3500);

    // 5. Critical assertion: report MUST remain cleared and NEVER backfilled by the delayed RESULT!
    await expect(waitingPlaceholder).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();
    await expect(page.locator('[data-testid="rebind-pending-box"]')).toBeVisible();

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-clear-01-in-flight-invalidated.png'),
    });
  });

  test('Item 4 (Illegal WAV Rejection): importing non-48k, non-PCM16, and corrupted WAV displays explicit Chinese error and never falls back to preset', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    const directWavInput = page.locator('[data-testid="input-direct-wav"]');
    const importErrorBox = page.locator('[data-testid="import-error-box"]');

    // --- Case 4a: Non-48k sample rate (tampered to 44100 Hz) ---
    const { wavBytes: bytesFor48k } = createSineWav(2.0, 1, 48000, 440);
    const non48kBuffer = bytesFor48k.slice(0); // Cloned buffer
    const viewNon48k = new DataView(non48kBuffer);
    viewNon48k.setUint32(24, 44100, true); // Overwrite sampleRate to 44100 Hz
    const non48kPath = resolve('.tmp/r1-03-non48k.wav');
    writeFileSync(non48kPath, Buffer.from(non48kBuffer));

    await directWavInput.setInputFiles(non48kPath);

    // Explicit Chinese error displayed
    await expect(importErrorBox).toBeVisible();
    await expect(importErrorBox).toContainText('直接导入 WAV 失败：不支持的采样率（必须为 48000 Hz）');

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-illegal-01-non-48k-error.png'),
    });

    // --- Case 4b: Non-PCM16 (tampered bitsPerSample to 24-bit, with fresh 48k sample rate) ---
    const { wavBytes: bytesFor16 } = createSineWav(2.0, 1, 48000, 440);
    const non16Buffer = bytesFor16.slice(0); // Fresh cloned buffer
    const viewNon16 = new DataView(non16Buffer);
    viewNon16.setUint16(34, 24, true); // Overwrite bitsPerSample to 24
    const non16Path = resolve('.tmp/r1-03-non16.wav');
    writeFileSync(non16Path, Buffer.from(non16Buffer));

    await directWavInput.setInputFiles(non16Path);

    await expect(importErrorBox).toBeVisible();
    await expect(importErrorBox).toContainText('直接导入 WAV 失败：不支持的量化精度（必须为 16-bit PCM）');

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-illegal-02-non-pcm16-error.png'),
    });

    // --- Case 4c: Corrupted file (truncated / garbage bytes) ---
    const corruptBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const corruptPath = resolve('.tmp/r1-03-corrupt.wav');
    writeFileSync(corruptPath, Buffer.from(corruptBytes));

    await directWavInput.setInputFiles(corruptPath);

    await expect(importErrorBox).toBeVisible();
    await expect(importErrorBox).toContainText('直接导入 WAV 失败：WAV 文件损坏或不是有效的 RIFF WAVE 格式');

    // Confirm that error is visible and report did not fall back or show success
    await expect(page.locator('[data-testid="import-success-box"]')).not.toBeVisible();

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-illegal-03-corrupt-file-error.png'),
    });
  });

  test('Item 5 (Main Thread Responsiveness): main thread slider responsiveness <= 150ms during 30s stereo Worker analysis', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Synthesize 30s stereo WAV (1,440,000 frames)
    const { wavBytes: wavBytes30s, sha256Hex: sha256Hex30s } = createSineWav(30.0, 2, 48000, 440);
    const wavPath30s = resolve('.tmp/r1-03-responsiveness-30s.wav');
    writeFileSync(wavPath30s, Buffer.from(wavBytes30s));

    // Follow FIX-R1-02 method: Prepare session for rebinding
    const sessionJson = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false,
      source: {
        kind: 'externalWav',
        sha256Hex: sha256Hex30s,
        fileName: 'r1-03-responsiveness-30s.wav',
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
    const sessionPath = resolve('.tmp/r1-03-responsiveness-session.json');
    writeFileSync(sessionPath, sessionJson);

    // Import session JSON
    const jsonFileInput = page.locator('[data-testid="input-json-file"]');
    await jsonFileInput.setInputFiles(sessionPath);
    await expect(page.locator('[data-testid="rebind-pending-box"]')).toBeVisible();

    // 2. Upload 30s stereo WAV to start Worker calculation
    const rebindWavInput = page.locator('[data-testid="input-rebind-wav"]');
    await rebindWavInput.setInputFiles(wavPath30s);

    // Wait until Worker calculation is actively running (Worker crunching 30s audio on dedicated thread)
    await expect(page.locator('.status-banner-card.status-analyzing')).toBeVisible({ timeout: 10000 });

    // 3. IMMEDIATELY test main thread interaction latency DURING Worker computation
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

    console.log(
      `[FIX-R1-03-MEASURED-RESPONSIVENESS]: ${measuredLatencyMs.toFixed(2)} ms (contract <= 150ms)`,
    );

    // Main thread response during active worker computation must be <= 150ms
    expect(measuredLatencyMs).toBeLessThanOrEqual(150);

    // 4. Wait for Worker calculation to complete successfully
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText(
      'SHA-256 比对完全一致',
      { timeout: 30000 },
    );
    await expect(evidenceReport).toBeVisible({ timeout: 30000 });
    const constraintsList = page.locator('[data-testid="witness-constraints-list"]');
    await expect(constraintsList).toContainText('声源性质: 外部 WAV 本地分析');

    await page.screenshot({
      path: resolve('evidence/validation-logs/FIX-R1-03-responsiveness-01-mainthread-slider.png'),
    });
  });
});
