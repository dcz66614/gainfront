/**
 * Tests for RIFF PCM16 WAV Decoder and Encoder (P010-T003)
 *
 * Covers:
 * - MATH02: Handcrafted 2-channel PCM16 sample decoding and channel alignment
 * - Deterministic SHA-256 frame hashing
 * - Comprehensive format violation rejections (UNSUPPORTED_WAV and OUT_OF_SCOPE)
 * - Handling of arbitrary non-critical chunks, odd padding, and chunk ordering
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodePcm16Wav, encodePcm16Wav } from '../../src/core/wav.js';
import { isGainFrontError } from '../../src/core/errors.js';
import type { PCM } from '../../src/core/types.js';

/**
 * Helper to construct a raw RIFF WAV ArrayBuffer with custom chunk entries.
 */
function buildCustomWav(options: {
  riffId?: string;
  riffSize?: number;
  waveId?: string;
  chunks: Array<{ id: string; data: Uint8Array }>;
}): ArrayBuffer {
  let chunksTotalLength = 0;
  for (const c of options.chunks) {
    const pad = c.data.length & 1;
    chunksTotalLength += 8 + c.data.length + pad;
  }

  const calculatedRiffSize = 4 + chunksTotalLength;
  const riffSize = options.riffSize !== undefined ? options.riffSize : calculatedRiffSize;
  const totalLength = 8 + calculatedRiffSize;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // Write 4-byte RIFF ID
  const rId = options.riffId ?? 'RIFF';
  for (let i = 0; i < 4; i++) u8[i] = rId.charCodeAt(i);

  // Write RIFF size
  view.setUint32(4, riffSize, true);

  // Write 4-byte WAVE ID
  const wId = options.waveId ?? 'WAVE';
  for (let i = 0; i < 4; i++) u8[8 + i] = wId.charCodeAt(i);

  // Write chunks
  let offset = 12;
  for (const c of options.chunks) {
    for (let i = 0; i < 4; i++) u8[offset + i] = c.id.charCodeAt(i);
    view.setUint32(offset + 4, c.data.length, true);
    u8.set(c.data, offset + 8);
    offset += 8 + c.data.length;
    if (c.data.length & 1) {
      u8[offset] = 0; // pad byte
      offset += 1;
    }
  }

  return buffer;
}

/**
 * Helper to build standard 16-byte PCM 'fmt ' chunk data.
 */
function buildFmtChunkData(opts?: {
  audioFormat?: number;
  channels?: number;
  sampleRate?: number;
  byteRate?: number;
  blockAlign?: number;
  bitsPerSample?: number;
}): Uint8Array {
  const audioFormat = opts?.audioFormat ?? 1;
  const channels = opts?.channels ?? 2;
  const sampleRate = opts?.sampleRate ?? 48000;
  const bitsPerSample = opts?.bitsPerSample ?? 16;
  const blockAlign = opts?.blockAlign ?? channels * (bitsPerSample / 8);
  const byteRate = opts?.byteRate ?? sampleRate * blockAlign;

  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint16(0, audioFormat, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, byteRate, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);
  return data;
}

