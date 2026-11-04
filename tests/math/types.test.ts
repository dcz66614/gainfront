import { describe, it, expect } from 'vitest';
import {
  // Types & constants
  STATUS_CODES,
  PRESET_IDS,
  TARGET_LUFS_MIN,
  TARGET_LUFS_MAX,
  PEAK_CEILING_MIN,
  PEAK_CEILING_MAX,
  FIXED_TOLERANCE_LU,
  FIXED_MARGIN_DB,
  TICK_MIN,
  TICK_MAX,
  WAV_MAX_BYTES,
  WAV_SAMPLE_RATE,
  WAV_DURATION_MIN_SEC,
  WAV_DURATION_MAX_SEC,
  // Errors
  GainFrontError,
  isGainFrontError,
  // Validation functions
  validateConstraints,
  validateGainTick,
  tickToDb,
  dbToTick,
  validatePresetId,
  validateSourceRef,
  validateWavByteLength,
  validatePcmMetadata,
  validatePcm,
  sanitizeFiniteNumber,
  sanitizeMeasurement,
  validatePeakPosition,
  validateMeasurement,
} from '../../src/core/index.js';
import type {
  Constraints,
  GainPoint,
  Measurement,
  PCM,
  PresetId,
  SolverResult,
  SourceRef,
  Status,
} from '../../src/core/index.js';
import {
  validateWorkerRequest,
  isWorkerRequest,
  isWorkerResponse,
  type WorkerRequest,
  type WorkerResponse,
} from '../../src/worker/protocol.js';

describe('P010-T002 Core Types & Status Contract', () => {
  it('freezes 6 exact Status codes matching Project Book §8.1', () => {
    const expectedStatuses: Status[] = [
      'GAIN_FEASIBLE',
      'GAIN_BLOCKED_PEAK_OR_RANGE',
      'NO_PROGRAM',
      'NO_SAFE_GAIN_IN_GRID',
      'UNSUPPORTED_WAV',
      'OUT_OF_SCOPE',
    ];
    expect(STATUS_CODES).toEqual(expectedStatuses);
    expect(STATUS_CODES).toHaveLength(6);
  });

  it('freezes 6 PresetId values GF-A through GF-F', () => {
    const expectedPresets: PresetId[] = ['GF-A', 'GF-B', 'GF-C', 'GF-D', 'GF-E', 'GF-F'];
    expect(PRESET_IDS).toEqual(expectedPresets);
    expect(PRESET_IDS).toHaveLength(6);
  });

  it('exports frozen numerical boundary constants per spec §4.3', () => {
    expect(TARGET_LUFS_MIN).toBe(-30.0);
    expect(TARGET_LUFS_MAX).toBe(-10.0);
    expect(PEAK_CEILING_MIN).toBe(-6.0);
    expect(PEAK_CEILING_MAX).toBe(0.0);
    expect(FIXED_TOLERANCE_LU).toBe(0.25);
    expect(FIXED_MARGIN_DB).toBe(0.3);
    expect(TICK_MIN).toBe(-240);
    expect(TICK_MAX).toBe(240);
    expect(WAV_SAMPLE_RATE).toBe(48000);
    expect(WAV_DURATION_MIN_SEC).toBe(1.0);
    expect(WAV_DURATION_MAX_SEC).toBe(30.0);
  });

  it('validates presetId strictly and rejects invalid presets', () => {
    expect(validatePresetId('GF-A')).toBe('GF-A');
    expect(validatePresetId('GF-F')).toBe('GF-F');

    expect(() => validatePresetId('GF-G')).toThrow(GainFrontError);
    expect(() => validatePresetId('GF-A ')).toThrow(GainFrontError);
    expect(() => validatePresetId('')).toThrow(GainFrontError);
    expect(() => validatePresetId(123)).toThrow(GainFrontError);

    try {
      validatePresetId('INVALID');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_PRESET_ID');
      }
    }
  });
});

