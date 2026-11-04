/**
 * FIX-R2-01 (UI helpers) + FIX-R2-02 contract helpers:
 * - validateAndDecodeDirectWav / verifyExternalWavForRebind return the
 *   real WAV byteLength, so the worker/App chain never falls back to
 *   the 44 + frames*channels*2 guess for extra-chunk files.
 * - handleExportSession round-trips that real byteLength, and a
 *   rebind of the identical file succeeds.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  handleExportSession,
  validateAndDecodeDirectWav,
  verifyExternalWavForRebind,
} from '../../src/ui/ImportExport.js';
import { analyzeSource } from '../../src/core/analyze.js';
import { parseSession, rebindExternalWav } from '../../src/core/session.js';
import type { Constraints } from '../../src/core/types.js';

function buildCustomWav(chunks: Array<{ id: string; data: Uint8Array }>): ArrayBuffer {
  let total = 0;
  for (const c of chunks) total += 8 + c.data.length + (c.data.length & 1);
  const riffSize = 4 + total;
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

function buildFmt(): Uint8Array {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, 48000, true);
  view.setUint32(8, 96000, true);
  view.setUint16(12, 2, true);
  view.setUint16(14, 16, true);
  return data;
}

const CONSTRAINTS: Constraints = { targetLufs: -16.0, peakCeilingDbTp: -1.0, toleranceLu: 0.25, marginDb: 0.3 };

function makeWav(): ArrayBuffer {
  const frames = 48000;
  const dataBytes = new Uint8Array(frames * 2);
  const dv = new DataView(dataBytes.buffer);
  for (let i = 0; i < frames; i++) dv.setInt16(i * 2, 1000, true);
  return buildCustomWav([
    { id: 'JUNK', data: new Uint8Array(10) },
    { id: 'fmt ', data: buildFmt() },
    { id: 'data', data: dataBytes },
    { id: 'LIST', data: new Uint8Array([9, 8, 7, 6, 5]) },
  ]);
}

describe('FIX-R2-01 UI byteLength helpers', () => {
  it('validateAndDecodeDirectWav returns the real byteLength', () => {
    const wav = makeWav();
    const { byteLength, sha256Hex } = validateAndDecodeDirectWav(wav, 'extra.wav');
    expect(byteLength).toBe(wav.byteLength);
    expect(byteLength).not.toBe(44 + 48000 * 2);
    expect(sha256Hex).toBe(createHash('sha256').update(new Uint8Array(wav)).digest('hex'));
  });

  it('export -> parse -> rebind round-trips the real byteLength for an extra-chunk WAV', () => {
    const wav = makeWav();
    const sha256Hex = createHash('sha256').update(new Uint8Array(wav)).digest('hex');
    const report = analyzeSource({ wavBytes: wav, constraints: CONSTRAINTS, sha256Hex });
    const json = handleExportSession(report);
    const session = parseSession(json);
    expect(session.inputSummary?.byteLength).toBe(wav.byteLength);

    const verified = verifyExternalWavForRebind(session, wav, session.source.kind === 'externalWav' ? session.source.fileName : undefined);
    expect(verified.byteLength).toBe(wav.byteLength);

    const result = rebindExternalWav(session, wav, { fileName: session.source.kind === 'externalWav' ? session.source.fileName : undefined });
    expect(result.verifiedSha256Hex).toBe(sha256Hex);
  });
});
