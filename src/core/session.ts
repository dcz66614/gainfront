/**
 * GainFront Session Persistence Engine (gainfront.session/1)
 *
 * Implements session serialization, validation, external WAV SHA-256 rebinding,
 * 128 KiB size limit enforcement, and strict schema version control per
 * PROJECT_BOOK.md §6, §8.1, §8.2, §8.3 and task card P010-T009.
 */

import { createHash } from 'node:crypto';
import { analyzeSource } from './analyze.js';
import { GainFrontError } from './errors.js';
import type {
  AnalysisReport,
  Constraints,
  Measurement,
  Session,
  SessionView,
  SolverResult,
  SourceRef,
} from './types.js';
import {
  validateConstraints,
  validateGainTick,
  validateSourceRef,
  validateWavByteLength,
  WAV_MAX_BYTES,
} from './validate.js';
import { decodePcm16Wav } from './wav.js';

// --- Frozen Session Schema Constants ---
export const SESSION_SCHEMA = 'gainfront.session/1' as const;
export const PROJECT_ID = 'P010' as const;
export const SPEC_VERSION = '1.0.0' as const;
export const SESSION_MAX_BYTES = 128 * 1024; // 131,072 bytes (128 KiB limit)

// --- Extended Session Types ---

export interface InputSummary {
  fileName?: string;
  sampleRate: 48000;
  channels: 1 | 2;
  frames: number;
  byteLength: number;
  sha256Hex: string;
}

export interface MethodNotes {
  loudnessStandard: string;
  truePeakMethod: string;
  gridStepDb: number;
  marginDb: number;
  disclaimer: string;
}

declare module './types.js' {
  interface Session {
    inputSummary?: InputSummary;
    methodNotes?: string | MethodNotes;
  }
}

export type GainFrontSession = Session;

export interface CreateSessionOptions {
  source: SourceRef;
  constraints: Constraints;
  view?: Partial<SessionView>;
  synthetic?: boolean;
  inputSummary?: InputSummary;
  methodNotes?: string | MethodNotes;
  includeAudit?: boolean;
  measurement?: Partial<Measurement>;
  solver?: Partial<SolverResult>;
}

export interface RebindOptions {
  fileName?: string;
  expectedSha256Hex?: string;
}

export interface RebindResult {
  session: Session;
  report: AnalysisReport;
  measurement: Measurement;
  solver: SolverResult;
  verifiedSha256Hex: string;
}

// --- SHA-256 Hashing Utilities ---

/**
 * Synchronous SHA-256 computation using Node.js crypto.
 * Used for deterministic file verification, testing, and worker operations.
 */
export function computeSha256Sync(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  return createHash('sha256').update(bytes).digest('hex').toLowerCase();
}

/**
 * Asynchronous SHA-256 computation per PROJECT_BOOK.md §8.3 (WebCrypto API).
 * Delegates to globalThis.crypto.subtle when available, with synchronous fallback.
 */
export async function computeSha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);

  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toLowerCase();
  }
  return computeSha256Sync(bytes);
}

// --- Internal Validation Helpers ---

function assertPlainObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Expected plain object for ${context}, received ${typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertNoUnknownFields(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new GainFrontError('UNKNOWN_FIELD', `Unknown field "${key}" in ${context}`, {
        field: key,
        allowedKeys: Array.from(allowedKeys),
      });
    }
  }
}

function assertNoNonFinite(obj: unknown, path = 'root'): void {
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) {
      throw new GainFrontError(
        'NON_FINITE_VALUE',
        `Non-finite numeric value encountered at "${path}": ${obj}`,
      );
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoNonFinite(obj[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const [key, val] of Object.entries(obj)) {
      assertNoNonFinite(val, `${path}.${key}`);
    }
  }
}

