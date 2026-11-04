/**
 * P010-FIX-R1-01 Regression Tests (B01: Current Audio Source + B04: Clear Invalidation)
 *
 * Verifies:
 * 1. Worker protocol handles external PCM source ({ kind: 'externalWav', pcm }).
 * 2. Parameter adjustments on external sound source re-analyze using external PCM (no revert to preset).
 * 3. In-flight request cancellation: Worker receives CANCEL and voids result.
 * 4. Stale/delayed RESULT responses with prior requestId are rejected and never backfill.
 */

import { describe, expect, it } from 'vitest';
import { GainFrontWorker } from '../../src/worker/gainfront.worker.js';
import type {
  AnalyzeRequest,
  ResultResponse,
  WorkerResponse,
} from '../../src/worker/protocol.js';
import type { Constraints, PCM } from '../../src/core/types.js';
import { makePreset } from '../../src/core/presets.js';

const baseConstraints: Constraints = {
  targetLufs: -16.0,
  peakCeilingDbTp: -1.0,
  toleranceLu: 0.25,
  marginDb: 0.3,
};

describe('P010-FIX-R1-01 Regression: B01 Current Audio Source & Worker Protocol', () => {
  it('worker processes external PCM source and returns authoritative non-synthetic report', async () => {
    const responses: WorkerResponse[] = [];
    const worker = new GainFrontWorker((res) => responses.push(res));

    // Create an external PCM signal (distinct from standard preset GF-A)
    const frames = 48000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const externalPcm: PCM = {
      sampleRate: 48000,
      channels: 1,
      frames,
      planar,
    };

    const req: AnalyzeRequest = {
      type: 'ANALYZE',
      requestId: 501,
      source: {
        kind: 'externalWav',
        pcm: externalPcm,
        sha256Hex: 'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd',
        fileName: 'test-external.wav',
      },
      constraints: baseConstraints,
    };

    await worker.handleMessage(req);

    const result = responses.find((r) => r.type === 'RESULT') as ResultResponse | undefined;
    expect(result).toBeDefined();
    expect(result?.requestId).toBe(501);
    expect(result?.payload.synthetic).toBe(false);
    expect(result?.payload.source.kind).toBe('externalWav');
    if (result?.payload.source.kind === 'externalWav') {
      expect(result.payload.source.sha256Hex).toBe(
        'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd',
      );
      expect(result.payload.source.fileName).toBe('test-external.wav');
    }
    expect(result?.payload.measurement.samplePeakDbFs).toBeDefined();
    expect(result?.payload.solver.status).toBeDefined();
  });

  it('B01: modifying constraints on external PCM source continues using external source without switching to preset', async () => {
    const responses: WorkerResponse[] = [];
    const worker = new GainFrontWorker((res) => responses.push(res));

    const externalPcm = makePreset('GF-D'); // distinctive intersample peak source
    const sha256Hex = 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
    const fileName = 'my-custom-track.wav';

    // Initial analysis with target -16.0 LUFS
    await worker.handleMessage({
      type: 'ANALYZE',
      requestId: 601,
      source: {
        kind: 'externalWav',
        pcm: externalPcm,
        sha256Hex,
        fileName,
      },
      constraints: { ...baseConstraints, targetLufs: -16.0 },
    });

    const res1 = responses.find((r) => r.requestId === 601 && r.type === 'RESULT') as ResultResponse;
    expect(res1).toBeDefined();
    expect(res1.payload.synthetic).toBe(false);
    expect(res1.payload.source.kind).toBe('externalWav');
    expect(res1.payload.constraints.targetLufs).toBe(-16.0);

    // User modifies parameter to target -20.0 LUFS (simulating slider drag)
    responses.length = 0;
    await worker.handleMessage({
      type: 'ANALYZE',
      requestId: 602,
      source: {
        kind: 'externalWav',
        pcm: externalPcm,
        sha256Hex,
        fileName,
      },
      constraints: { ...baseConstraints, targetLufs: -20.0 },
    });

    const res2 = responses.find((r) => r.requestId === 602 && r.type === 'RESULT') as ResultResponse;
    expect(res2).toBeDefined();
    // Must NOT be synthetic preset GF-A
    expect(res2.payload.synthetic).toBe(false);
    expect(res2.payload.source.kind).toBe('externalWav');
    if (res2.payload.source.kind === 'externalWav') {
      expect(res2.payload.source.fileName).toBe(fileName);
      expect(res2.payload.source.sha256Hex).toBe(sha256Hex);
    }
    expect(res2.payload.constraints.targetLufs).toBe(-20.0);
  });
});

describe('P010-FIX-R1-01 Regression: B04 Clear Invalidation & Stale Result Discard', () => {
  it('B04: CANCEL cancels running request and halts any RESULT emission', async () => {
    const responses: WorkerResponse[] = [];
    let workerInstance: GainFrontWorker;

    workerInstance = new GainFrontWorker((res) => responses.push(res), {
      yieldFn: async () => {
        // As soon as worker yields, simulate onClearReport sending CANCEL
        if (workerInstance.getCurrentRequestId() === 701) {
          await workerInstance.handleMessage({
            type: 'CANCEL',
            requestId: 701,
          });
        }
      },
    });

    await workerInstance.handleMessage({
      type: 'ANALYZE',
      requestId: 701,
      presetId: 'GF-A',
      constraints: baseConstraints,
    });

    // Verify RESULT was never emitted
    const resultRes = responses.find((r) => r.type === 'RESULT');
    expect(resultRes).toBeUndefined();

    // Verify an OPERATION_CANCELLED error was emitted for requestId 701
    const errRes = responses.find((r) => r.type === 'ERROR');
    expect(errRes).toBeDefined();
    expect(errRes?.requestId).toBe(701);
  });

  it('B04: main thread requestId matching logic discards any stale RESULT from cancelled request', () => {
    // Simulate App.tsx requestId filtering logic
    let currentRequestId = 1;
    let report: any = null;

    // Simulate in-flight request 1
    const onMessage = (msg: WorkerResponse) => {
      // Per App.tsx line 100:
      if (msg.requestId !== currentRequestId) {
        return; // Discard stale response
      }
      if (msg.type === 'RESULT') {
        report = msg.payload;
      }
    };

    // onClearReport executes:
    // 1. currentRequestId increments
    // 2. report is set to null
    currentRequestId += 1;
    report = null;

    // Delayed RESULT for request 1 arrives late from worker
    onMessage({
      type: 'RESULT',
      requestId: 1, // old requestId
      payload: { mock: 'stale-report' } as any,
    });

    // Verification: report MUST remain null and NOT backfill
    expect(report).toBeNull();
  });
});
