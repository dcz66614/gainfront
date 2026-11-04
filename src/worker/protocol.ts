/**
 * GainFront Worker Protocol Definitions
 *
 * Defines the bidirectional message contracts between the main thread
 * and the dedicated Web Worker per PROJECT_BOOK.md §8.3 and task card P010-T002.
 */

import { GainFrontError } from '../core/errors.js';
import type { AnalysisReport, Constraints, PCM, PresetId } from '../core/types.js';
import { validateConstraints, validatePcm, validatePresetId } from '../core/validate.js';

// --- Requests (Main -> Worker) ---

export type ExternalAudioSource = {
  kind: 'externalWav';
  pcm: PCM;
  sha256Hex?: string;
  fileName?: string;
  byteLength?: number;
};

export type PresetAudioSource = {
  kind: 'preset';
  presetId: PresetId;
};

export type WorkerAudioSource = PresetAudioSource | ExternalAudioSource;

export type AnalyzeRequest = {
  type: 'ANALYZE';
  requestId: number;
  presetId?: PresetId;
  wavBytes?: ArrayBuffer;
  // FIX-R2-01 (independent-review follow-up): for a wavBytes request,
  // the caller may supply the file's SHA-256 and name alongside the
  // bytes; without a valid SHA the resulting report is analysable but
  // NOT exportable (validateSourceRef requires a 64-hex SHA), and the
  // worker must still carry byteLength so the length is never guessed.
  sha256Hex?: string;
  fileName?: string;
  source?: WorkerAudioSource;
  constraints: Constraints;
};

export type CancelRequest = {
  type: 'CANCEL';
  requestId: number;
};

export type WorkerRequest = AnalyzeRequest | CancelRequest;

// --- Responses (Worker -> Main) ---

export type WorkerProgressPhase =
  | 'INITIALIZING'
  | 'DECODING_WAV'
  | 'GENERATING_PRESET'
  | 'FILTERING_K'
  | 'COMPUTING_GATES'
  | 'ESTIMATING_TRUE_PEAK'
  | 'SOLVING_GRID'
  | 'COMPLETE';

export interface WorkerProgressPayload {
  phase: WorkerProgressPhase;
  percent: number; // 0 to 100
  message?: string;
}

export interface WorkerErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ProgressResponse = {
  type: 'PROGRESS';
  requestId: number;
  payload: WorkerProgressPayload;
};

export type ResultResponse = {
  type: 'RESULT';
  requestId: number;
  payload: AnalysisReport;
};

export type ErrorResponse = {
  type: 'ERROR';
  requestId: number;
  payload: WorkerErrorPayload;
};

export type WorkerResponse = ProgressResponse | ResultResponse | ErrorResponse;

// --- Validation Helpers ---

/**
 * Validates an incoming WorkerRequest.
 */
export function validateWorkerRequest(data: unknown): WorkerRequest {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new GainFrontError('WORKER_ERROR', 'Worker request must be an object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.requestId !== 'number' || !Number.isInteger(obj.requestId) || obj.requestId < 0) {
    throw new GainFrontError('WORKER_ERROR', `Worker request requires non-negative integer requestId, received ${obj.requestId}`);
  }

  if (obj.type === 'CANCEL') {
    return {
      type: 'CANCEL',
      requestId: obj.requestId,
    };
  }

  if (obj.type === 'ANALYZE') {
    if (!obj.constraints) {
      throw new GainFrontError('WORKER_ERROR', 'ANALYZE request requires constraints');
    }
    const constraints = validateConstraints(obj.constraints);

    let presetId: PresetId | undefined;
    if (obj.presetId !== undefined) {
      presetId = validatePresetId(obj.presetId);
    }

    let wavBytes: ArrayBuffer | undefined;
    if (obj.wavBytes !== undefined) {
      if (!(obj.wavBytes instanceof ArrayBuffer)) {
        throw new GainFrontError('WORKER_ERROR', 'wavBytes must be an instance of ArrayBuffer');
      }
      wavBytes = obj.wavBytes;
    }

    let sha256Hex: string | undefined;
    if (obj.sha256Hex !== undefined) {
      if (typeof obj.sha256Hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(obj.sha256Hex)) {
        throw new GainFrontError('WORKER_ERROR', 'sha256Hex must be a 64-character hexadecimal string if provided');
      }
      sha256Hex = obj.sha256Hex.toLowerCase();
    }
    let fileName: string | undefined;
    if (obj.fileName !== undefined) {
      if (typeof obj.fileName !== 'string') {
        throw new GainFrontError('WORKER_ERROR', 'fileName must be a string if provided');
      }
      fileName = obj.fileName;
    }

    let source: WorkerAudioSource | undefined;
    if (obj.source !== undefined) {
      if (typeof obj.source !== 'object' || obj.source === null || Array.isArray(obj.source)) {
        throw new GainFrontError('WORKER_ERROR', 'source must be an object');
      }
      const s = obj.source as Record<string, unknown>;
      if (s.kind === 'preset') {
        source = {
          kind: 'preset',
          presetId: validatePresetId(s.presetId),
        };
        if (!presetId) {
          presetId = source.presetId;
        }
      } else if (s.kind === 'externalWav') {
        const pcm = validatePcm(s.pcm);
        source = {
          kind: 'externalWav',
          pcm,
          sha256Hex: typeof s.sha256Hex === 'string' ? s.sha256Hex : undefined,
          fileName: typeof s.fileName === 'string' ? s.fileName : undefined,
          ...(typeof s.byteLength === 'number' && Number.isInteger(s.byteLength) && s.byteLength > 0
            ? { byteLength: s.byteLength }
            : {}),
        };
      } else {
        throw new GainFrontError('WORKER_ERROR', `Unknown source kind "${String(s.kind)}"`);
      }
    }

    if (!presetId && !wavBytes && !source) {
      throw new GainFrontError('WORKER_ERROR', 'ANALYZE request requires either presetId, wavBytes, or source');
    }

    return {
      type: 'ANALYZE',
      requestId: obj.requestId,
      presetId,
      wavBytes,
      sha256Hex,
      fileName,
      source,
      constraints,
    };
  }

  throw new GainFrontError('WORKER_ERROR', `Unknown worker request type: "${String(obj.type)}"`);
}

/**
 * Type guard for WorkerRequest.
 */
export function isWorkerRequest(data: unknown): data is WorkerRequest {
  try {
    validateWorkerRequest(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Type guard for WorkerResponse.
 */
export function isWorkerResponse(data: unknown): data is WorkerResponse {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.requestId !== 'number') return false;
  return obj.type === 'PROGRESS' || obj.type === 'RESULT' || obj.type === 'ERROR';
}