describe('P010-T002 Constraints Validation', () => {
  const validConstraints: Constraints = {
    targetLufs: -16.0,
    peakCeilingDbTp: -1.0,
    toleranceLu: 0.25,
    marginDb: 0.3,
  };

  it('accepts valid baseline constraints', () => {
    const res = validateConstraints(validConstraints);
    expect(res).toEqual(validConstraints);
  });

  it('accepts boundary values for targetLufs [-30, -10]', () => {
    expect(validateConstraints({ ...validConstraints, targetLufs: -30.0 }).targetLufs).toBe(-30.0);
    expect(validateConstraints({ ...validConstraints, targetLufs: -10.0 }).targetLufs).toBe(-10.0);
  });

  it('rejects targetLufs out of range [-30, -10]', () => {
    expect(() => validateConstraints({ ...validConstraints, targetLufs: -30.001 })).toThrowError(
      /out of range/,
    );
    expect(() => validateConstraints({ ...validConstraints, targetLufs: -9.999 })).toThrowError(
      /out of range/,
    );

    try {
      validateConstraints({ ...validConstraints, targetLufs: -35 });
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_CONSTRAINTS');
      }
    }
  });

  it('accepts boundary values for peakCeilingDbTp [-6, 0]', () => {
    expect(validateConstraints({ ...validConstraints, peakCeilingDbTp: -6.0 }).peakCeilingDbTp).toBe(-6.0);
    expect(validateConstraints({ ...validConstraints, peakCeilingDbTp: 0.0 }).peakCeilingDbTp).toBe(0.0);
  });

  it('rejects peakCeilingDbTp out of range [-6, 0]', () => {
    expect(() => validateConstraints({ ...validConstraints, peakCeilingDbTp: -6.001 })).toThrow(GainFrontError);
    expect(() => validateConstraints({ ...validConstraints, peakCeilingDbTp: 0.001 })).toThrow(GainFrontError);
  });

  it('enforces fixed toleranceLu = 0.25', () => {
    expect(() => validateConstraints({ ...validConstraints, toleranceLu: 0.24 as 0.25 })).toThrow(GainFrontError);
    expect(() => validateConstraints({ ...validConstraints, toleranceLu: 0.5 as 0.25 })).toThrow(GainFrontError);
  });

  it('enforces fixed marginDb = 0.3', () => {
    expect(() => validateConstraints({ ...validConstraints, marginDb: 0.29 as 0.3 })).toThrow(GainFrontError);
    expect(() => validateConstraints({ ...validConstraints, marginDb: 0.5 as 0.3 })).toThrow(GainFrontError);
  });

  it('rejects unknown fields in constraints', () => {
    const extra = { ...validConstraints, hackerField: true };
    try {
      validateConstraints(extra);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('UNKNOWN_FIELD');
      }
    }
  });

  it('rejects non-finite values (NaN, Infinity, -Infinity) with NON_FINITE_VALUE', () => {
    try {
      validateConstraints({ ...validConstraints, targetLufs: NaN });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('NON_FINITE_VALUE');
      }
    }

    try {
      validateConstraints({ ...validConstraints, peakCeilingDbTp: Infinity });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('NON_FINITE_VALUE');
      }
    }
  });

  it('rejects non-object inputs', () => {
    expect(() => validateConstraints(null)).toThrow(GainFrontError);
    expect(() => validateConstraints(undefined)).toThrow(GainFrontError);
    expect(() => validateConstraints('string')).toThrow(GainFrontError);
    expect(() => validateConstraints([1, 2, 3])).toThrow(GainFrontError);
  });
});

