/**
 * GainFront Dedicated Worker Implementation
 *
 * Implements the Dedicated Worker contract per PROJECT_BOOK.md §8.3 and task card P010-T010.
 *
 * Specification:
 * - Single Dedicated Worker instance.
 * - Bidirectional protocol: ANALYZE / CANCEL / RESULT / ERROR / PROGRESS, all with requestId.
 * - Latest request wins: When a new ANALYZE arrives, any running/pending request is immediately
 *   voided and will never emit RESULT, ERROR, or PROGRESS.
 * - CANCEL only cancels the specified requestId without affecting other requests.
 * - 40s timeout ceiling: Any request exceeding 40s (configurable) is aborted with ERROR ('WORKER_ERROR').
 * - 100ms PROGRESS throttling: Interval between emitted PROGRESS responses is at least 100ms.
 * - Free of window / document / DOM references.
 * - No shared mutable state across requests (only active request record).
 * - Computation reuses T007 core math (analyzeSource, decodePcm16Wav, makePreset).
 */

import { GainFrontError, isGainFrontError } from '../core/errors.js';
import { validateWavByteLength } from '../core/validate.js';
import { decodePcm16Wav } from '../core/wav.js';
import { makePreset } from '../core/presets.js';
import { analyzeSource } from '../core/analyze.js';
import type {
  AnalysisReport,
  PCM,
  SourceRef,
} from '../core/types.js';
import {
  type AnalyzeRequest,
  type WorkerProgressPhase,
  type WorkerRequest,
  type WorkerResponse,
  validateWorkerRequest,
} from './protocol.js';

export const DEFAULT_TIMEOUT_MS = 40_000;
export const DEFAULT_PROGRESS_THROTTLE_MS = 100;

export interface GainFrontWorkerOptions {
  timeoutMs?: number;
  throttleMs?: number;
  clock?: () => number;
  yieldFn?: () => Promise<void>;
  analyzeFn?: typeof analyzeSource;
}

