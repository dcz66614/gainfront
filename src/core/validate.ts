/**
 * GainFront Core Validation Rules
 *
 * Implements strict boundary and schema validation per PROJECT_BOOK.md §8 and §4.3.
 * All errors use stable ErrorCode values via GainFrontError.
 */

import { GainFrontError } from './errors.js';
import type {
  Constraints,
  Measurement,
  PCM,
  PeakPosition,
  PresetId,
  SourceRef,
} from './types.js';
import { PRESET_IDS } from './types.js';

// --- Numerical Bounds & Fixed Constants ---
export const TARGET_LUFS_MIN = -30.0;
export const TARGET_LUFS_MAX = -10.0;
export const PEAK_CEILING_MIN = -6.0;
export const PEAK_CEILING_MAX = 0.0;
export const FIXED_TOLERANCE_LU = 0.25;
export const FIXED_MARGIN_DB = 0.3;

export const TICK_MIN = -240;
export const TICK_MAX = 240;
export const TICK_STEP_DB = 0.1;
export const GAIN_MIN_DB = -24.0;
export const GAIN_MAX_DB = 24.0;

export const WAV_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB = 8,388,608 bytes
export const WAV_SAMPLE_RATE = 48000;
export const WAV_DURATION_MIN_SEC = 1.0;
export const WAV_DURATION_MAX_SEC = 30.0;

/**
 * Helper to assert that a value is a plain non-null object.
 */
function assertPlainObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GainFrontError('INVALID_CONSTRAINTS', `Expected plain object for ${context}, received ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Rejects unexpected keys on an object.
 */
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
        allowedFields: allowedKeys,
      });
    }
  }
}

/**
 * Validates that a number is finite, or throws NON_FINITE_VALUE.
 */
export function assertFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number') {
    throw new GainFrontError('INVALID_CONSTRAINTS', `Field "${fieldName}" must be a number`);
  }
  if (!Number.isFinite(value)) {
    throw new GainFrontError('NON_FINITE_VALUE', `Field "${fieldName}" must be a finite number, received ${value}`, {
      field: fieldName,
      value: String(value),
    });
  }
  return value;
}

/**
 * Validates optimization constraints.
 * T ∈ [-30, -10], C ∈ [-6, 0], toleranceLu = 0.25, marginDb = 0.3
 */
export function validateConstraints(input: unknown): Constraints {
  const obj = assertPlainObject(input, 'Constraints');
  const allowedKeys = ['targetLufs', 'peakCeilingDbTp', 'toleranceLu', 'marginDb'] as const;
  assertNoUnknownFields(obj, allowedKeys, 'Constraints');

  const targetLufs = assertFiniteNumber(obj.targetLufs, 'targetLufs');
  if (targetLufs < TARGET_LUFS_MIN || targetLufs > TARGET_LUFS_MAX) {
    throw new GainFrontError(
      'INVALID_CONSTRAINTS',
      `targetLufs ${targetLufs} out of range [${TARGET_LUFS_MIN}, ${TARGET_LUFS_MAX}] LUFS`,
      { targetLufs, min: TARGET_LUFS_MIN, max: TARGET_LUFS_MAX },
    );
  }

  const peakCeilingDbTp = assertFiniteNumber(obj.peakCeilingDbTp, 'peakCeilingDbTp');
  if (peakCeilingDbTp < PEAK_CEILING_MIN || peakCeilingDbTp > PEAK_CEILING_MAX) {
    throw new GainFrontError(
      'INVALID_CONSTRAINTS',
      `peakCeilingDbTp ${peakCeilingDbTp} out of range [${PEAK_CEILING_MIN}, ${PEAK_CEILING_MAX}] dBTP`,
      { peakCeilingDbTp, min: PEAK_CEILING_MIN, max: PEAK_CEILING_MAX },
    );
  }

  const toleranceLu = assertFiniteNumber(obj.toleranceLu, 'toleranceLu');
  if (toleranceLu !== FIXED_TOLERANCE_LU) {
    throw new GainFrontError(
      'INVALID_CONSTRAINTS',
      `toleranceLu must be exactly ${FIXED_TOLERANCE_LU}, received ${toleranceLu}`,
      { toleranceLu, expected: FIXED_TOLERANCE_LU },
    );
  }

  const marginDb = assertFiniteNumber(obj.marginDb, 'marginDb');
  if (marginDb !== FIXED_MARGIN_DB) {
    throw new GainFrontError(
      'INVALID_CONSTRAINTS',
      `marginDb must be exactly ${FIXED_MARGIN_DB}, received ${marginDb}`,
      { marginDb, expected: FIXED_MARGIN_DB },
    );
  }

  return {
    targetLufs,
    peakCeilingDbTp,
    toleranceLu: FIXED_TOLERANCE_LU,
    marginDb: FIXED_MARGIN_DB,
  };
}

/**
 * Validates gain search tick.
 * tick ∈ [-240, 240] integer (step 0.1 dB corresponds to tick * 0.1)
 */
export function validateGainTick(tick: unknown): number {
  if (typeof tick !== 'number') {
    throw new GainFrontError('INVALID_TICK', `Gain tick must be a number, received ${typeof tick}`);
  }
  if (!Number.isFinite(tick)) {
    throw new GainFrontError('NON_FINITE_VALUE', `Gain tick must be finite, received ${tick}`, { tick: String(tick) });
  }
  if (!Number.isInteger(tick)) {
    throw new GainFrontError('INVALID_TICK', `Gain tick must be an integer, received ${tick}`, { tick });
  }
  if (tick < TICK_MIN || tick > TICK_MAX) {
    throw new GainFrontError(
      'INVALID_TICK',
      `Gain tick ${tick} out of range [${TICK_MIN}, ${TICK_MAX}]`,
      { tick, min: TICK_MIN, max: TICK_MAX },
    );
  }
  return tick;
}

/**
 * Converts tick index to gain in dB.
 */
export function tickToDb(tick: number): number {
  validateGainTick(tick);
  return Math.round(tick) * TICK_STEP_DB;
}

/**
 * Converts gain in dB to nearest integer tick.
 */
export function dbToTick(db: number): number {
  if (!Number.isFinite(db)) {
    throw new GainFrontError('NON_FINITE_VALUE', `db value must be finite, received ${db}`);
  }
  const tick = Math.round(db / TICK_STEP_DB);
  return validateGainTick(tick);
}

/**
 * Validates PresetId.
 */
export function validatePresetId(presetId: unknown): PresetId {
  if (typeof presetId !== 'string' || !PRESET_IDS.includes(presetId as PresetId)) {
    throw new GainFrontError('INVALID_PRESET_ID', `Invalid presetId: "${String(presetId)}"`, {
      presetId,
      allowed: PRESET_IDS,
    });
  }
  return presetId as PresetId;
}

/**
 * Validates SourceRef.
 */
export function validateSourceRef(input: unknown): SourceRef {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GainFrontError('INVALID_SOURCE_REF', `Expected object for SourceRef`);
  }
  const obj = input as Record<string, unknown>;

  if (obj.kind === 'preset') {
    assertNoUnknownFields(obj, ['kind', 'presetId'], 'SourceRef (preset)');
    const presetId = validatePresetId(obj.presetId);
    return { kind: 'preset', presetId };
  }

  if (obj.kind === 'externalWav') {
    assertNoUnknownFields(obj, ['kind', 'sha256Hex', 'fileName', 'requiresReselect', 'byteLength'], 'SourceRef (externalWav)');
    if (typeof obj.sha256Hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(obj.sha256Hex)) {
      throw new GainFrontError(
        'INVALID_SOURCE_REF',
        `externalWav requires valid 64-character sha256Hex, received "${String(obj.sha256Hex)}"`,
      );
    }
    if (obj.requiresReselect !== true) {
      throw new GainFrontError('INVALID_SOURCE_REF', `externalWav requiresReselect must be true`);
    }
    if (obj.fileName !== undefined && typeof obj.fileName !== 'string') {
      throw new GainFrontError('INVALID_SOURCE_REF', `externalWav fileName must be a string if provided`);
    }
    if (
      obj.byteLength !== undefined &&
      (typeof obj.byteLength !== 'number' ||
        !Number.isInteger(obj.byteLength) ||
        obj.byteLength <= 0)
    ) {
      throw new GainFrontError('INVALID_SOURCE_REF', `externalWav byteLength must be a positive integer if provided`);
    }
    return {
      kind: 'externalWav',
      sha256Hex: obj.sha256Hex.toLowerCase(),
      fileName: obj.fileName as string | undefined,
      requiresReselect: true,
      ...(obj.byteLength !== undefined ? { byteLength: obj.byteLength as number } : {}),
    };
  }

  throw new GainFrontError('INVALID_SOURCE_REF', `Invalid source kind: "${String(obj.kind)}"`);
}

/**
 * Validates WAV byte size constraint (<= 8 MiB).
 */
export function validateWavByteLength(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new GainFrontError('UNSUPPORTED_WAV', `Invalid WAV byteLength: ${byteLength}`);
  }
  if (byteLength > WAV_MAX_BYTES) {
    throw new GainFrontError(
      'OUT_OF_SCOPE',
      `WAV size ${byteLength} bytes exceeds 8MiB limit (${WAV_MAX_BYTES} bytes)`,
      { byteLength, maxBytes: WAV_MAX_BYTES },
    );
  }
}

/**
 * Validates decoded audio PCM metadata against GainFront short-audio preflight constraints.
 * 48kHz, mono/stereo (1|2), 1.0s to 30.0s.
 */
export function validatePcmMetadata(sampleRate: number, channels: number, frames: number): void {
  if (sampleRate !== WAV_SAMPLE_RATE) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      `Unsupported sample rate ${sampleRate}Hz. GainFront requires exactly ${WAV_SAMPLE_RATE}Hz.`,
      { sampleRate, expected: WAV_SAMPLE_RATE },
    );
  }
  if (channels !== 1 && channels !== 2) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      `Unsupported channels ${channels}. GainFront requires mono (1) or stereo (2).`,
      { channels, expected: [1, 2] },
    );
  }
  if (!Number.isFinite(frames) || frames <= 0) {
    throw new GainFrontError('UNSUPPORTED_WAV', `Invalid audio frame count: ${frames}`);
  }

  const durationSeconds = frames / sampleRate;
  if (durationSeconds < WAV_DURATION_MIN_SEC || durationSeconds > WAV_DURATION_MAX_SEC) {
    throw new GainFrontError(
      'OUT_OF_SCOPE',
      `Audio duration ${durationSeconds.toFixed(3)}s out of scope (requires ${WAV_DURATION_MIN_SEC}s - ${WAV_DURATION_MAX_SEC}s)`,
      { durationSeconds, frames, minSec: WAV_DURATION_MIN_SEC, maxSec: WAV_DURATION_MAX_SEC },
    );
  }
}

/**
 * Validates PCM object.
 */
export function validatePcm(input: unknown): PCM {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GainFrontError('INVALID_PCM', `Expected object for PCM`);
  }
  const obj = input as Record<string, unknown>;
  assertNoUnknownFields(obj, ['sampleRate', 'channels', 'frames', 'planar'], 'PCM');

  const sampleRate = obj.sampleRate as number;
  const channels = obj.channels as number;
  const frames = obj.frames as number;

  validatePcmMetadata(sampleRate, channels, frames);

  if (!Array.isArray(obj.planar) || obj.planar.length !== channels) {
    throw new GainFrontError(
      'INVALID_PCM',
      `PCM planar must be an array of length ${channels}, received length ${Array.isArray(obj.planar) ? obj.planar.length : typeof obj.planar}`,
    );
  }

  for (let ch = 0; ch < channels; ch++) {
    const channelData = obj.planar[ch];
    if (!(channelData instanceof Float64Array)) {
      throw new GainFrontError('INVALID_PCM', `Channel ${ch} data must be Float64Array`);
    }
    if (channelData.length !== frames) {
      throw new GainFrontError(
        'INVALID_PCM',
        `Channel ${ch} length ${channelData.length} does not match frame count ${frames}`,
      );
    }
  }

  return {
    sampleRate: 48000,
    channels: channels as 1 | 2,
    frames,
    planar: obj.planar as Float64Array[],
  };
}

/**
 * Sanitizes numeric values for JSON serialization.
 * Replaces NaN and Infinity with null.
 */
export function sanitizeFiniteNumber(val: number | null | undefined): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  return null;
}

/**
 * Validates or sanitizes a Measurement struct according to PROJECT_BOOK §8.1.
 * Non-finite numbers are serialized as null.
 */
export function sanitizeMeasurement(meas: Measurement): Measurement {
  return {
    integratedLufs: sanitizeFiniteNumber(meas.integratedLufs),
    samplePeakDbFs: sanitizeFiniteNumber(meas.samplePeakDbFs),
    estimatedTruePeakDbTp: sanitizeFiniteNumber(meas.estimatedTruePeakDbTp),
    samplePeakFrame: meas.samplePeakFrame !== null && Number.isInteger(meas.samplePeakFrame) && meas.samplePeakFrame >= 0
      ? meas.samplePeakFrame
      : null,
    estimatedPeakPosition: meas.estimatedPeakPosition
      ? {
          frame: meas.estimatedPeakPosition.frame,
          quarter: meas.estimatedPeakPosition.quarter,
          channel: meas.estimatedPeakPosition.channel,
        }
      : null,
    blockPowers: meas.blockPowers.map((p) => (Number.isFinite(p) ? p : 0)),
    absoluteGate: [...meas.absoluteGate],
    relativeGate: [...meas.relativeGate],
  };
}

/**
 * Validates that a PeakPosition struct is valid.
 */
export function validatePeakPosition(input: unknown): PeakPosition | null {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new GainFrontError('INVALID_MEASUREMENT', 'PeakPosition must be an object or null');
  }
  const obj = input as Record<string, unknown>;
  assertNoUnknownFields(obj, ['frame', 'quarter', 'channel'], 'PeakPosition');

  if (typeof obj.frame !== 'number' || !Number.isInteger(obj.frame) || obj.frame < 0) {
    throw new GainFrontError('INVALID_MEASUREMENT', `Invalid frame in PeakPosition: ${obj.frame}`);
  }
  if (obj.quarter !== 0 && obj.quarter !== 1 && obj.quarter !== 2 && obj.quarter !== 3) {
    throw new GainFrontError('INVALID_MEASUREMENT', `Invalid quarter in PeakPosition: ${obj.quarter} (expected 0, 1, 2, or 3)`);
  }
  if (obj.channel !== 0 && obj.channel !== 1) {
    throw new GainFrontError('INVALID_MEASUREMENT', `Invalid channel in PeakPosition: ${obj.channel} (expected 0 or 1)`);
  }

  return {
    frame: obj.frame,
    quarter: obj.quarter as 0 | 1 | 2 | 3,
    channel: obj.channel as 0 | 1,
  };
}

/**
 * Validates a Measurement object structure strictly.
 */
export function validateMeasurement(input: unknown): Measurement {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new GainFrontError('INVALID_MEASUREMENT', 'Expected object for Measurement');
  }
  const obj = input as Record<string, unknown>;
  const allowedKeys = [
    'integratedLufs',
    'samplePeakDbFs',
    'estimatedTruePeakDbTp',
    'samplePeakFrame',
    'estimatedPeakPosition',
    'blockPowers',
    'absoluteGate',
    'relativeGate',
  ] as const;
  assertNoUnknownFields(obj, allowedKeys, 'Measurement');

  const checkNullableFinite = (val: unknown, name: string): number | null => {
    if (val === null) return null;
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        throw new GainFrontError('NON_FINITE_VALUE', `Field "${name}" has non-finite value ${val}`);
      }
      return val;
    }
    throw new GainFrontError('INVALID_MEASUREMENT', `Field "${name}" must be number or null`);
  };

  const integratedLufs = checkNullableFinite(obj.integratedLufs, 'integratedLufs');
  const samplePeakDbFs = checkNullableFinite(obj.samplePeakDbFs, 'samplePeakDbFs');
  const estimatedTruePeakDbTp = checkNullableFinite(obj.estimatedTruePeakDbTp, 'estimatedTruePeakDbTp');

  let samplePeakFrame: number | null = null;
  if (obj.samplePeakFrame !== null) {
    if (typeof obj.samplePeakFrame !== 'number' || !Number.isInteger(obj.samplePeakFrame) || obj.samplePeakFrame < 0) {
      throw new GainFrontError('INVALID_MEASUREMENT', `samplePeakFrame must be a non-negative integer or null`);
    }
    samplePeakFrame = obj.samplePeakFrame;
  }

  const estimatedPeakPosition = validatePeakPosition(obj.estimatedPeakPosition);

  if (!Array.isArray(obj.blockPowers)) {
    throw new GainFrontError('INVALID_MEASUREMENT', 'blockPowers must be an array');
  }
  for (let i = 0; i < obj.blockPowers.length; i++) {
    const p = obj.blockPowers[i];
    if (typeof p !== 'number' || !Number.isFinite(p)) {
      throw new GainFrontError('NON_FINITE_VALUE', `blockPowers[${i}] must be finite number, received ${p}`);
    }
  }

  if (!Array.isArray(obj.absoluteGate)) {
    throw new GainFrontError('INVALID_MEASUREMENT', 'absoluteGate must be an array');
  }
  if (!Array.isArray(obj.relativeGate)) {
    throw new GainFrontError('INVALID_MEASUREMENT', 'relativeGate must be an array');
  }
  if (obj.absoluteGate.length !== obj.blockPowers.length || obj.relativeGate.length !== obj.blockPowers.length) {
    throw new GainFrontError(
      'INVALID_MEASUREMENT',
      `Gate arrays length mismatch: blockPowers=${obj.blockPowers.length}, absoluteGate=${obj.absoluteGate.length}, relativeGate=${obj.relativeGate.length}`,
    );
  }

  return {
    integratedLufs,
    samplePeakDbFs,
    estimatedTruePeakDbTp,
    samplePeakFrame,
    estimatedPeakPosition,
    blockPowers: obj.blockPowers as number[],
    absoluteGate: obj.absoluteGate as boolean[],
    relativeGate: obj.relativeGate as boolean[],
  };
}
