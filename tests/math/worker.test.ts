/**
 * Tests for Dedicated Worker Protocol and State Machine (P010-T010)
 *
 * Covers:
 * - Worker contract verification per PROJECT_BOOK.md §8.3 & P010-T010
 * - Protocol state machine: ANALYZE -> PROGRESS -> RESULT / ERROR
 * - Strict requestId validation on inputs and outputs
 * - Cancellation contract: CANCEL only cancels matching requestId, does not kill other requests
 * - Latest request wins: new ANALYZE immediately voids previous uncompleted requests (no subsequent messages)
 * - 40s timeout ceiling: ERROR ('WORKER_ERROR') emitted on timeout, no hanging
 * - 100ms PROGRESS throttling: consecutive PROGRESS responses spaced by >= 100ms
 * - Zero shared mutable state across requests
 * - DOM/window decoupling: runs purely in Node/test environments
 * - Reuse of core calculation path (analyzeSource, decodePcm16Wav, makePreset)
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROGRESS_THROTTLE_MS,
  DEFAULT_TIMEOUT_MS,
  GainFrontWorker,
} from '../../src/worker/gainfront.worker.js';
import type {
  AnalyzeRequest,
  CancelRequest,
  ErrorResponse,
  ProgressResponse,
  ResultResponse,
  WorkerResponse,
} from '../../src/worker/protocol.js';
import type { Constraints } from '../../src/core/types.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import { makePreset } from '../../src/core/presets.js';

const validConstraints: Constraints = {
  targetLufs: -14,
  peakCeilingDbTp: -1.0,
  toleranceLu: 0.25,
  marginDb: 0.3,
};

describe('P010-T010 Dedicated Worker Contract', () => {
  it('guarantees environment decoupling: no window, document, or DOM references', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  describe('Protocol State Machine (ANALYZE -> PROGRESS -> RESULT)', () => {
    it('executes preset analysis successfully and returns matching requestId with AnalysisReport', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 101,
        presetId: 'GF-A',
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      expect(responses.length).toBeGreaterThanOrEqual(2);

      // Verify all responses have matching requestId
      for (const res of responses) {
        expect(res.requestId).toBe(101);
      }

      // Initial response is PROGRESS
      const first = responses[0] as ProgressResponse;
      expect(first.type).toBe('PROGRESS');
      expect(first.payload.phase).toBe('INITIALIZING');
      expect(first.payload.percent).toBe(0);

      // Final response is RESULT
      const last = responses[responses.length - 1] as ResultResponse;
      expect(last.type).toBe('RESULT');
      expect(last.payload.synthetic).toBe(true);
      expect(last.payload.source).toEqual({ kind: 'preset', presetId: 'GF-A' });
      expect(last.payload.measurement).toBeDefined();
      expect(last.payload.solver).toBeDefined();
      expect(last.payload.solver.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
    });

    it('executes external WAV bytes analysis successfully', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      // Generate a small valid WAV from GF-D
      const pcm = makePreset('GF-D');
      const wavBytes = encodePcm16Wav(pcm);

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 102,
        wavBytes,
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      const last = responses[responses.length - 1] as ResultResponse;
      expect(last.type).toBe('RESULT');
      expect(last.requestId).toBe(102);
      expect(last.payload.synthetic).toBe(false);
      expect(last.payload.source.kind).toBe('externalWav');
      expect(last.payload.solver.status).toBe('GAIN_FEASIBLE');
    });

    it('reports ERROR with stable error code when constraints are invalid', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      const req = {
        type: 'ANALYZE',
        requestId: 103,
        presetId: 'GF-A',
        constraints: {
          targetLufs: 50, // invalid: must be in [-30, -10]
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
      };

      await worker.handleMessage(req);

      expect(responses).toHaveLength(1);
      const err = responses[0] as ErrorResponse;
      expect(err.type).toBe('ERROR');
      expect(err.requestId).toBe(103);
      expect(err.payload.code).toBe('INVALID_CONSTRAINTS');
    });

    it('reports ERROR with UNSUPPORTED_WAV when wavBytes header is invalid', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      // 64 bytes of corrupted zeros
      const invalidWav = new ArrayBuffer(64);

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 104,
        wavBytes: invalidWav,
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      // Must terminate with ERROR
      const err = responses[responses.length - 1] as ErrorResponse;
      expect(err.type).toBe('ERROR');
      expect(err.requestId).toBe(104);
      expect(err.payload.code).toBe('UNSUPPORTED_WAV');
    });

    it('rejects malformed requests with non-negative integer requestId requirement', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      // Negative requestId
      await worker.handleMessage({ type: 'CANCEL', requestId: -5 });
      expect(responses).toHaveLength(1);
      expect(responses[0].type).toBe('ERROR');
      expect((responses[0] as ErrorResponse).payload.code).toBe('WORKER_ERROR');

      // Non-integer requestId
      responses.length = 0;
      await worker.handleMessage({ type: 'CANCEL', requestId: 3.14 });
      expect(responses).toHaveLength(1);
      expect(responses[0].type).toBe('ERROR');

      // Unknown message type
      responses.length = 0;
      await worker.handleMessage({ type: 'UNKNOWN_OP', requestId: 105 });
      expect(responses).toHaveLength(1);
      expect(responses[0].requestId).toBe(105);
      expect(responses[0].type).toBe('ERROR');
    });
  });

  describe('Cancellation Contract (CANCEL)', () => {
    it('cancels matching active request with OPERATION_CANCELLED and halts further outputs', async () => {
      const responses: WorkerResponse[] = [];
      let workerInstance: GainFrontWorker;

      workerInstance = new GainFrontWorker((res) => responses.push(res), {
        // Controlled yield: when yielding in request 201, deliver CANCEL 201
        yieldFn: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (workerInstance.getCurrentRequestId() === 201) {
            await workerInstance.handleMessage({
              type: 'CANCEL',
              requestId: 201,
            });
          }
        },
      });

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 201,
        presetId: 'GF-B',
        constraints: validConstraints,
      };

      await workerInstance.handleMessage(req);

      // Verify CANCEL emitted ERROR with OPERATION_CANCELLED
      const cancelErrors = responses.filter(
        (r) => r.type === 'ERROR' && (r as ErrorResponse).payload.code === 'OPERATION_CANCELLED'
      );
      expect(cancelErrors).toHaveLength(1);
      expect(cancelErrors[0].requestId).toBe(201);

      // Verify no RESULT was emitted for request 201
      const results = responses.filter((r) => r.type === 'RESULT');
      expect(results).toHaveLength(0);

      // Verify worker is no longer busy
      expect(workerInstance.isBusy()).toBe(false);
    });

    it('CANCEL only cancels matching requestId and must not kill other requests', async () => {
      const responses: WorkerResponse[] = [];
      let workerInstance: GainFrontWorker;

      workerInstance = new GainFrontWorker((res) => responses.push(res), {
        yieldFn: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          // Attempt to cancel an irrelevant requestId 999 while 202 is running
          if (workerInstance.getCurrentRequestId() === 202) {
            await workerInstance.handleMessage({
              type: 'CANCEL',
              requestId: 999,
            });
          }
        },
      });

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 202,
        presetId: 'GF-B',
        constraints: validConstraints,
      };

      await workerInstance.handleMessage(req);

      // Request 202 must NOT have been cancelled!
      const cancelErrors = responses.filter(
        (r) => r.type === 'ERROR' && (r as ErrorResponse).payload.code === 'OPERATION_CANCELLED'
      );
      expect(cancelErrors).toHaveLength(0);

      // Request 202 completes normally with RESULT
      const last = responses[responses.length - 1] as ResultResponse;
      expect(last.type).toBe('RESULT');
      expect(last.requestId).toBe(202);
      expect(last.payload.solver.status).toBe('GAIN_FEASIBLE');
    });

    it('CANCEL for an already completed or nonexistent request does nothing', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      const cancelReq: CancelRequest = {
        type: 'CANCEL',
        requestId: 9999,
      };

      await worker.handleMessage(cancelReq);
      expect(responses).toHaveLength(0);
    });
  });

  describe('Latest Request Wins (最新请求优先)', () => {
    it('voids uncompleted request immediately when new ANALYZE arrives: old request emits no subsequent RESULT/ERROR/PROGRESS', async () => {
      const responses: WorkerResponse[] = [];
      let workerInstance: GainFrontWorker;
      let req2Promise: Promise<void> | undefined;

      workerInstance = new GainFrontWorker((res) => responses.push(res), {
        yieldFn: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          // When request 301 yields, immediately inject request 302
          if (workerInstance.getCurrentRequestId() === 301 && !req2Promise) {
            const req2: AnalyzeRequest = {
              type: 'ANALYZE',
              requestId: 302,
              presetId: 'GF-C',
              constraints: validConstraints,
            };
            req2Promise = workerInstance.handleMessage(req2);
          }
        },
      });

      const req1: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 301,
        presetId: 'GF-A',
        constraints: validConstraints,
      };

      await workerInstance.handleMessage(req1);
      if (req2Promise) {
        await req2Promise;
      }

      // Check results: only request 302 may have a RESULT
      const results = responses.filter((r) => r.type === 'RESULT') as ResultResponse[];
      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe(302);
      expect(results[0].payload.source).toEqual({ kind: 'preset', presetId: 'GF-C' });

      // Request 301 must NOT have any RESULT
      const req1Results = responses.filter((r) => r.requestId === 301 && r.type === 'RESULT');
      expect(req1Results).toHaveLength(0);

      // Request 301 must NOT have any ERROR
      const req1Errors = responses.filter((r) => r.requestId === 301 && r.type === 'ERROR');
      expect(req1Errors).toHaveLength(0);
    });

    it('handles rapid burst of 5 ANALYZE requests: only the last request completes', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      // Dispatch 5 requests without waiting
      const p1 = worker.handleMessage({
        type: 'ANALYZE',
        requestId: 401,
        presetId: 'GF-A',
        constraints: validConstraints,
      });
      const p2 = worker.handleMessage({
        type: 'ANALYZE',
        requestId: 402,
        presetId: 'GF-B',
        constraints: validConstraints,
      });
      const p3 = worker.handleMessage({
        type: 'ANALYZE',
        requestId: 403,
        presetId: 'GF-C',
        constraints: validConstraints,
      });
      const p4 = worker.handleMessage({
        type: 'ANALYZE',
        requestId: 404,
        presetId: 'GF-D',
        constraints: validConstraints,
      });
      const p5 = worker.handleMessage({
        type: 'ANALYZE',
        requestId: 405,
        presetId: 'GF-E',
        constraints: validConstraints,
      });

      await Promise.all([p1, p2, p3, p4, p5]);

      const results = responses.filter((r) => r.type === 'RESULT') as ResultResponse[];
      // Exactly 1 result, matching the final requestId 405
      expect(results).toHaveLength(1);
      expect(results[0].requestId).toBe(405);
      expect(results[0].payload.source).toEqual({ kind: 'preset', presetId: 'GF-E' });

      // Requests 401-404 must have 0 RESULT responses
      for (const id of [401, 402, 403, 404]) {
        expect(responses.filter((r) => r.requestId === id && r.type === 'RESULT')).toHaveLength(0);
      }
    });
  });

  describe('40s Timeout Ceiling (40s 上限)', () => {
    it('defaults to 40_000ms timeout constant per specification', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(40_000);
    });

    it('times out and emits ERROR (WORKER_ERROR) using short timeout injection without waiting 40s', async () => {
      const responses: WorkerResponse[] = [];

      // Inject a short 20ms timeout with a yieldFn that pauses longer than 20ms
      const worker = new GainFrontWorker((res) => responses.push(res), {
        timeoutMs: 20,
        yieldFn: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        },
      });

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 501,
        presetId: 'GF-A',
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      // Must emit ERROR with code WORKER_ERROR
      const errors = responses.filter((r) => r.type === 'ERROR') as ErrorResponse[];
      expect(errors).toHaveLength(1);
      expect(errors[0].requestId).toBe(501);
      expect(errors[0].payload.code).toBe('WORKER_ERROR');
      expect(errors[0].payload.message).toContain('Analysis timed out');
      expect(errors[0].payload.details?.timeoutMs).toBe(20);

      // Must not emit any RESULT
      expect(responses.filter((r) => r.type === 'RESULT')).toHaveLength(0);
    });

    it('verifies 40_000ms timeout behavior using fake timers', async () => {
      vi.useFakeTimers();
      try {
        const responses: WorkerResponse[] = [];

        // Worker with default 40s timeout, but yieldFn never completes until timers advance
        let resumeYield: () => void = () => {};
        const worker = new GainFrontWorker((res) => responses.push(res), {
          yieldFn: () =>
            new Promise<void>((resolve) => {
              resumeYield = resolve;
            }),
        });

        const req: AnalyzeRequest = {
          type: 'ANALYZE',
          requestId: 502,
          presetId: 'GF-A',
          constraints: validConstraints,
        };

        const handlePromise = worker.handleMessage(req);

        // Before 40s: no timeout error yet
        await vi.advanceTimersByTimeAsync(39_900);
        expect(responses.filter((r) => r.type === 'ERROR')).toHaveLength(0);

        // Advance past 40,000ms
        await vi.advanceTimersByTimeAsync(200);

        // Timeout should have fired
        const errors = responses.filter((r) => r.type === 'ERROR') as ErrorResponse[];
        expect(errors).toHaveLength(1);
        expect(errors[0].requestId).toBe(502);
        expect(errors[0].payload.code).toBe('WORKER_ERROR');
        expect(errors[0].payload.details?.timeoutMs).toBe(40_000);

        // Resume yield so promise settles
        resumeYield();
        await handlePromise;

        // No RESULT emitted after timeout
        expect(responses.filter((r) => r.type === 'RESULT')).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('PROGRESS Throttling (100ms 节流)', () => {
    it('defaults to 100ms throttle interval per specification', () => {
      expect(DEFAULT_PROGRESS_THROTTLE_MS).toBe(100);
    });

    it('strictly enforces that consecutive emitted PROGRESS responses are spaced >= 100ms apart', async () => {
      let simulatedTime = 1000;
      const responses: WorkerResponse[] = [];
      const progressTimes: number[] = [];

      const worker = new GainFrontWorker(
        (res) => {
          responses.push(res);
          if (res.type === 'PROGRESS') {
            progressTimes.push(simulatedTime);
          }
        },
        {
          throttleMs: 100,
          clock: () => simulatedTime,
          // Advance clock by 30ms at each yield
          yieldFn: async () => {
            simulatedTime += 30;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          },
        }
      );

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 601,
        presetId: 'GF-B',
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      // Verify that for all emitted PROGRESS messages, the interval between any two is >= 100ms
      expect(progressTimes.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < progressTimes.length; i++) {
        const interval = progressTimes[i] - progressTimes[i - 1];
        expect(interval).toBeGreaterThanOrEqual(100);
      }
    });

    it('drops intermediate PROGRESS attempts when time delta is < 100ms', async () => {
      let simulatedTime = 5000;
      const responses: WorkerResponse[] = [];

      const worker = new GainFrontWorker(
        (res) => responses.push(res),
        {
          throttleMs: 100,
          clock: () => simulatedTime,
          // Clock does not advance at all during intermediate stages
          yieldFn: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          },
        }
      );

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 602,
        presetId: 'GF-B',
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      // Because clock was frozen at 5000, only the first PROGRESS (INITIALIZING) was sent;
      // all subsequent stages within the same tick were throttled
      const progressList = responses.filter((r) => r.type === 'PROGRESS') as ProgressResponse[];
      expect(progressList).toHaveLength(1);
      expect(progressList[0].payload.phase).toBe('INITIALIZING');

      // The final RESULT is never throttled
      const resultList = responses.filter((r) => r.type === 'RESULT');
      expect(resultList).toHaveLength(1);
    });

    it('emits all intermediate PROGRESS phases when clock advances by >= 100ms between each stage', async () => {
      let simulatedTime = 10_000;
      const responses: WorkerResponse[] = [];

      const worker = new GainFrontWorker(
        (res) => responses.push(res),
        {
          throttleMs: 100,
          clock: () => simulatedTime,
          // Advance clock by 110ms at every stage yield
          yieldFn: async () => {
            simulatedTime += 110;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          },
        }
      );

      const req: AnalyzeRequest = {
        type: 'ANALYZE',
        requestId: 603,
        presetId: 'GF-A',
        constraints: validConstraints,
      };

      await worker.handleMessage(req);

      const progressPhases = (responses.filter((r) => r.type === 'PROGRESS') as ProgressResponse[])
        .map((p) => p.payload.phase);

      // Verify that major phases passed through
      expect(progressPhases).toContain('INITIALIZING');
      expect(progressPhases).toContain('GENERATING_PRESET');
      expect(progressPhases).toContain('FILTERING_K');
      expect(progressPhases).toContain('COMPUTING_GATES');
      expect(progressPhases).toContain('ESTIMATING_TRUE_PEAK');
      expect(progressPhases).toContain('SOLVING_GRID');
      expect(progressPhases).toContain('COMPLETE');
    });
  });

  describe('Zero Cross-Request Shared Mutable State', () => {
    it('executes consecutive requests without state leakage or cache pollution', async () => {
      const responses: WorkerResponse[] = [];
      const worker = new GainFrontWorker((res) => responses.push(res));

      // Request 1: GF-A (infeasible / blocked)
      await worker.handleMessage({
        type: 'ANALYZE',
        requestId: 701,
        presetId: 'GF-A',
        constraints: validConstraints,
      });

      const res1 = responses.find((r) => r.requestId === 701 && r.type === 'RESULT') as ResultResponse;
      expect(res1.payload.solver.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
      expect(res1.payload.source).toEqual({ kind: 'preset', presetId: 'GF-A' });

      // Request 2: GF-B (feasible)
      await worker.handleMessage({
        type: 'ANALYZE',
        requestId: 702,
        presetId: 'GF-B',
        constraints: validConstraints,
      });

      const res2 = responses.find((r) => r.requestId === 702 && r.type === 'RESULT') as ResultResponse;
      expect(res2.payload.solver.status).toBe('GAIN_FEASIBLE');
      expect(res2.payload.source).toEqual({ kind: 'preset', presetId: 'GF-B' });

      // Request 3: Error request
      await worker.handleMessage({
        type: 'ANALYZE',
        requestId: 703,
        presetId: 'GF-A',
        constraints: {
          targetLufs: -999, // invalid
          peakCeilingDbTp: -1,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
      });

      const res3 = responses.find((r) => r.requestId === 703 && r.type === 'ERROR') as ErrorResponse;
      expect(res3.payload.code).toBe('INVALID_CONSTRAINTS');

      // Request 4: Normal request following error succeeds cleanly
      await worker.handleMessage({
        type: 'ANALYZE',
        requestId: 704,
        presetId: 'GF-B',
        constraints: validConstraints,
      });

      const res4 = responses.find((r) => r.requestId === 704 && r.type === 'RESULT') as ResultResponse;
      expect(res4.payload.solver.status).toBe('GAIN_FEASIBLE');
      expect(worker.isBusy()).toBe(false);
    });
  });
});
