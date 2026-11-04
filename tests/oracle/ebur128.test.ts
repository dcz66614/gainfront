/**
 * Independent Oracle Test: FFmpeg 8.1.2 ebur128 Loudness Verification (P010-T008)
 *
 * Requirements:
 * - MATH03: GF-B integrated loudness within ±0.20 LU of FFmpeg ebur128.
 * - GF-C stereo identical channel integrated loudness within ±0.20 LU of FFmpeg ebur128.
 * - GF-A peak trap signal integrated loudness verified and reported against FFmpeg ebur128.
 * - Independent signal synthesis: Must generate sine waves and WAV files independently.
 *   DO NOT import presets.ts.
 * - Under-test: Use worker's decodePcm16Wav and measure() from src/core/.
 * - Reference: Local FFmpeg 8.1.2 ebur128 filter with framelog=verbose.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measure } from '../../src/core/gain.js';
import { decodePcm16Wav } from '../../src/core/wav.js';

const SAMPLE_RATE = 48000;
const DURATION_SEC = 8;
const TOTAL_FRAMES = DURATION_SEC * SAMPLE_RATE; // 384,000 frames
const TMP_DIR = join(process.cwd(), 'tests', 'oracle', '.tmp');

/**
 * Independent RIFF PCM16 WAV encoder.
 * Writes a valid 44-byte RIFF WAVE header followed by 16-bit little-endian samples.
 */
function encodeIndependentWav(planar: Float64Array[], sampleRate = SAMPLE_RATE): ArrayBuffer {
  const channels = planar.length;
  const frames = planar[0].length;
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  const totalSize = 44 + dataSize;

  const ab = new ArrayBuffer(totalSize);
  const view = new DataView(ab);

  // 'RIFF' chunk descriptor
  view.setUint8(0, 0x52); // 'R'
  view.setUint8(1, 0x49); // 'I'
  view.setUint8(2, 0x46); // 'F'
  view.setUint8(3, 0x46); // 'F'
  view.setUint32(4, 36 + dataSize, true);

  // 'WAVE' format
  view.setUint8(8, 0x57);  // 'W'
  view.setUint8(9, 0x41);  // 'A'
  view.setUint8(10, 0x56); // 'V'
  view.setUint8(11, 0x45); // 'E'

  // 'fmt ' sub-chunk
  view.setUint8(12, 0x66); // 'f'
  view.setUint8(13, 0x6d); // 'm'
  view.setUint8(14, 0x74); // 't'
  view.setUint8(15, 0x20); // ' '
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true);  // AudioFormat 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample = 16

  // 'data' sub-chunk
  view.setUint8(36, 0x64); // 'd'
  view.setUint8(37, 0x61); // 'a'
  view.setUint8(38, 0x74); // 't'
  view.setUint8(39, 0x61); // 'a'
  view.setUint32(40, dataSize, true);

  const clampInt16 = (v: number): number => {
    const s = Math.round(v * 32768);
    return Math.max(-32768, Math.min(32767, s));
  };

  let offset = 44;
  if (channels === 1) {
    const ch0 = planar[0];
    for (let i = 0; i < frames; i++) {
      view.setInt16(offset, clampInt16(ch0[i]), true);
      offset += 2;
    }
  } else {
    const ch0 = planar[0];
    const ch1 = planar[1];
    for (let i = 0; i < frames; i++) {
      view.setInt16(offset, clampInt16(ch0[i]), true);
      view.setInt16(offset + 2, clampInt16(ch1[i]), true);
      offset += 4;
    }
  }

  return ab;
}

/**
 * Independent signal generator for GF-B (safe gain, mono 1000Hz sine).
 * Formula: x[n] = 0.10 * sin(2π * 1000 * n / 48000)
 */
function synthesizeGfB(): Float64Array[] {
  const ch = new Float64Array(TOTAL_FRAMES);
  const omega = (2 * Math.PI * 1000) / SAMPLE_RATE;
  for (let n = 0; n < TOTAL_FRAMES; n++) {
    ch[n] = 0.10 * Math.sin(omega * n);
  }
  return [ch];
}

/**
 * Independent signal generator for GF-C (stereo energy, two identical channels).
 * Formula: identical to GF-B on both channels.
 */
function synthesizeGfC(): Float64Array[] {
  const ch0 = new Float64Array(TOTAL_FRAMES);
  const ch1 = new Float64Array(TOTAL_FRAMES);
  const omega = (2 * Math.PI * 1000) / SAMPLE_RATE;
  for (let n = 0; n < TOTAL_FRAMES; n++) {
    const val = 0.10 * Math.sin(omega * n);
    ch0[n] = val;
    ch1[n] = val;
  }
  return [ch0, ch1];
}

/**
 * Independent signal generator for GF-A (peak trap, mono 1000Hz sine with single pulse).
 * Formula: x[n] = 0.10 * sin(2π * 1000 * n / 48000), overwritten at n=192000 to 0.80.
 */
function synthesizeGfA(): Float64Array[] {
  const ch = new Float64Array(TOTAL_FRAMES);
  const omega = (2 * Math.PI * 1000) / SAMPLE_RATE;
  for (let n = 0; n < TOTAL_FRAMES; n++) {
    ch[n] = 0.10 * Math.sin(omega * n);
  }
  ch[192000] = 0.80; // 4 seconds * 48000
  return [ch];
}

export interface FfmpegLoudnessResult {
  integratedLufs: number;
  rawOutput: string;
}