describe('P010-T003 RIFF PCM16 WAV Decoder & MATH02', () => {
  it('MATH02: decodes handcrafted 2-channel samples [-32768, -1, 0, 32767] with exact float equality and channel alignment', () => {
    // 48000 frames (1.0s), 2 channels, 16-bit PCM.
    // Frame 0: Ch0 = -32768, Ch1 = -1
    // Frame 1: Ch0 = 0,      Ch1 = 32767
    // Remaining 47998 frames: zeros
    const frames = 48000;
    const channels = 2;
    const blockAlign = channels * 2; // 4 bytes per frame
    const dataBytes = new Uint8Array(frames * blockAlign);
    const dataView = new DataView(dataBytes.buffer);

    // Frame 0: [-32768, -1]
    dataView.setInt16(0, -32768, true); // Ch0, sample 0
    dataView.setInt16(2, -1, true);      // Ch1, sample 0

    // Frame 1: [0, 32767]
    dataView.setInt16(4, 0, true);       // Ch0, sample 1
    dataView.setInt16(6, 32767, true);   // Ch1, sample 1

    const wavBuffer = buildCustomWav({
      chunks: [
        { id: 'fmt ', data: buildFmtChunkData({ channels: 2 }) },
        { id: 'data', data: dataBytes },
      ],
    });

    const decoded = decodePcm16Wav(wavBuffer);

    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channels).toBe(2);
    expect(decoded.frames).toBe(48000);
    expect(decoded.planar.length).toBe(2);

    // MATH02 exact mathematical Float64 requirements:
    // [-32768, -1, 0, 32767] -> [-1, -1/32768, 0, 32767/32768]
    expect(decoded.planar[0][0]).toBe(-1);
    expect(decoded.planar[1][0]).toBe(-1 / 32768);
    expect(decoded.planar[0][1]).toBe(0);
    expect(decoded.planar[1][1]).toBe(32767 / 32768);

    // Subsequent padded samples are exact zero
    expect(decoded.planar[0][2]).toBe(0);
    expect(decoded.planar[1][2]).toBe(0);
  });

  it('computes deterministic SHA-256 for a fixed decoded buffer', () => {
    const frames = 48000;
    const monoData = new Uint8Array(frames * 2);
    const view = new DataView(monoData.buffer);
    // Fill with predictable ramp
    for (let i = 0; i < frames; i++) {
      view.setInt16(i * 2, (i % 65536) - 32768, true);
    }

    const wavBuffer = buildCustomWav({
      chunks: [
        { id: 'fmt ', data: buildFmtChunkData({ channels: 1 }) },
        { id: 'data', data: monoData },
      ],
    });

    const decoded = decodePcm16Wav(wavBuffer);
    const hash = createHash('sha256')
      .update(Buffer.from(decoded.planar[0].buffer))
      .digest('hex');

    // Deterministic hash verification
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const secondDecoded = decodePcm16Wav(wavBuffer);
    const secondHash = createHash('sha256')
      .update(Buffer.from(secondDecoded.planar[0].buffer))
      .digest('hex');
    expect(hash).toBe(secondHash);
  });

  it('successfully round-trips PCM via encodePcm16Wav and decodePcm16Wav', () => {
    const frames = 48000;
    const pcm: PCM = {
      sampleRate: 48000,
      channels: 2,
      frames,
      planar: [new Float64Array(frames), new Float64Array(frames)],
    };

    // Populate with arbitrary float samples in [-1.0, 1.0]
    pcm.planar[0][0] = -1.0;
    pcm.planar[1][0] = -0.5;
    pcm.planar[0][1] = 0.0;
    pcm.planar[1][1] = 0.5;
    pcm.planar[0][2] = 32767 / 32768;

    const encoded = encodePcm16Wav(pcm);
    const decoded = decodePcm16Wav(encoded);

    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.channels).toBe(2);
    expect(decoded.frames).toBe(frames);
    expect(decoded.planar[0][0]).toBe(-1.0);
    expect(decoded.planar[1][0]).toBeCloseTo(-0.5, 4);
    expect(decoded.planar[0][1]).toBe(0.0);
    expect(decoded.planar[1][1]).toBeCloseTo(0.5, 4);
    expect(decoded.planar[0][2]).toBe(32767 / 32768);
  });

  it('supports arbitrary non-critical chunks, odd byte padding, and chunk reordering', () => {
    const frames = 48000;
    const dataBytes = new Uint8Array(frames * 2);

    // Create an odd-length 'JUNK' chunk (5 bytes) + odd padding
    const junkData = new Uint8Array([1, 2, 3, 4, 5]);

    // Place data BEFORE fmt chunk, with JUNK before data
    const wavBuffer = buildCustomWav({
      chunks: [
        { id: 'JUNK', data: junkData },
        { id: 'data', data: dataBytes },
        { id: 'fmt ', data: buildFmtChunkData({ channels: 1 }) },
      ],
    });

    const decoded = decodePcm16Wav(wavBuffer);
    expect(decoded.channels).toBe(1);
    expect(decoded.frames).toBe(frames);
  });
});