interface ActiveRequest {
  requestId: number;
  cancelled: boolean;
  superseded: boolean;
  completed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class GainFrontWorker {
  private readonly postResponse: (response: WorkerResponse) => void;
  private readonly timeoutMs: number;
  private readonly throttleMs: number;
  private readonly clock: () => number;
  private readonly yieldFn: () => Promise<void>;
  private readonly analyzeFn: typeof analyzeSource;

  // Only mutable state: active request tracking and last progress timestamp
  private currentRequest: ActiveRequest | null = null;
  private lastProgressTime: number = -Infinity;

  constructor(
    postResponse: (response: WorkerResponse) => void,
    options?: GainFrontWorkerOptions,
  ) {
    this.postResponse = postResponse;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.throttleMs = options?.throttleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;
    this.clock = options?.clock ?? (() => Date.now());
    this.yieldFn = options?.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
    this.analyzeFn = options?.analyzeFn ?? analyzeSource;
  }

  public getCurrentRequestId(): number | null {
    return this.currentRequest?.requestId ?? null;
  }

  public isBusy(): boolean {
    return this.currentRequest !== null && !this.currentRequest.completed;
  }

  public async handleMessage(data: unknown): Promise<void> {
    let request: WorkerRequest;
    try {
      request = validateWorkerRequest(data);
    } catch (err: unknown) {
      const rawId =
        typeof data === 'object' &&
        data !== null &&
        'requestId' in data &&
        typeof (data as Record<string, unknown>).requestId === 'number'
          ? ((data as Record<string, unknown>).requestId as number)
          : -1;

      this.postResponse({
        type: 'ERROR',
        requestId: rawId,
        payload: {
          code: isGainFrontError(err) ? err.code : 'WORKER_ERROR',
          message: err instanceof Error ? err.message : String(err),
          ...(isGainFrontError(err) && err.details ? { details: err.details } : {}),
        },
      });
      return;
    }

    if (request.type === 'CANCEL') {
      this.handleCancel(request.requestId);
      return;
    }

    if (request.type === 'ANALYZE') {
      await this.handleAnalyze(request);
      return;
    }
  }

  private handleCancel(requestId: number): void {
    // CANCEL only cancels the specified requestId, must not kill other requests
    if (this.currentRequest !== null && this.currentRequest.requestId === requestId) {
      const target = this.currentRequest;
      target.cancelled = true;
      target.completed = true;
      this.clearTimer(target);
      this.currentRequest = null;

      this.postResponse({
        type: 'ERROR',
        requestId,
        payload: {
          code: 'OPERATION_CANCELLED',
          message: `Request ${requestId} was cancelled`,
        },
      });
    }
  }

  private async handleAnalyze(request: AnalyzeRequest): Promise<void> {
    // Latest request wins: Void any existing uncompleted request immediately
    if (this.currentRequest !== null) {
      const old = this.currentRequest;
      old.superseded = true;
      old.completed = true;
      this.clearTimer(old);
      this.currentRequest = null;
    }

    const record: ActiveRequest = {
      requestId: request.requestId,
      cancelled: false,
      superseded: false,
      completed: false,
      timer: undefined,
    };

    record.timer = setTimeout(() => {
      if (record.completed || record.cancelled || record.superseded) {
        return;
      }
      record.completed = true;
      if (this.currentRequest === record) {
        this.currentRequest = null;
      }
      this.postResponse({
        type: 'ERROR',
        requestId: record.requestId,
        payload: {
          code: 'WORKER_ERROR',
          message: `Analysis timed out after ${this.timeoutMs}ms`,
          details: { timeoutMs: this.timeoutMs },
        },
      });
    }, this.timeoutMs);

    this.currentRequest = record;

    try {
      await this.executeAnalyze(record, request);
    } catch (err: unknown) {
      if (this.isAborted(record)) {
        return;
      }
      this.finishError(record, err);
    }
  }

  private async executeAnalyze(record: ActiveRequest, request: AnalyzeRequest): Promise<void> {
    // Phase 1: INITIALIZING
    this.emitProgress(record, 'INITIALIZING', 0, 'Initializing analysis');
    await this.yieldFn();
    if (this.isAborted(record)) return;

    // Phase 2: PCM Acquisition (Preset, WAV decode, or External PCM)
    let pcm: PCM;
    let source: SourceRef;

    if (request.source?.kind === 'externalWav') {
      this.emitProgress(record, 'INITIALIZING', 15, 'Acquiring external PCM');
      await this.yieldFn();
      if (this.isAborted(record)) return;

      pcm = request.source.pcm;
      source = {
        kind: 'externalWav',
        sha256Hex: request.source.sha256Hex ?? '',
        fileName: request.source.fileName,
        requiresReselect: true,
        ...(request.source.byteLength !== undefined ? { byteLength: request.source.byteLength } : {}),
      };
    } else if (request.source?.kind === 'preset') {
      this.emitProgress(record, 'GENERATING_PRESET', 15, `Generating preset ${request.source.presetId}`);
      await this.yieldFn();
      if (this.isAborted(record)) return;

      pcm = makePreset(request.source.presetId);
      source = { kind: 'preset', presetId: request.source.presetId };
    } else if (request.presetId !== undefined) {
      this.emitProgress(record, 'GENERATING_PRESET', 15, `Generating preset ${request.presetId}`);
      await this.yieldFn();
      if (this.isAborted(record)) return;

      pcm = makePreset(request.presetId);
      source = { kind: 'preset', presetId: request.presetId };
    } else if (request.wavBytes !== undefined) {
      this.emitProgress(record, 'DECODING_WAV', 15, 'Decoding PCM16 WAV');
      await this.yieldFn();
      if (this.isAborted(record)) return;

      validateWavByteLength(request.wavBytes.byteLength);
      pcm = decodePcm16Wav(request.wavBytes);
      // FIX-R2-01 (independent-review follow-up): carry the REAL
      // byteLength of the bytes just decoded, plus any caller-supplied
      // SHA/name. Without a valid SHA the report is analysable but NOT
      // exportable (session validation requires a 64-hex SHA); that is
      // a SHA limitation, not a length guess — byteLength is never
      // reconstructed from 44 + frames*channels*2 here.
      source = {
        kind: 'externalWav',
        sha256Hex: request.sha256Hex ?? '',
        ...(request.fileName !== undefined ? { fileName: request.fileName } : {}),
        requiresReselect: true,
        byteLength: request.wavBytes.byteLength,
      };
    } else {
      throw new GainFrontError('WORKER_ERROR', 'ANALYZE request requires either presetId, wavBytes, or source');
    }

    await this.yieldFn();
    if (this.isAborted(record)) return;

    // Phase 3: Filtering
    this.emitProgress(record, 'FILTERING_K', 35, 'Applying K-weight filter');
    await this.yieldFn();
    if (this.isAborted(record)) return;

    // Phase 4: Gates computation
    this.emitProgress(record, 'COMPUTING_GATES', 50, 'Computing gated loudness');
    await this.yieldFn();
    if (this.isAborted(record)) return;

    // Phase 5: True peak estimation
    this.emitProgress(record, 'ESTIMATING_TRUE_PEAK', 70, 'Estimating true peak');
    await this.yieldFn();
    if (this.isAborted(record)) return;

    // Phase 6: Solver
    this.emitProgress(record, 'SOLVING_GRID', 85, 'Solving 481-point gain grid');
    await this.yieldFn();
    if (this.isAborted(record)) return;

    // Execute core analysis reusing T007 analyzeSource
    const report: AnalysisReport = this.analyzeFn({
      constraints: request.constraints,
      pcm,
      source,
    });

    // Phase 7: Complete
    this.emitProgress(record, 'COMPLETE', 100, 'Analysis complete');
    await this.yieldFn();
    if (this.isAborted(record)) return;

    this.finishSuccess(record, report);
  }

  private emitProgress(
    record: ActiveRequest,
    phase: WorkerProgressPhase,
    percent: number,
    message?: string,
  ): void {
    if (this.isAborted(record)) {
      return;
    }

    const now = this.clock();
    if (now - this.lastProgressTime >= this.throttleMs) {
      this.lastProgressTime = now;
      this.postResponse({
        type: 'PROGRESS',
        requestId: record.requestId,
        payload: {
          phase,
          percent,
          message,
        },
      });
    }
  }

  private finishSuccess(record: ActiveRequest, report: AnalysisReport): void {
    if (this.isAborted(record)) {
      return;
    }
    record.completed = true;
    this.clearTimer(record);
    if (this.currentRequest === record) {
      this.currentRequest = null;
    }

    this.postResponse({
      type: 'RESULT',
      requestId: record.requestId,
      payload: report,
    });
  }

  private finishError(record: ActiveRequest, err: unknown): void {
    if (this.isAborted(record)) {
      return;
    }
    record.completed = true;
    this.clearTimer(record);
    if (this.currentRequest === record) {
      this.currentRequest = null;
    }

    this.postResponse({
      type: 'ERROR',
      requestId: record.requestId,
      payload: {
        code: isGainFrontError(err) ? err.code : 'WORKER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        ...(isGainFrontError(err) && err.details ? { details: err.details } : {}),
      },
    });
  }

  private isAborted(record: ActiveRequest): boolean {
    return record.cancelled || record.superseded || record.completed;
  }

  private clearTimer(record: ActiveRequest): void {
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
  }
}

// Auto-wire dedicated worker instance in Worker environment
// Strictly avoid referencing window / document / DOM
if (typeof globalThis !== 'undefined' && typeof (globalThis as any).postMessage === 'function') {
  const isBrowserWindow =
    typeof (globalThis as any).window !== 'undefined' &&
    (globalThis as any).window === globalThis;

  if (!isBrowserWindow) {
    const worker = new GainFrontWorker((res) => (globalThis as any).postMessage(res));
    (globalThis as any).onmessage = (event: MessageEvent) => {
      void worker.handleMessage(event.data);
    };
  }
}
