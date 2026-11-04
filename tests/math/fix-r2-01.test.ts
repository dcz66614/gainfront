/**
 * FIX-R2-01 golden tests: real WAV byteLength persistence.
 *
 * A legal RIFF WAV may carry extra chunks (JUNK/LIST/bext), an extended
 * fmt chunk, or odd-size padding, so its real byteLength is NOT
 * 44 + frames*channels*2. Before the fix, createSessionFromAnalysis()
 * guessed that value, and a later rebind of the very same file failed
 * with a byteLength mismatch. After the fix, the real byteLength is
 * carried on report.source.byteLength from the actual bytes, through
 * export, and rebind must succeed with the identical file.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeSource } from '../../src/core/analyze.js';
import {
  computeSha256Sync,
  createSessionFromAnalysis,
  exportSession,
  parseSession,
  rebindExternalWav,
} from '../../src/core/session.js';
import { decodePcm16Wav } from '../../src/core/wav.js';
import type { Constraints } from '../../src/core/types.js';

function buildCustomWav(chunks: Array<{ id: string; data: Uint8Array }>): ArrayBuffer {
  let chunksTotal = 0;
  for (const c of chunks) chunksTotal += 8 + c.data.length + (c.data.length & 1);
  const riffSize = 4 + chunksTotal;
  const buffer = new ArrayBuffer(8 + riffSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  for (let i = 0; i < 4; i++) u8[i] = 'RIFF'.charCodeAt(i);
  view.setUint32(4, riffSize, true);
  for (let i = 0; i < 4; i++) u8[8 + i] = 'WAVE'.charCodeAt(i);
  let offset = 12;
  for (const c of chunks) {
    for (let i = 0; i < 4; i++) u8[offset + i] = c.id.charCodeAt(i);
    view.setUint32(offset + 4, c.data.length, true);
    u8.set(c.data, offset + 8);
    offset += 8 + c.data.length;
    if (c.data.length & 1) {
      u8[offset] = 0;
      offset += 1;
    }
  }
  return buffer;
}

function buildFmt(channels: number): Uint8Array {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, 48000, true);
  view.setUint32(8, 48000 * channels * 2, true);
  view.setUint16(12, channels * 2, true);
  view.setUint16(14, 16, true);
  return data;
}

const CONSTRAINTS: Constraints = {
  targetLufs: -16.0,
  peakCeilingDbTp: -1.0,
  toleranceLu: 0.25,
  marginDb: 0.3,
};

function makeExtraChunkWav(): ArrayBuffer {
  const frames = 48000;
  const dataBytes = new Uint8Array(frames * 2); // mono, 16-bit
  const dv = new DataView(dataBytes.buffer);
  for (let i = 0; i < frames; i++) dv.setInt16(i * 2, Math.round(0.2 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / 48000)), true);
  return buildCustomWav([
    { id: 'JUNK', data: new Uint8Array(10) },
    { id: 'fmt ', data: buildFmt(1) },
    { id: 'data', data: dataBytes },
    { id: 'LIST', data: new Uint8Array([1, 2, 3, 4, 5]) }, // odd size -> pad byte
  ]);
}

describe('FIX-R2-01 real byteLength persistence', () => {
  it('golden: extra-chunk WAV byteLength is carried, not guessed, through export and rebind', () => {
    const wavBytes = makeExtraChunkWav();
    const guessed = 44 + 48000 * 1 * 2;
    expect(wavBytes.byteLength).not.toBe(guessed);
    expect(wavBytes.byteLength).toBeGreaterThan(guessed);

    const pcm = decodePcm16Wav(wavBytes);
    expect(pcm.frames).toBe(48000);

    const sha256Hex = createHash('sha256').update(new Uint8Array(wavBytes)).digest('hex');
    const report = analyzeSource({ wavBytes, constraints: CONSTRAINTS, sha256Hex });
    expect(report.source.kind).toBe('externalWav');
    if (report.source.kind === 'externalWav') {
      expect(report.source.byteLength).toBe(wavBytes.byteLength);
    }

    // No explicit byteLength option: the fix must still use the real value.
    const session = createSessionFromAnalysis(report);
    expect(session.inputSummary?.byteLength).toBe(wavBytes.byteLength);
    expect(session.inputSummary?.byteLength).not.toBe(guessed);

    const json = exportSession(session, { pretty: true });
    const parsed = parseSession(json);
    expect(parsed.inputSummary?.byteLength).toBe(wavBytes.byteLength);

    // Rebind with the identical file must succeed (this failed pre-fix).
    const result = rebindExternalWav(parsed, wavBytes, { fileName: parsed.source.kind === 'externalWav' ? parsed.source.fileName : undefined });
    expect(result.verifiedSha256Hex).toBe(sha256Hex);
    expect(result.report.source.kind).toBe('externalWav');
  });

  it('golden: a tampered-length file still fails rebind (byteLength is checked, not ignored)', () => {
    const wavBytes = makeExtraChunkWav();
    const sha256Hex = computeSha256Sync(wavBytes);
    const report = analyzeSource({ wavBytes, constraints: CONSTRAINTS, sha256Hex });
    const session = createSessionFromAnalysis(report);
    // Same audio, different container: append a legal extra chunk.
    const longer = makeExtraChunkWav();
    // Re-encoding the same samples without extra chunks gives a different
    // length and a different SHA, so rebind must reject it on SHA/length.
    const plain = (() => {
      const frames = 48000;
      const dataBytes = new Uint8Array(frames * 2);
      return buildCustomWav([
        { id: 'fmt ', data: buildFmt(1) },
        { id: 'data', data: dataBytes },
      ]);
    })();
    expect(plain.byteLength).not.toBe(wavBytes.byteLength);
    expect(() => rebindExternalWav(session, plain, { fileName: session.source.kind === 'externalWav' ? session.source.fileName : undefined })).toThrow();
    expect(longer.byteLength).toBe(wavBytes.byteLength);
  });
});
