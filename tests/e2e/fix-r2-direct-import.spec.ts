import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSession } from '../../src/core/session.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import type { PCM } from '../../src/core/types.js';

// FIX-R2-02: direct WAV import must clear the old report at import start
// and invalidate old requests; FIX-R2-01: a real browser import ->
// export -> JSON import -> WAV rebind round-trip must succeed, including
// for a WAV whose real byteLength differs from 44 + frames*channels*2
// (extra RIFF chunks). The extra-chunk file is built by hand below.

function buildWavWithExtraChunks(): Buffer {
  const frames = 48000;
  const channels = 1;
  const dataSize = frames * channels * 2;
  const chunks: Array<{ id: string; data: Buffer }> = [];
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(48000 * channels * 2, 8);
  fmt.writeUInt16LE(channels * 2, 12);
  fmt.writeUInt16LE(16, 14);
  chunks.push({ id: 'JUNK', data: Buffer.alloc(10) });
  chunks.push({ id: 'fmt ', data: fmt });
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < frames; i++) data.writeInt16LE(1000, i * 2);
  chunks.push({ id: 'data', data });
  chunks.push({ id: 'LIST', data: Buffer.from([9, 8, 7, 6, 5]) });
  let total = 0;
  for (const c of chunks) total += 8 + c.data.length + (c.data.length & 1);
  const riffSize = 4 + total;
  const out = Buffer.alloc(8 + riffSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(riffSize, 4);
  out.write('WAVE', 8);
  let offset = 12;
  for (const c of chunks) {
    out.write(c.id, offset);
    out.writeUInt32LE(c.data.length, offset + 4);
    c.data.copy(out, offset + 8);
    offset += 8 + c.data.length;
    if (c.data.length & 1) {
      out[offset] = 0;
      offset += 1;
    }
  }
  return out;
}

function buildLongStereoWav(): Buffer {
  // 30 s stereo: slow enough (~1 s analysis) that the cleared-at-start
  // state is observable before the new report arrives.
  const frames = 48000 * 30;
  const planar = [new Float64Array(frames), new Float64Array(frames)];
  for (let i = 0; i < frames; i++) {
    planar[0][i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    planar[1][i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  const pcm: PCM = { sampleRate: 48000, channels: 2, frames, planar };
  return Buffer.from(encodePcm16Wav(pcm));
}

function buildIllegalWav(): Buffer {
  // 44100 Hz is outside the contract (must be 48000 Hz).
  const frames = 48000;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(44100, 4);
  fmt.writeUInt32LE(88200, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const data = Buffer.alloc(frames * 2);
  const riffSize = 4 + (8 + 16) + (8 + data.length);
  const out = Buffer.alloc(8 + riffSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(riffSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  out.write('data', 36);
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

test.describe('FIX-R2 direct WAV import', () => {
  test('legal direct WAV clears the old report at import start, then shows the new report', async ({ page }) => {
    await page.goto('/');
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    const wavPath = resolve('.tmp/fix-r2-legal-long.wav');
    writeFileSync(wavPath, buildLongStereoWav());

    await page.locator('[data-testid="input-direct-wav"]').setInputFiles(wavPath);
    // Old report must be gone before the new analysis finishes.
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible({ timeout: 5000 });
    await expect(evidenceReport).not.toBeVisible();
    // Then the new report arrives, and it is not the old GF-A report mixed in.
    await expect(evidenceReport).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid="import-success-box"]')).toContainText('成功直接导入外部 WAV');
  });

  test('illegal direct WAV clears the old report and never shows a mixed report', async ({ page }) => {
    await page.goto('/');
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    const wavPath = resolve('.tmp/fix-r2-illegal.wav');
    writeFileSync(wavPath, buildIllegalWav());

    await page.locator('[data-testid="input-direct-wav"]').setInputFiles(wavPath);
    await expect(page.locator('[data-testid="import-error-box"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible();
    await expect(evidenceReport).not.toBeVisible();
    // Still no report after a grace period: no old/new mix.
    await page.waitForTimeout(1500);
    await expect(evidenceReport).not.toBeVisible();
  });

  test('mid-computation switching: preset chosen during a direct import wins, stale external result is discarded', async ({ page }) => {
    await page.goto('/');
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    const wavPath = resolve('.tmp/fix-r2-switch.wav');
    writeFileSync(wavPath, buildLongStereoWav());
    await page.locator('[data-testid="input-direct-wav"]').setInputFiles(wavPath);
    await expect(page.locator('[data-testid="evidence-waiting"]')).toBeVisible({ timeout: 5000 });

    // Switch to GF-B while the external analysis is still in flight.
    await page.locator('button.preset-pill:has-text("GF-B")').click();
    await expect(evidenceReport).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid="evidence-status-badge"]')).toContainText('GAIN_FEASIBLE');
    // Give the stale external result time to arrive; it must be discarded.
    await page.waitForTimeout(2000);
    await expect(page.locator('[data-testid="evidence-status-badge"]')).toContainText('GAIN_FEASIBLE');
  });

  test('real browser import -> export -> JSON import -> WAV rebind round-trip (extra-chunk WAV)', async ({ page }) => {
    await page.goto('/');
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    const wav = buildWavWithExtraChunks();
    const wavPath = resolve('.tmp/fix-r2-extra.wav');
    writeFileSync(wavPath, wav);
    // Sanity: real length really differs from the old guess.
    expect(wav.length).not.toBe(44 + 48000 * 2);

    await page.locator('[data-testid="input-direct-wav"]').setInputFiles(wavPath);
    await expect(evidenceReport).toBeVisible({ timeout: 20000 });

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="btn-export-session"]').click();
    const download = await downloadPromise;
    const exportedPath = resolve('.tmp/fix-r2-export.json');
    await download.saveAs(exportedPath);
    const session = parseSession(readFileSync(exportedPath, 'utf8'));
    expect(session.inputSummary?.byteLength).toBe(wav.length);

    await page.locator('[data-testid="input-json-file"]').setInputFiles(exportedPath);
    await expect(page.locator('[data-testid="rebind-pending-box"]')).toBeVisible({ timeout: 10000 });
    await expect(evidenceReport).not.toBeVisible();

    await page.locator('[data-testid="input-rebind-wav"]').setInputFiles(wavPath);
    await expect(evidenceReport).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid="rebind-error-box"]')).not.toBeVisible();
  });
});