function assertNoSampleData(obj: unknown, path = 'root'): void {
  if (typeof obj !== 'object' || obj === null) return;
  const record = obj as Record<string, unknown>;
  const forbiddenKeys = ['planar', 'samples', 'pcm', 'audioData', 'rawSamples'];
  for (const k of forbiddenKeys) {
    if (k in record && record[k] !== undefined) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Session must not store audio sample data: found "${k}" at "${path}"`,
      );
    }
  }
  if (
    record instanceof Float64Array ||
    record instanceof Float32Array ||
    record instanceof Int16Array
  ) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Session must not contain raw audio typed arrays at "${path}"`,
    );
  }
  for (const [key, val] of Object.entries(record)) {
    assertNoSampleData(val, `${path}.${key}`);
  }
}

// --- Session Validator ---

/**
 * Validates a candidate session against the gainfront.session/1 schema.
 * Enforces strict whitelist, schema version, non-finite checks, and sample absence.
 */
export function validateSession(input: unknown): Session {
  const obj = assertPlainObject(input, 'Session');

  const ALLOWED_SESSION_KEYS = [
    'schema',
    'projectId',
    'specVersion',
    'synthetic',
    'source',
    'constraints',
    'view',
    'inputSummary',
    'methodNotes',
    'audit',
  ] as const;
  assertNoUnknownFields(obj, ALLOWED_SESSION_KEYS, 'Session');

  if (obj.schema !== SESSION_SCHEMA) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Invalid schema "${String(obj.schema)}". Expected "${SESSION_SCHEMA}". Silent migration is strictly forbidden.`,
      { received: obj.schema, expected: SESSION_SCHEMA },
    );
  }

  if (obj.projectId !== PROJECT_ID) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Invalid projectId "${String(obj.projectId)}". Expected "${PROJECT_ID}".`,
      { received: obj.projectId, expected: PROJECT_ID },
    );
  }

  if (obj.specVersion !== SPEC_VERSION) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Invalid specVersion "${String(obj.specVersion)}". Expected "${SPEC_VERSION}".`,
      { received: obj.specVersion, expected: SPEC_VERSION },
    );
  }

  if (typeof obj.synthetic !== 'boolean') {
    throw new GainFrontError('INVALID_SESSION', 'Session synthetic flag must be a boolean');
  }

  const source = validateSourceRef(obj.source);
  if (source.kind === 'preset' && obj.synthetic !== true) {
    throw new GainFrontError('INVALID_SESSION', 'Preset sessions must specify synthetic: true');
  }
  if (source.kind === 'externalWav' && obj.synthetic !== false) {
    throw new GainFrontError('INVALID_SESSION', 'External WAV sessions must specify synthetic: false');
  }

  const constraints = validateConstraints(obj.constraints);

  const viewObj = assertPlainObject(obj.view, 'Session.view');
  assertNoUnknownFields(viewObj, ['selectedGainTick', 'showBlockGates'], 'Session.view');
  const selectedGainTick = validateGainTick(viewObj.selectedGainTick);
  if (typeof viewObj.showBlockGates !== 'boolean') {
    throw new GainFrontError('INVALID_SESSION', 'Session.view.showBlockGates must be a boolean');
  }
  const view: SessionView = {
    selectedGainTick,
    showBlockGates: viewObj.showBlockGates,
  };

  let inputSummary: InputSummary | undefined = undefined;
  if (obj.inputSummary !== undefined) {
    const isObj = assertPlainObject(obj.inputSummary, 'Session.inputSummary');
    assertNoUnknownFields(
      isObj,
      ['fileName', 'sampleRate', 'channels', 'frames', 'byteLength', 'sha256Hex'],
      'Session.inputSummary',
    );
    if (isObj.sampleRate !== 48000) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        `inputSummary.sampleRate must be 48000, received ${String(isObj.sampleRate)}`,
      );
    }
    if (isObj.channels !== 1 && isObj.channels !== 2) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        `inputSummary.channels must be 1 or 2, received ${String(isObj.channels)}`,
      );
    }
    if (
      typeof isObj.frames !== 'number' ||
      !Number.isInteger(isObj.frames) ||
      isObj.frames < 48000 ||
      isObj.frames > 1440000
    ) {
      throw new GainFrontError(
        'OUT_OF_SCOPE',
        `inputSummary.frames out of supported scope [48000, 1440000]: ${String(isObj.frames)}`,
      );
    }
    if (
      typeof isObj.byteLength !== 'number' ||
      !Number.isInteger(isObj.byteLength) ||
      isObj.byteLength <= 0 ||
      isObj.byteLength > WAV_MAX_BYTES
    ) {
      throw new GainFrontError(
        'OUT_OF_SCOPE',
        `inputSummary.byteLength out of scope [1, ${WAV_MAX_BYTES}]: ${String(isObj.byteLength)}`,
      );
    }
    if (typeof isObj.sha256Hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(isObj.sha256Hex)) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `inputSummary.sha256Hex must be a 64-character hexadecimal string`,
      );
    }
    if (isObj.fileName !== undefined && typeof isObj.fileName !== 'string') {
      throw new GainFrontError(
        'INVALID_SESSION',
        'inputSummary.fileName must be a string if provided',
      );
    }
    if (source.kind === 'externalWav') {
      if (isObj.sha256Hex.toLowerCase() !== source.sha256Hex.toLowerCase()) {
        throw new GainFrontError(
          'INVALID_SESSION',
          `inputSummary.sha256Hex ("${isObj.sha256Hex}") does not match source.sha256Hex ("${source.sha256Hex}")`,
        );
      }
      if (source.fileName && isObj.fileName && source.fileName !== isObj.fileName) {
        throw new GainFrontError(
          'INVALID_SESSION',
          `inputSummary.fileName ("${isObj.fileName}") does not match source.fileName ("${source.fileName}")`,
        );
      }
    }
    inputSummary = {
      fileName: isObj.fileName as string | undefined,
      sampleRate: 48000,
      channels: isObj.channels as 1 | 2,
      frames: isObj.frames,
      byteLength: isObj.byteLength,
      sha256Hex: isObj.sha256Hex.toLowerCase(),
    };
  }

  let methodNotes: string | MethodNotes | undefined = undefined;
  if (obj.methodNotes !== undefined) {
    if (typeof obj.methodNotes === 'string') {
      methodNotes = obj.methodNotes;
    } else if (typeof obj.methodNotes === 'object' && obj.methodNotes !== null) {
      const mnObj = obj.methodNotes as Record<string, unknown>;
      assertNoUnknownFields(
        mnObj,
        ['loudnessStandard', 'truePeakMethod', 'gridStepDb', 'marginDb', 'disclaimer'],
        'Session.methodNotes',
      );
      methodNotes = {
        loudnessStandard: String(mnObj.loudnessStandard ?? ''),
        truePeakMethod: String(mnObj.truePeakMethod ?? ''),
        gridStepDb: Number(mnObj.gridStepDb ?? 0.1),
        marginDb: Number(mnObj.marginDb ?? 0.3),
        disclaimer: String(mnObj.disclaimer ?? ''),
      };
    } else {
      throw new GainFrontError('INVALID_SESSION', 'Session.methodNotes must be a string or object');
    }
  }

  let audit: Session['audit'] = undefined;
  if (obj.audit !== undefined) {
    const auditObj = assertPlainObject(obj.audit, 'Session.audit');
    assertNoUnknownFields(
      auditObj,
      ['measurement', 'solver', 'inputSummary', 'methodNotes'],
      'Session.audit',
    );
    assertNoSampleData(auditObj, 'Session.audit');
    audit = auditObj as Session['audit'];
  }

  assertNoNonFinite(obj);
  assertNoSampleData(obj);

  return {
    schema: SESSION_SCHEMA,
    projectId: PROJECT_ID,
    specVersion: SPEC_VERSION,
    synthetic: obj.synthetic,
    source,
    constraints,
    view,
    ...(inputSummary !== undefined ? { inputSummary } : {}),
    ...(methodNotes !== undefined ? { methodNotes } : {}),
    ...(audit !== undefined ? { audit } : {}),
  };
}

// --- Creation & Serialization API ---

/**
 * Creates a valid Session object.
 */
export function createSession(options: CreateSessionOptions): Session {
  if (typeof options !== 'object' || options === null) {
    throw new GainFrontError('INVALID_SESSION', 'createSession requires an options object');
  }

  const source = validateSourceRef(options.source);
  const constraints = validateConstraints(options.constraints);
  const synthetic = source.kind === 'preset' ? true : false;

  const view: SessionView = {
    selectedGainTick:
      options.view?.selectedGainTick !== undefined
        ? validateGainTick(options.view.selectedGainTick)
        : 0,
    showBlockGates: options.view?.showBlockGates ?? true,
  };

  let audit: Session['audit'] = undefined;
  if (options.includeAudit || options.measurement || options.solver) {
    audit = {};
    if (options.measurement) {
      audit.measurement = {
        integratedLufs: options.measurement.integratedLufs,
        samplePeakDbFs: options.measurement.samplePeakDbFs,
        estimatedTruePeakDbTp: options.measurement.estimatedTruePeakDbTp,
        samplePeakFrame: options.measurement.samplePeakFrame,
        estimatedPeakPosition: options.measurement.estimatedPeakPosition,
      };
    }
    if (options.solver) {
      audit.solver = {
        status: options.solver.status,
        gBestTick: options.solver.gBestTick,
        gTargetTick: options.solver.gTargetTick,
        minimumGridDeviationLu: options.solver.minimumGridDeviationLu,
        peakBoundaryDb: options.solver.peakBoundaryDb,
        witness: options.solver.witness,
      };
    }
  }

  const sessionCandidate: Session = {
    schema: SESSION_SCHEMA,
    projectId: PROJECT_ID,
    specVersion: SPEC_VERSION,
    synthetic,
    source,
    constraints,
    view,
    ...(options.inputSummary !== undefined ? { inputSummary: options.inputSummary } : {}),
    ...(options.methodNotes !== undefined ? { methodNotes: options.methodNotes } : {}),
    ...(audit !== undefined && Object.keys(audit).length > 0 ? { audit } : {}),
  };

  return validateSession(sessionCandidate);
}

/**
 * Creates a Session from a completed AnalysisReport.
 */
export function createSessionFromAnalysis(
  report: AnalysisReport,
  options?: {
    view?: Partial<SessionView>;
    fileName?: string;
    byteLength?: number;
    includeAudit?: boolean;
    methodNotes?: string | MethodNotes;
  },
): Session {
  if (typeof report !== 'object' || report === null) {
    throw new GainFrontError(
      'INVALID_SESSION',
      'createSessionFromAnalysis requires a valid AnalysisReport',
    );
  }

  let inputSummary: InputSummary | undefined = undefined;
  if (report.source.kind === 'externalWav') {
    // FIX-R2-01: real byteLength first (explicit option, then the value
    // carried on report.source from the actual WAV bytes). The old
    // 44 + frames*channels*2 guess is only a last-resort fallback for
    // legacy reports that predate byteLength persistence; it is wrong
    // for legal RIFF files with extra chunks, extended fmt, or padding.
    const realByteLength =
      report.source.byteLength !== undefined && report.source.byteLength > 0
        ? report.source.byteLength
        : undefined;
    const fallbackByteLength =
      44 +
      (report.provenance?.frames ?? 48000) *
        ((report.waveformSummary?.channels ?? 1) as number) *
        2;
    inputSummary = {
      fileName: options?.fileName ?? report.source.fileName,
      sampleRate: 48000,
      channels: (report.waveformSummary?.channels ?? 1) as 1 | 2,
      frames: report.provenance?.frames ?? 48000,
      byteLength:
        options?.byteLength && options.byteLength > 0
          ? options.byteLength
          : (realByteLength ?? fallbackByteLength),
      sha256Hex: report.source.sha256Hex,
    };
  }

  return createSession({
    source: report.source,
    constraints: report.constraints,
    view: options?.view,
    inputSummary,
    methodNotes:
      options?.methodNotes ??
      'GainFront BS.1770 K-weighting + 4x sinc true-peak approximation (margin 0.3 dB). Not a certified broadcast compliance meter.',
    includeAudit: options?.includeAudit ?? true,
    measurement: report.measurement,
    solver: report.solver,
  });
}

/**
 * Exports a Session object to serialized JSON.
 * Rejects if serialized size exceeds 128 KiB (131,072 bytes).
 * Guarantees no raw sample data is exported.
 */
export function exportSession(session: Session, options?: { pretty?: boolean }): string {
  if (typeof session !== 'object' || session === null) {
    throw new GainFrontError('INVALID_SESSION', 'Cannot export non-object session');
  }

  const validated = validateSession(session);

  // Sanitize export structure: ensure blockPowers is stripped from measurement if present
  const exportPayload = JSON.parse(JSON.stringify(validated));
  if (exportPayload.audit?.measurement?.blockPowers) {
    delete exportPayload.audit.measurement.blockPowers;
  }

  const jsonStr = options?.pretty
    ? JSON.stringify(exportPayload, null, 2)
    : JSON.stringify(exportPayload);

  const byteLength = new TextEncoder().encode(jsonStr).length;
  if (byteLength > SESSION_MAX_BYTES) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Session serialized size (${byteLength} bytes) exceeds 128KiB limit (${SESSION_MAX_BYTES} bytes)`,
      { byteLength, maxBytes: SESSION_MAX_BYTES },
    );
  }

  return jsonStr;
}