describe('P010-T002 Gain Tick Validation & Conversion', () => {
  it('validates ticks in integer range [-240, 240]', () => {
    expect(validateGainTick(-240)).toBe(-240);
    expect(validateGainTick(0)).toBe(0);
    expect(validateGainTick(240)).toBe(240);
  });

  it('rejects tick outside [-240, 240]', () => {
    expect(() => validateGainTick(-241)).toThrow(GainFrontError);
    expect(() => validateGainTick(241)).toThrow(GainFrontError);
    try {
      validateGainTick(300);
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_TICK');
      }
    }
  });

  it('rejects non-integer ticks', () => {
    expect(() => validateGainTick(0.5)).toThrow(GainFrontError);
    expect(() => validateGainTick(-10.1)).toThrow(GainFrontError);
  });

  it('rejects non-finite ticks with NON_FINITE_VALUE', () => {
    try {
      validateGainTick(NaN);
      expect.unreachable();
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('NON_FINITE_VALUE');
      }
    }
  });

  it('converts tickToDb and dbToTick consistently', () => {
    expect(tickToDb(0)).toBeCloseTo(0.0);
    expect(tickToDb(10)).toBeCloseTo(1.0);
    expect(tickToDb(-60)).toBeCloseTo(-6.0);
    expect(tickToDb(240)).toBeCloseTo(24.0);
    expect(tickToDb(-240)).toBeCloseTo(-24.0);

    expect(dbToTick(0.0)).toBe(0);
    expect(dbToTick(1.0)).toBe(10);
    expect(dbToTick(-6.0)).toBe(-60);
    expect(dbToTick(24.0)).toBe(240);
    expect(dbToTick(-24.0)).toBe(-240);
  });
});

describe('P010-T002 SourceRef Validation', () => {
  it('validates preset source reference', () => {
    const validPreset: SourceRef = { kind: 'preset', presetId: 'GF-B' };
    expect(validateSourceRef(validPreset)).toEqual(validPreset);

    expect(() => validateSourceRef({ kind: 'preset', presetId: 'GF-Z' })).toThrow(GainFrontError);
    expect(() => validateSourceRef({ kind: 'preset', presetId: 'GF-A', extra: 1 })).toThrow(GainFrontError);
  });

  it('validates externalWav source reference', () => {
    const validHex = 'a'.repeat(64);
    const validExternal: SourceRef = {
      kind: 'externalWav',
      sha256Hex: validHex,
      fileName: 'test.wav',
      requiresReselect: true,
    };
    expect(validateSourceRef(validExternal)).toEqual(validExternal);

    // sha256Hex must be exactly 64 hex characters
    expect(() =>
      validateSourceRef({
        kind: 'externalWav',
        sha256Hex: 'short',
        requiresReselect: true,
      }),
    ).toThrow(GainFrontError);

    // requiresReselect must be true
    expect(() =>
      validateSourceRef({
        kind: 'externalWav',
        sha256Hex: validHex,
        requiresReselect: false,
      }),
    ).toThrow(GainFrontError);

    // Unknown field rejected
    expect(() =>
      validateSourceRef({
        kind: 'externalWav',
        sha256Hex: validHex,
        requiresReselect: true,
        extraData: 'malicious',
      }),
    ).toThrow(GainFrontError);
  });
});

describe('P010-T002 WAV / PCM Constraints & Scope Validation', () => {
  it('validates WAV byte length under 8MiB limit', () => {
    expect(() => validateWavByteLength(WAV_MAX_BYTES)).not.toThrow();
    expect(() => validateWavByteLength(1024)).not.toThrow();

    try {
      validateWavByteLength(WAV_MAX_BYTES + 1);
      expect.unreachable();
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('OUT_OF_SCOPE');
      }
    }
  });

  it('validates PCM metadata: 48000Hz, 1|2 channels, 1-30s duration', () => {
    // 1 second at 48k = 48000 frames
    expect(() => validatePcmMetadata(48000, 1, 48000)).not.toThrow();
    // 30 seconds at 48k = 1440000 frames
    expect(() => validatePcmMetadata(48000, 2, 1440000)).not.toThrow();

    // Unsupported sample rate
    try {
      validatePcmMetadata(44100, 2, 44100);
      expect.unreachable();
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('UNSUPPORTED_WAV');
      }
    }

    // Unsupported channel count (e.g. 5.1 surround)
    try {
      validatePcmMetadata(48000, 6, 48000);
      expect.unreachable();
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('UNSUPPORTED_WAV');
      }
    }

    // Out of scope duration: < 1.0s
    try {
      validatePcmMetadata(48000, 1, 47999);
      expect.unreachable();
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('OUT_OF_SCOPE');
      }
    }

    // Out of scope duration: > 30.0s
    try {
      validatePcmMetadata(48000, 2, 1440001);
      expect.unreachable();
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('OUT_OF_SCOPE');
      }
    }
  });

  it('validates full PCM structure', () => {
    const frames = 48000;
    const validPCM: PCM = {
      sampleRate: 48000,
      channels: 1,
      frames,
      planar: [new Float64Array(frames)],
    };
    expect(validatePcm(validPCM)).toEqual(validPCM);

    // Mismatched planar length
    expect(() =>
      validatePcm({
        sampleRate: 48000,
        channels: 2,
        frames,
        planar: [new Float64Array(frames)],
      }),
    ).toThrow(GainFrontError);

    // Non-Float64Array
    expect(() =>
      validatePcm({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [new Float32Array(frames)],
      }),
    ).toThrow(GainFrontError);
  });
});

