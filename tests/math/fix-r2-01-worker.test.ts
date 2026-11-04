/**
 * FIX-R2-01 worker follow-up (independent review): the worker wavBytes
 * path must carry the real byteLength of an extra-chunk WAV, and when
 * a valid SHA is supplied alongside the bytes, the resulting report
 * must be exportable and rebindable with that same file.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { GainFrontWorker } from '../../src/worker/gainfront.worker.js';
import type { ResultResponse, WorkerResponse } from '../../src/worker/protocol.js';
import { createSessionFromAnalysis, exportSession, parseSession, rebindExternalWav } from '../../src/core/session.js';
import type { Constraints } from '../../src/core/types.js';

const CONSTRAINTS: Constraints = { targetLufs: -16.0, peakCeilingDbTp: -1.0, toleranceLu: 0.25, marginDb: 0.3 };

function buildExtraChunkWav(): ArrayBuffer {
  const frames = 48000;
  const data = new Uint8Array(frames * 2);
  const dv = new DataView(data.buffer);
  for (let i = 0; i < frames; i++) dv.setInt16(i * 2, 1000, true);
  const chunks: Array<{ id: string; data: Uint8Array }> = [];
  const fmt = new Uint8Array(16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, 1, true);
  fv.setUint16(2, 1, true);
  fv.setUint32(4, 48000, true);
  fv.setUint32(8, 96000, true);
  fv.setUint16(12, 2, true);
  fv.setUint16(14, 16, true);
  chunks.push({ id: 'JUNK', data: new Uint8Array(10) });
  chunks.push({ id: 'fmt ', data: fmt });
  chunks.push({ id: 'data', data });
  chunks.push({ id: 'LIST', data: new Uint8Array([1, 2, 3, 4, 5]) });
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

describe('FIX-R2-01 worker wavBytes byteLength', () => {
  it('RESULT.source.byteLength equals the real extra-chunk WAV length, and the report exports/rebinds', async () => {
    const wavBytes = buildExtraChunkWav();
    const guessed = 44 + 48000 * 2;
    expect(wavBytes.byteLength).not.toBe(guessed);
    const sha256Hex = createHash('sha256').update(new Uint8Array(wavBytes)).digest('hex');

    const responses: WorkerResponse[] = [];
    const worker = new GainFrontWorker((res) => responses.push(res));
    await worker.handleMessage({
      type: 'ANALYZE',
      requestId: 201,
      wavBytes,
      sha256Hex,
      fileName: 'extra.wav',
      constraints: CONSTRAINTS,
    });
    const last = responses[responses.length - 1] as ResultResponse;
    expect(last.type).toBe('RESULT');
    expect(last.payload.source.kind).toBe('externalWav');
    if (last.payload.source.kind === 'externalWav') {
      expect(last.payload.source.byteLength).toBe(wavBytes.byteLength);
      expect(last.payload.source.sha256Hex).toBe(sha256Hex);
    }

    const session = createSessionFromAnalysis(last.payload);
    expect(session.inputSummary?.byteLength).toBe(wavBytes.byteLength);
    const parsed = parseSession(exportSession(session, { pretty: true }));
    const result = rebindExternalWav(parsed, wavBytes, { fileName: 'extra.wav' });
    expect(result.verifiedSha256Hex).toBe(sha256Hex);
  });
});