/**
 * Alias for exportSession per project contract.
 */
export const saveSession = exportSession;

/**
 * Parses and strictly validates a session JSON string.
 * Rejects inputs > 128 KiB, invalid JSON, or schema violations.
 */
export function parseSession(json: string): Session {
  if (typeof json !== 'string') {
    throw new GainFrontError('INVALID_SESSION', 'parseSession requires a JSON string input');
  }

  const byteLength = new TextEncoder().encode(json).length;
  if (byteLength > SESSION_MAX_BYTES) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Session JSON input (${byteLength} bytes) exceeds 128KiB limit (${SESSION_MAX_BYTES} bytes)`,
      { byteLength, maxBytes: SESSION_MAX_BYTES },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `Invalid JSON syntax in session: ${(err as Error).message}`,
    );
  }

  return validateSession(parsed);
}

/**
 * Alias for parseSession per project contract.
 */
export const loadSession = parseSession;

// --- External WAV Rebinding & Verification Engine ---

/**
 * Rebinds an external WAV file to an existing Session.
 * Verifies file metadata (sample rate, channels, frame count, byte size) and SHA-256.
 * Rejects replaced, renamed, or modified files.
 * Ignores any previous audit cache and computes fresh, authoritative results.
 */
export function rebindExternalWav(
  session: Session,
  wavBytes: ArrayBuffer,
  options?: RebindOptions,
): RebindResult {
  if (session.source.kind !== 'externalWav') {
    throw new GainFrontError(
      'INVALID_SOURCE_REF',
      `rebindExternalWav requires externalWav session, received ${session.source.kind}`,
    );
  }

  if (!(wavBytes instanceof ArrayBuffer)) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      'wavBytes must be an ArrayBuffer containing raw WAV data',
    );
  }

  validateWavByteLength(wavBytes.byteLength);

  // File name verification
  const expectedName = options?.fileName ?? session.source.fileName ?? session.inputSummary?.fileName;
  if (session.source.fileName && options?.fileName && session.source.fileName !== options.fileName) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `File name mismatch: session recorded "${session.source.fileName}", but provided "${options.fileName}". Renamed file rejected.`,
      { recorded: session.source.fileName, provided: options.fileName },
    );
  }

  if (
    session.inputSummary?.fileName &&
    options?.fileName &&
    session.inputSummary.fileName !== options.fileName
  ) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `File name mismatch: inputSummary recorded "${session.inputSummary.fileName}", but provided "${options.fileName}". Renamed file rejected.`,
      { recorded: session.inputSummary.fileName, provided: options.fileName },
    );
  }

  // Metadata verification against inputSummary if present
  const pcm = decodePcm16Wav(wavBytes);
  if (session.inputSummary) {
    if (session.inputSummary.sampleRate !== pcm.sampleRate) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Sample rate mismatch: session expected ${session.inputSummary.sampleRate} Hz, decoded ${pcm.sampleRate} Hz`,
      );
    }
    if (session.inputSummary.channels !== pcm.channels) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Channel count mismatch: session expected ${session.inputSummary.channels}, decoded ${pcm.channels}`,
      );
    }
    if (session.inputSummary.frames !== pcm.frames) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Frame count mismatch: session expected ${session.inputSummary.frames}, decoded ${pcm.frames}`,
      );
    }
    if (session.inputSummary.byteLength !== wavBytes.byteLength) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `File byteLength mismatch: session expected ${session.inputSummary.byteLength}, received ${wavBytes.byteLength}`,
      );
    }
  }

  // Cryptographic SHA-256 verification
  const computedSha256 = computeSha256Sync(wavBytes).toLowerCase();
  const targetSha256 = session.source.sha256Hex.toLowerCase();

  if (computedSha256 !== targetSha256) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `SHA-256 hash mismatch: expected "${targetSha256}", computed "${computedSha256}". Refusing to load modified or replaced audio file.`,
      { expected: targetSha256, computed: computedSha256 },
    );
  }

  if (options?.expectedSha256Hex) {
    const optTarget = options.expectedSha256Hex.toLowerCase();
    if (computedSha256 !== optTarget) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `SHA-256 hash mismatch with expectedSha256Hex: expected "${optTarget}", computed "${computedSha256}"`,
      );
    }
  }

  // Audit cache is NEVER trusted per PROJECT_BOOK §8.3 & Task card.
  // Re-run fresh authoritative analysis using verified WAV.
  const report = analyzeSource({
    constraints: session.constraints,
    wavBytes,
    source: session.source,
    fileName: expectedName,
    sha256Hex: computedSha256,
  });

  return {
    session,
    report,
    measurement: report.measurement,
    solver: report.solver,
    verifiedSha256Hex: computedSha256,
  };
}