describe('P010-T002 Measurement Validation & Sanitization', () => {
  const validMeasurement: Measurement = {
    integratedLufs: -20.5,
    samplePeakDbFs: -3.2,
    estimatedTruePeakDbTp: -2.8,
    samplePeakFrame: 12040,
    estimatedPeakPosition: {
      frame: 12040,
      quarter: 2,
      channel: 0,
    },
    blockPowers: [0.001, 0.002, 0.0015],
    absoluteGate: [true, true, true],
    relativeGate: [true, true, false],
  };

  it('validates correct Measurement structure', () => {
    expect(validateMeasurement(validMeasurement)).toEqual(validMeasurement);
  });

  it('rejects unknown fields in Measurement', () => {
    expect(() => validateMeasurement({ ...validMeasurement, extraField: 'bad' })).toThrow(GainFrontError);
  });

  it('rejects gate array length mismatch', () => {
    expect(() =>
      validateMeasurement({
        ...validMeasurement,
        relativeGate: [true, false], // length 2 vs blockPowers length 3
      }),
    ).toThrow(GainFrontError);
  });

  it('validates PeakPosition fields strictly', () => {
    expect(validatePeakPosition(null)).toBeNull();
    expect(
      validatePeakPosition({
        frame: 100,
        quarter: 3,
        channel: 1,
      }),
    ).toEqual({ frame: 100, quarter: 3, channel: 1 });

    // Invalid quarter (must be 0, 1, 2, or 3)
    expect(() => validatePeakPosition({ frame: 100, quarter: 4, channel: 0 })).toThrow(GainFrontError);
    // Invalid channel (must be 0 or 1)
    expect(() => validatePeakPosition({ frame: 100, quarter: 1, channel: 2 })).toThrow(GainFrontError);
    // Negative frame
    expect(() => validatePeakPosition({ frame: -1, quarter: 0, channel: 0 })).toThrow(GainFrontError);
  });

  it('sanitizes non-finite numbers to null for JSON safety', () => {
    expect(sanitizeFiniteNumber(NaN)).toBeNull();
    expect(sanitizeFiniteNumber(Infinity)).toBeNull();
    expect(sanitizeFiniteNumber(-Infinity)).toBeNull();
    expect(sanitizeFiniteNumber(null)).toBeNull();
    expect(sanitizeFiniteNumber(undefined)).toBeNull();
    expect(sanitizeFiniteNumber(-18.5)).toBe(-18.5);

    const nonFiniteMeas: Measurement = {
      integratedLufs: -Infinity,
      samplePeakDbFs: NaN,
      estimatedTruePeakDbTp: Infinity,
      samplePeakFrame: null,
      estimatedPeakPosition: null,
      blockPowers: [0.001, NaN],
      absoluteGate: [true, false],
      relativeGate: [false, false],
    };

    const sanitized = sanitizeMeasurement(nonFiniteMeas);
    expect(sanitized.integratedLufs).toBeNull();
    expect(sanitized.samplePeakDbFs).toBeNull();
    expect(sanitized.estimatedTruePeakDbTp).toBeNull();
    expect(sanitized.blockPowers).toEqual([0.001, 0]);
  });
});