/**
 * Invokes local FFmpeg 8.1.2 ebur128 filter and parses summary.
 */
function runFfmpegEbur128(wavPath: string): FfmpegLoudnessResult {
  const env = { ...process.env, TMPDIR: TMP_DIR };
  const proc = spawnSync(
    'ffmpeg',
    ['-nostats', '-i', wavPath, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'],
    {
      encoding: 'utf8',
      env,
    },
  );

  const rawOutput = (proc.stdout ?? '') + '\n' + (proc.stderr ?? '');
  if (proc.status !== 0) {
    throw new Error(`FFmpeg exited with code ${proc.status}:\n${rawOutput}`);
  }

  // Parse Integrated loudness:
  //   Integrated loudness:
  //     I:         -23.0 LUFS
  const match = /Integrated loudness:\s+I:\s+([-\d.]+)\s+LUFS/.exec(rawOutput);
  if (!match) {
    throw new Error(`Failed to parse Integrated loudness from FFmpeg output:\n${rawOutput}`);
  }

  const integratedLufs = parseFloat(match[1]);
  return { integratedLufs, rawOutput };
}

describe('P010-T008 Independent Oracle: FFmpeg 8.1.2 ebur128 vs Worker measure()', () => {
  beforeAll(() => {
    if (!existsSync(TMP_DIR)) {
      mkdirSync(TMP_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    try {
      if (existsSync(TMP_DIR)) {
        rmSync(TMP_DIR, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it('verifies FFmpeg binary is version 8.1.2', () => {
    const versionOutput = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    expect(versionOutput).toContain('ffmpeg version 8.1.2');
  });

  it('MATH03: GF-B integrated loudness matches FFmpeg within ±0.20 LU', () => {
    // 1. Independent signal synthesis and WAV generation
    const planar = synthesizeGfB();
    const wavAb = encodeIndependentWav(planar);
    const wavPath = join(TMP_DIR, 'oracle-GF-B.wav');
    writeFileSync(wavPath, Buffer.from(wavAb));

    // 2. FFmpeg 8.1.2 reference measurement
    const ffmpegRes = runFfmpegEbur128(wavPath);
    expect(ffmpegRes.integratedLufs).toBeDefined();

    // 3. Worker under test: decodePcm16Wav + measure()
    const pcm = decodePcm16Wav(wavAb);
    const workerRes = measure(pcm);
    expect(workerRes.integratedLufs).not.toBeNull();

    const diff = Math.abs(workerRes.integratedLufs! - ffmpegRes.integratedLufs);
    console.log(`[MATH03 GF-B] Worker: ${workerRes.integratedLufs!.toFixed(4)} LUFS, FFmpeg: ${ffmpegRes.integratedLufs.toFixed(4)} LUFS, Diff: ${diff.toFixed(4)} LU`);

    expect(diff).toBeLessThanOrEqual(0.20);
  });

  it('GF-C (stereo energy): integrated loudness matches FFmpeg within ±0.20 LU', () => {
    // 1. Independent signal synthesis and WAV generation
    const planar = synthesizeGfC();
    const wavAb = encodeIndependentWav(planar);
    const wavPath = join(TMP_DIR, 'oracle-GF-C.wav');
    writeFileSync(wavPath, Buffer.from(wavAb));

    // 2. FFmpeg 8.1.2 reference measurement
    const ffmpegRes = runFfmpegEbur128(wavPath);
    expect(ffmpegRes.integratedLufs).toBeDefined();

    // 3. Worker under test: decodePcm16Wav + measure()
    const pcm = decodePcm16Wav(wavAb);
    const workerRes = measure(pcm);
    expect(workerRes.integratedLufs).not.toBeNull();

    const diff = Math.abs(workerRes.integratedLufs! - ffmpegRes.integratedLufs);
    console.log(`[MATH03 GF-C] Worker: ${workerRes.integratedLufs!.toFixed(4)} LUFS, FFmpeg: ${ffmpegRes.integratedLufs.toFixed(4)} LUFS, Diff: ${diff.toFixed(4)} LU`);

    expect(diff).toBeLessThanOrEqual(0.20);
  });

  it('GF-A (peak trap): integrated loudness matches FFmpeg within ±0.20 LU', () => {
    // 1. Independent signal synthesis and WAV generation
    const planar = synthesizeGfA();
    const wavAb = encodeIndependentWav(planar);
    const wavPath = join(TMP_DIR, 'oracle-GF-A.wav');
    writeFileSync(wavPath, Buffer.from(wavAb));

    // 2. FFmpeg 8.1.2 reference measurement
    const ffmpegRes = runFfmpegEbur128(wavPath);
    expect(ffmpegRes.integratedLufs).toBeDefined();

    // 3. Worker under test: decodePcm16Wav + measure()
    const pcm = decodePcm16Wav(wavAb);
    const workerRes = measure(pcm);
    expect(workerRes.integratedLufs).not.toBeNull();

    const diff = Math.abs(workerRes.integratedLufs! - ffmpegRes.integratedLufs);
    console.log(`[MATH03 GF-A] Worker: ${workerRes.integratedLufs!.toFixed(4)} LUFS, FFmpeg: ${ffmpegRes.integratedLufs.toFixed(4)} LUFS, Diff: ${diff.toFixed(4)} LU`);

    expect(diff).toBeLessThanOrEqual(0.20);
  });
});