/**
 * Rebinds a session to audio and re-runs authoritative verification.
 * For preset sessions, deterministically reconstructs PCM without external file.
 * For external WAV sessions, strictly verifies provided WAV bytes against metadata and SHA-256.
 */
export function rebindSession(
  session: Session,
  wavBytes?: ArrayBuffer,
  options?: RebindOptions,
): RebindResult {
  if (session.source.kind === 'preset') {
    const report = analyzeSource({
      presetId: session.source.presetId,
      constraints: session.constraints,
    });
    return {
      session,
      report,
      measurement: report.measurement,
      solver: report.solver,
      verifiedSha256Hex: `preset:${session.source.presetId}`,
    };
  }

  if (session.source.kind === 'externalWav') {
    if (!wavBytes) {
      throw new GainFrontError(
        'SOURCE_REQUIRED',
        'External WAV file bytes are required to rebind session',
      );
    }
    return rebindExternalWav(session, wavBytes, options);
  }

  throw new GainFrontError(
    'INVALID_SOURCE_REF',
    `Unknown session source kind: ${String((session.source as SourceRef).kind)}`,
  );
}

/**
 * Evaluates and returns the authoritative AnalysisReport for a session after audio verification.
 * Disregards any untrusted audit caches.
 */
export function verifySessionAudio(
  session: Session,
  wavBytes?: ArrayBuffer,
  options?: RebindOptions,
): AnalysisReport {
  return rebindSession(session, wavBytes, options).report;
}