describe('P010-T002 SolverResult & GainPoint Contracts', () => {
  it('conforms to SolverResult type contract', () => {
    const point: GainPoint = {
      tick: 0,
      integratedLufs: -16.0,
      estimatedTpDb: -1.2,
      peakEligible: true,
      levelErrorLu: 0.0,
    };

    const solverResult: SolverResult = {
      status: 'GAIN_FEASIBLE',
      gBestTick: 10,
      gTargetTick: 10,
      minimumGridDeviationLu: 0.05,
      peakBoundaryDb: -0.5,
      points: [point],
      witness: {
        reasons: ['Optimal gain +1.0 dB achieved within tolerance.'],
      },
    };

    expect(solverResult.status).toBe('GAIN_FEASIBLE');
    expect(solverResult.gBestTick).toBe(10);
    expect(solverResult.points).toHaveLength(1);
    expect(solverResult.witness.reasons).toHaveLength(1);
  });
});

describe('P010-T002 Worker Protocol Contract', () => {
  it('validates ANALYZE worker request with presetId', () => {
    const req: WorkerRequest = {
      type: 'ANALYZE',
      requestId: 1,
      presetId: 'GF-A',
      constraints: {
        targetLufs: -16,
        peakCeilingDbTp: -1,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
    };

    expect(isWorkerRequest(req)).toBe(true);
    expect(validateWorkerRequest(req)).toEqual(req);
  });

  it('validates ANALYZE worker request with wavBytes ArrayBuffer', () => {
    const buffer = new ArrayBuffer(1024);
    const req: WorkerRequest = {
      type: 'ANALYZE',
      requestId: 2,
      wavBytes: buffer,
      constraints: {
        targetLufs: -14,
        peakCeilingDbTp: -0.5,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
    };

    expect(isWorkerRequest(req)).toBe(true);
    const validated = validateWorkerRequest(req);
    expect(validated.type).toBe('ANALYZE');
    expect(validated.requestId).toBe(2);
  });

  it('validates CANCEL worker request', () => {
    const req: WorkerRequest = {
      type: 'CANCEL',
      requestId: 3,
    };

    expect(isWorkerRequest(req)).toBe(true);
    expect(validateWorkerRequest(req)).toEqual(req);
  });

  it('rejects invalid worker requests', () => {
    expect(isWorkerRequest(null)).toBe(false);
    expect(isWorkerRequest({ type: 'UNKNOWN', requestId: 1 })).toBe(false);
    expect(isWorkerRequest({ type: 'ANALYZE', requestId: -1 })).toBe(false);
    expect(
      isWorkerRequest({
        type: 'ANALYZE',
        requestId: 1,
        // missing presetId and wavBytes
        constraints: { targetLufs: -16, peakCeilingDbTp: -1, toleranceLu: 0.25, marginDb: 0.3 },
      }),
    ).toBe(false);
  });

  it('identifies valid worker responses via isWorkerResponse', () => {
    const progressResp: WorkerResponse = {
      type: 'PROGRESS',
      requestId: 1,
      payload: { phase: 'FILTERING_K', percent: 40, message: 'Filtering K-weight' },
    };
    expect(isWorkerResponse(progressResp)).toBe(true);

    const errorResp: WorkerResponse = {
      type: 'ERROR',
      requestId: 1,
      payload: { code: 'UNSUPPORTED_WAV', message: 'Not 48kHz' },
    };
    expect(isWorkerResponse(errorResp)).toBe(true);

    expect(isWorkerResponse({ type: 'FOO', requestId: 1 })).toBe(false);
    expect(isWorkerResponse(null)).toBe(false);
  });
});

describe('P010-T002 GainFrontError Structure', () => {
  it('instantiates properly with stable code, message, and details', () => {
    const err = new GainFrontError('UNSUPPORTED_WAV', 'Sample rate 44100 not supported', {
      sampleRate: 44100,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GainFrontError);
    expect(err.name).toBe('GainFrontError');
    expect(err.code).toBe('UNSUPPORTED_WAV');
    expect(err.message).toBe('Sample rate 44100 not supported');
    expect(err.details).toEqual({ sampleRate: 44100 });

    const json = err.toJSON();
    expect(json.name).toBe('GainFrontError');
    expect(json.code).toBe('UNSUPPORTED_WAV');
    expect(json.message).toBe('Sample rate 44100 not supported');
    expect(json.details).toEqual({ sampleRate: 44100 });
  });
});