describe('P010-T003 Strict WAV Error Rejections', () => {
  const validFmtData = buildFmtChunkData({ channels: 1 });
  const validDataBytes = new Uint8Array(48000 * 2);

  it('rejects non-ArrayBuffer input with UNSUPPORTED_WAV', () => {
    expect(() => decodePcm16Wav(null as unknown as ArrayBuffer)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
    expect(() => decodePcm16Wav('not a buffer' as unknown as ArrayBuffer)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects empty or zero-length buffer with UNSUPPORTED_WAV', () => {
    expect(() => decodePcm16Wav(new ArrayBuffer(0))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects files > 8 MiB with OUT_OF_SCOPE', () => {
    // 8 MiB + 1 byte
    const oversized = new ArrayBuffer(8 * 1024 * 1024 + 1);
    expect(() => decodePcm16Wav(oversized)).toThrowError(
      expect.objectContaining({ code: 'OUT_OF_SCOPE' }),
    );
  });

  it('rejects non-RIFF container header with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      riffId: 'FORM',
      chunks: [{ id: 'fmt ', data: validFmtData }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects non-WAVE format header with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      waveId: 'AIFF',
      chunks: [{ id: 'fmt ', data: validFmtData }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects truncated RIFF container with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      riffSize: 999999, // Claims larger size than actual buffer
      chunks: [{ id: 'fmt ', data: validFmtData }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects buffer with trailing garbage beyond declared RIFF size with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      riffSize: 100, // Buffer has full size, but RIFF declares only 100
      chunks: [{ id: 'fmt ', data: validFmtData }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects non-PCM audioFormat (e.g. format 3 = IEEE float) with UNSUPPORTED_WAV', () => {
    const fmt = buildFmtChunkData({ audioFormat: 3, channels: 1 });
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: fmt }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects non-supported channel count (e.g. 3 channels) with UNSUPPORTED_WAV', () => {
    const fmt = buildFmtChunkData({ channels: 3 });
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: fmt }, { id: 'data', data: new Uint8Array(48000 * 6) }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects non-48000 Hz sample rate (e.g. 44100 Hz) with UNSUPPORTED_WAV', () => {
    const fmt = buildFmtChunkData({ sampleRate: 44100, channels: 1 });
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: fmt }, { id: 'data', data: new Uint8Array(44100 * 2) }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects non-16-bit depth (e.g. 24-bit PCM) with UNSUPPORTED_WAV', () => {
    const fmt = buildFmtChunkData({ bitsPerSample: 24, channels: 1 });
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: fmt }, { id: 'data', data: new Uint8Array(48000 * 3) }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects mismatched blockAlign with UNSUPPORTED_WAV', () => {
    const fmt = buildFmtChunkData({ blockAlign: 4, channels: 1, bitsPerSample: 16 });
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: fmt }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects mismatched byteRate with UNSUPPORTED_WAV', () => {
    const fmt = buildFmtChunkData({ byteRate: 12345, channels: 1 });
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: fmt }, { id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects duplicate fmt chunks with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      chunks: [
        { id: 'fmt ', data: validFmtData },
        { id: 'fmt ', data: validFmtData },
        { id: 'data', data: validDataBytes },
      ],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects duplicate data chunks with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      chunks: [
        { id: 'fmt ', data: validFmtData },
        { id: 'data', data: validDataBytes },
        { id: 'data', data: validDataBytes },
      ],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects missing fmt chunk with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      chunks: [{ id: 'data', data: validDataBytes }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects missing data chunk with UNSUPPORTED_WAV', () => {
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: validFmtData }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects unaligned data chunk size with UNSUPPORTED_WAV', () => {
    // 2-channel 16-bit requires multiple of 4 bytes. Provide 48001 bytes.
    const unalignedData = new Uint8Array(48000 * 4 + 1);
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: buildFmtChunkData({ channels: 2 }) }, { id: 'data', data: unalignedData }],
    });
    expect(() => decodePcm16Wav(wav)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_WAV' }),
    );
  });

  it('rejects duration < 1.0s (e.g. 2 frames or 47999 frames) with OUT_OF_SCOPE', () => {
    // 2 frames
    const shortData = new Uint8Array(2 * 2);
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: validFmtData }, { id: 'data', data: shortData }],
    });
    try {
      decodePcm16Wav(wav);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('OUT_OF_SCOPE');
      }
    }
  });

  it('rejects duration > 30.0s (e.g. 1,440,001 frames) with OUT_OF_SCOPE', () => {
    // 1,440,001 frames * 2 bytes = 2,880,002 bytes (fits under 8MiB)
    const longFrames = 1440001;
    const longData = new Uint8Array(longFrames * 2);
    const wav = buildCustomWav({
      chunks: [{ id: 'fmt ', data: validFmtData }, { id: 'data', data: longData }],
    });
    try {
      decodePcm16Wav(wav);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('OUT_OF_SCOPE');
      }
    }
  });
});
