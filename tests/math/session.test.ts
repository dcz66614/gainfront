/**
 * Tests for GainFront Session Engine (P010-T009)
 *
 * Verifies:
 * - Schema name fixed to gainfront.session/1, projectId P010, specVersion 1.0.0; no silent migration
 * - 128 KiB JSON size limit enforcement on save and load
 * - No audio samples or raw planar buffers stored in session JSON
 * - External WAV metadata and SHA-256 rebinding
 * - Strict rejection on replaced, renamed, or modified external files
 * - Untrusted audit cache: authoritative verification ignores cached audit conclusions
 * - Item-by-item round-trip consistency between original and reloaded sessions
 * - Cryptographic SHA-256 NIST vectors and parity
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeSource } from '../../src/core/analyze.js';
import { GainFrontError, isGainFrontError } from '../../src/core/errors.js';
import {
  computeSha256,
  computeSha256Sync,
  createSession,
  createSessionFromAnalysis,
  exportSession,
  loadSession,
  parseSession,
  rebindExternalWav,
  rebindSession,
  saveSession,
  SESSION_MAX_BYTES,
  SESSION_SCHEMA,
  validateSession,
  verifySessionAudio,
} from '../../src/core/session.js';
import type { Constraints, PCM } from '../../src/core/types.js';
import { PRESET_IDS } from '../../src/core/types.js';
import { encodePcm16Wav } from '../../src/core/wav.js';

describe('P010-T009 Cryptographic SHA-256 Determinism', () => {
  it('matches standard NIST test vectors synchronously and asynchronously', async () => {
    const vectors = [
      {
        input: '',
        expected: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      {
        input: 'abc',
        expected: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
      {
        input: 'The quick brown fox jumps over the lazy dog',
        expected: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
      },
    ];

    for (const v of vectors) {
      const syncHash = computeSha256Sync(v.input);
      const asyncHash = await computeSha256(v.input);

      expect(syncHash).toBe(v.expected);
      expect(asyncHash).toBe(v.expected);
    }
  });

  it('computes identical hashes for ArrayBuffer, Uint8Array, and byte slices', async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sync1 = computeSha256Sync(raw);
    const sync2 = computeSha256Sync(raw.buffer);
    const async1 = await computeSha256(raw);

    expect(sync1).toBe(sync2);
    expect(sync1).toBe(async1);
  });
});

describe('P010-T009 Session Schema & Strict Version Validation', () => {
  const validConstraints: Constraints = {
    targetLufs: -16.0,
    peakCeilingDbTp: -1.0,
    toleranceLu: 0.25,
    marginDb: 0.3,
  };

  it('validates and parses a conforming preset session', () => {
    const session = createSession({
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
    });

    expect(session.schema).toBe(SESSION_SCHEMA);
    expect(session.projectId).toBe('P010');
    expect(session.specVersion).toBe('1.0.0');
    expect(session.synthetic).toBe(true);
    expect(session.source).toEqual({ kind: 'preset', presetId: 'GF-A' });

    const json = exportSession(session);
    const parsed = parseSession(json);
    expect(parsed).toEqual(session);
  });

  it('rejects invalid schema version without silent migration', () => {
    const raw = {
      schema: 'gainfront.session/2',
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
    };

    expect(() => validateSession(raw)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );
    expect(() => parseSession(JSON.stringify(raw))).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );
  });

  it('rejects invalid projectId or specVersion', () => {
    const base = {
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
    };

    expect(() => validateSession({ ...base, projectId: 'P999' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );
    expect(() => validateSession({ ...base, specVersion: '2.0.0' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );
  });

  it('rejects synthetic flag mismatch', () => {
    const basePreset = {
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: false, // Illegal for preset
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
    };
    expect(() => validateSession(basePreset)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );

    const baseExternal = {
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true, // Illegal for external WAV
      source: {
        kind: 'externalWav',
        sha256Hex: '0'.repeat(64),
        requiresReselect: true,
      },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
    };
    expect(() => validateSession(baseExternal)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );
  });

  it('rejects unknown root and nested fields strictly', () => {
    const base = {
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
    };

    expect(() => validateSession({ ...base, unexpectedField: 'injection' })).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_FIELD' }),
    );

    expect(() =>
      validateSession({
        ...base,
        view: { selectedGainTick: 0, showBlockGates: true, extraKey: 123 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_FIELD' }));
  });

  it('rejects non-finite values (NaN and Infinity)', () => {
    const base = {
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: { ...validConstraints, targetLufs: Number.NaN },
      view: { selectedGainTick: 0, showBlockGates: true },
    };

    expect(() => validateSession(base)).toThrowError(
      expect.objectContaining({ code: 'NON_FINITE_VALUE' }),
    );

    const baseInf = {
      ...base,
      constraints: { ...validConstraints, targetLufs: Number.POSITIVE_INFINITY },
    };
    expect(() => validateSession(baseInf)).toThrowError(
      expect.objectContaining({ code: 'NON_FINITE_VALUE' }),
    );
  });
});

describe('P010-T009 128 KiB Size Limit Enforcement', () => {
  const validConstraints: Constraints = {
    targetLufs: -16.0,
    peakCeilingDbTp: -1.0,
    toleranceLu: 0.25,
    marginDb: 0.3,
  };

  it('accepts sessions within 128 KiB limit', () => {
    const session = createSession({
      source: { kind: 'preset', presetId: 'GF-B' },
      constraints: validConstraints,
    });
    const exported = exportSession(session);
    const byteLen = new TextEncoder().encode(exported).length;

    expect(byteLen).toBeLessThanOrEqual(SESSION_MAX_BYTES);
    expect(() => parseSession(exported)).not.toThrow();
  });

  it('rejects serialization if session exceeds 128 KiB', () => {
    // Generate a long methodNotes string that pushes session beyond 128 KiB
    const bloatedNotes = 'x'.repeat(130 * 1024);
    const session = createSession({
      source: { kind: 'preset', presetId: 'GF-B' },
      constraints: validConstraints,
      methodNotes: bloatedNotes,
    });

    try {
      exportSession(session);
      expect.unreachable('Should have rejected oversized session export');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_SESSION');
        expect(err.message).toContain('128KiB');
      }
    }
  });

  it('rejects deserialization if input JSON string exceeds 128 KiB', () => {
    const oversizedJson = JSON.stringify({
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: validConstraints,
      view: { selectedGainTick: 0, showBlockGates: true },
      methodNotes: 'z'.repeat(130 * 1024),
    });

    expect(new TextEncoder().encode(oversizedJson).length).toBeGreaterThan(SESSION_MAX_BYTES);

    try {
      parseSession(oversizedJson);
      expect.unreachable('Should have rejected oversized input JSON');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_SESSION');
        expect(err.message).toContain('128KiB');
      }
    }
  });
});

describe('P010-T009 Absence of Audio Samples in Session JSON', () => {
  it('guarantees exported session JSON contains no audio samples or planar arrays', () => {
    const report = analyzeSource({
      presetId: 'GF-A',
      constraints: {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
    });

    const session = createSessionFromAnalysis(report, { includeAudit: true });
    const jsonStr = exportSession(session);

    // Strict string scanning: no planar or sample fields
    expect(jsonStr).not.toContain('"planar"');
    expect(jsonStr).not.toContain('"samples"');
    expect(jsonStr).not.toContain('"audioData"');
    expect(jsonStr).not.toContain('"blockPowers"');

    // Deserialized object checks
    const parsed = parseSession(jsonStr);
    expect((parsed as unknown as Record<string, unknown>).pcm).toBeUndefined();
    expect((parsed as unknown as Record<string, unknown>).planar).toBeUndefined();
    if (parsed.audit?.measurement) {
      expect((parsed.audit.measurement as unknown as Record<string, unknown>).blockPowers).toBeUndefined();
    }
  });

  it('rejects injected audio sample structures on validation', () => {
    const tampered = {
      schema: SESSION_SCHEMA,
      projectId: 'P010',
      specVersion: '1.0.0',
      synthetic: true,
      source: { kind: 'preset', presetId: 'GF-A' },
      constraints: {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
      view: { selectedGainTick: 0, showBlockGates: true },
      samples: [0.1, 0.2, 0.3], // Injected raw audio
    };

    expect(() => validateSession(tampered)).toThrowError(GainFrontError);
  });
});

describe('P010-T009 External WAV Rebinding & Tamper Resistance', () => {
  // Helper to generate a genuine 1-second 48kHz mono PCM WAV for testing
  function createTestWav(freq = 1000, amp = 0.2): { wavBytes: ArrayBuffer; sha256Hex: string } {
    const frames = 48000;
    const planar = [new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = amp * Math.sin((2 * Math.PI * freq * i) / 48000);
    }
    const pcm: PCM = {
      sampleRate: 48000,
      channels: 1,
      frames,
      planar,
    };
    const wavBytes = encodePcm16Wav(pcm);
    const sha256Hex = computeSha256Sync(wavBytes);
    return { wavBytes, sha256Hex };
  }

  const testConstraints: Constraints = {
    targetLufs: -20.0,
    peakCeilingDbTp: -1.0,
    toleranceLu: 0.25,
    marginDb: 0.3,
  };

  it('successfully rebinds an external WAV matching hash, metadata, and fileName', () => {
    const { wavBytes, sha256Hex } = createTestWav(1000, 0.2);
    const fileName = 'speech.wav';

    const session = createSession({
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName,
        requiresReselect: true,
      },
      constraints: testConstraints,
      inputSummary: {
        fileName,
        sampleRate: 48000,
        channels: 1,
        frames: 48000,
        byteLength: wavBytes.byteLength,
        sha256Hex,
      },
    });

    const rebindResult = rebindExternalWav(session, wavBytes, { fileName });

    expect(rebindResult.verifiedSha256Hex).toBe(sha256Hex);
    expect(rebindResult.measurement.integratedLufs).not.toBeNull();
    expect(rebindResult.solver.status).toBeDefined();
    expect(rebindResult.report.synthetic).toBe(false);
  });

  it('rejects rebinding when file content is modified (改动拒绝)', () => {
    const { wavBytes, sha256Hex } = createTestWav(1000, 0.2);
    const fileName = 'speech.wav';

    const session = createSession({
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName,
        requiresReselect: true,
      },
      constraints: testConstraints,
    });

    // Tamper with one single byte in the audio data section
    const tamperedBytes = wavBytes.slice(0);
    const view = new Uint8Array(tamperedBytes);
    view[view.length - 10] ^= 0x01; // flip 1 bit

    try {
      rebindExternalWav(session, tamperedBytes, { fileName });
      expect.unreachable('Should have rejected modified WAV file');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_SESSION');
        expect(err.message).toContain('SHA-256 hash mismatch');
      }
    }
  });

  it('rejects rebinding when file is replaced with a different file (替换拒绝)', () => {
    const { sha256Hex } = createTestWav(1000, 0.2);
    const { wavBytes: differentWav } = createTestWav(440, 0.5); // completely different sound
    const fileName = 'original.wav';

    const session = createSession({
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName,
        requiresReselect: true,
      },
      constraints: testConstraints,
    });

    try {
      rebindExternalWav(session, differentWav, { fileName });
      expect.unreachable('Should have rejected replaced WAV file');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_SESSION');
        expect(err.message).toContain('Refusing to load modified or replaced audio file');
      }
    }
  });

  it('rejects rebinding when file is renamed (改名拒绝)', () => {
    const { wavBytes, sha256Hex } = createTestWav(1000, 0.2);
    const recordedName = 'master_track_v1.wav';
    const renamedFile = 'master_track_v2_final.wav';

    const session = createSession({
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName: recordedName,
        requiresReselect: true,
      },
      constraints: testConstraints,
      inputSummary: {
        fileName: recordedName,
        sampleRate: 48000,
        channels: 1,
        frames: 48000,
        byteLength: wavBytes.byteLength,
        sha256Hex,
      },
    });

    try {
      rebindExternalWav(session, wavBytes, { fileName: renamedFile });
      expect.unreachable('Should have rejected renamed WAV file');
    } catch (err) {
      expect(isGainFrontError(err)).toBe(true);
      if (isGainFrontError(err)) {
        expect(err.code).toBe('INVALID_SESSION');
        expect(err.message).toContain('File name mismatch');
        expect(err.message).toContain('Renamed file rejected');
      }
    }
  });

  it('rejects rebinding when external WAV audio buffer is missing', () => {
    const { sha256Hex } = createTestWav(1000, 0.2);
    const session = createSession({
      source: {
        kind: 'externalWav',
        sha256Hex,
        fileName: 'audio.wav',
        requiresReselect: true,
      },
      constraints: testConstraints,
    });

    expect(() => rebindSession(session)).toThrowError(
      expect.objectContaining({ code: 'SOURCE_REQUIRED' }),
    );
  });
});

describe('P010-T009 Untrusted Audit Cache & Fresh Verification', () => {
  it('never trusts cached audit conclusions upon loading and rebinding', () => {
    const report = analyzeSource({
      presetId: 'GF-B',
      constraints: {
        targetLufs: -20.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      },
    });

    // Deliberately falsify / poison the audit conclusions
    const falsifiedSession = createSessionFromAnalysis(report, {
      includeAudit: true,
    });
    falsifiedSession.audit = {
      measurement: {
        integratedLufs: 99.9, // Impossible bogus value
        samplePeakDbFs: 10.0,
        estimatedTruePeakDbTp: 15.0,
      },
      solver: {
        status: 'GAIN_FEASIBLE',
        gBestTick: 123,
      },
    };

    // Export and parse to simulate loading external JSON
    const json = exportSession(falsifiedSession);
    const loaded = parseSession(json);

    // Verify: parseSession preserves the raw audit object for inspection
    expect(loaded.audit?.measurement?.integratedLufs).toBe(99.9);

    // Authoritative rebinding MUST IGNORE cached audit conclusions and compute true math
    const result = rebindSession(loaded);
    expect(result.measurement.integratedLufs).not.toBe(99.9);
    expect(result.measurement.integratedLufs).toBeCloseTo(report.measurement.integratedLufs!, 5);
    expect(result.solver.status).toBe(report.solver.status);
    expect(result.solver.gBestTick).toBe(report.solver.gBestTick);
  });
});

describe('P010-T009 Round-Trip Consistency (往返一致)', () => {
  it('preserves measurement and solver results across save -> load -> rebind for presets', () => {
    for (const presetId of ['GF-A', 'GF-B'] as const) {
      const constraints: Constraints = {
        targetLufs: -18.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      // 1. Initial authoritative analysis
      const originalReport = analyzeSource({ presetId, constraints });

      // 2. Export to session JSON
      const session = createSessionFromAnalysis(originalReport);
      const jsonStr = saveSession(session);

      // 3. Load from session JSON
      const loadedSession = loadSession(jsonStr);

      // 4. Re-verify audio
      const reloadedReport = verifySessionAudio(loadedSession);

      // 5. Item-by-item comparison
      if (originalReport.measurement.integratedLufs === null) {
        expect(reloadedReport.measurement.integratedLufs).toBeNull();
      } else {
        expect(reloadedReport.measurement.integratedLufs).toBeCloseTo(
          originalReport.measurement.integratedLufs,
          6,
        );
      }

      if (originalReport.measurement.samplePeakDbFs === null) {
        expect(reloadedReport.measurement.samplePeakDbFs).toBeNull();
      } else {
        expect(reloadedReport.measurement.samplePeakDbFs).toBeCloseTo(
          originalReport.measurement.samplePeakDbFs,
          6,
        );
      }

      if (originalReport.measurement.estimatedTruePeakDbTp === null) {
        expect(reloadedReport.measurement.estimatedTruePeakDbTp).toBeNull();
      } else {
        expect(reloadedReport.measurement.estimatedTruePeakDbTp).toBeCloseTo(
          originalReport.measurement.estimatedTruePeakDbTp,
          6,
        );
      }

      expect(reloadedReport.solver.status).toBe(originalReport.solver.status);
      expect(reloadedReport.solver.gBestTick).toBe(originalReport.solver.gBestTick);
      expect(reloadedReport.solver.gTargetTick).toBe(originalReport.solver.gTargetTick);

      if (originalReport.solver.minimumGridDeviationLu === null) {
        expect(reloadedReport.solver.minimumGridDeviationLu).toBeNull();
      } else {
        expect(reloadedReport.solver.minimumGridDeviationLu).toBeCloseTo(
          originalReport.solver.minimumGridDeviationLu,
          6,
        );
      }

      if (originalReport.solver.peakBoundaryDb === null) {
        expect(reloadedReport.solver.peakBoundaryDb).toBeNull();
      } else {
        expect(reloadedReport.solver.peakBoundaryDb).toBeCloseTo(
          originalReport.solver.peakBoundaryDb,
          6,
        );
      }
    }
  });

  it('preserves measurement and solver results across save -> load -> rebind for external WAV', () => {
    const frames = 48000 * 2; // 2 seconds
    const planar = [new Float64Array(frames), new Float64Array(frames)];
    for (let i = 0; i < frames; i++) {
      planar[0][i] = 0.15 * Math.sin((2 * Math.PI * 440 * i) / 48000);
      planar[1][i] = 0.15 * Math.cos((2 * Math.PI * 440 * i) / 48000);
    }
    const pcm: PCM = { sampleRate: 48000, channels: 2, frames, planar };
    const wavBytes = encodePcm16Wav(pcm);
    const sha256Hex = computeSha256Sync(wavBytes);
    const fileName = 'stereo_synth.wav';

    const constraints: Constraints = {
      targetLufs: -20.0,
      peakCeilingDbTp: -2.0,
      toleranceLu: 0.25,
      marginDb: 0.3,
    };

    // 1. Initial analysis
    const originalReport = analyzeSource({
      wavBytes,
      constraints,
      fileName,
      sha256Hex,
    });

    // 2. Export session
    const session = createSessionFromAnalysis(originalReport, {
      fileName,
      byteLength: wavBytes.byteLength,
    });
    const jsonStr = exportSession(session);

    // 3. Load session
    const loadedSession = parseSession(jsonStr);

    // 4. Rebind with WAV
    const rebindResult = rebindExternalWav(loadedSession, wavBytes, { fileName });
    const reloadedReport = rebindResult.report;

    // 5. Item-by-item comparison
    expect(reloadedReport.measurement.integratedLufs).toBeCloseTo(
      originalReport.measurement.integratedLufs!,
      6,
    );
    expect(reloadedReport.measurement.samplePeakDbFs).toBeCloseTo(
      originalReport.measurement.samplePeakDbFs!,
      6,
    );
    expect(reloadedReport.measurement.estimatedTruePeakDbTp).toBeCloseTo(
      originalReport.measurement.estimatedTruePeakDbTp!,
      6,
    );
    expect(reloadedReport.solver.status).toBe(originalReport.solver.status);
    expect(reloadedReport.solver.gBestTick).toBe(originalReport.solver.gBestTick);
    expect(reloadedReport.solver.gTargetTick).toBe(originalReport.solver.gTargetTick);
  });
});

describe('P010-T009 Project Book Fixtures Verification', () => {
  it('successfully parses all 6 preset fixtures strictly adhering to contract', () => {
    for (const presetId of PRESET_IDS) {
      const filePath = resolve(__dirname, '../fixtures', `${presetId}.json`);
      const content = readFileSync(filePath, 'utf-8');

      const parsed = parseSession(content);

      expect(parsed.schema).toBe(SESSION_SCHEMA);
      expect(parsed.projectId).toBe('P010');
      expect(parsed.specVersion).toBe('1.0.0');
      expect(parsed.synthetic).toBe(true);
      expect(parsed.source.kind).toBe('preset');
      if (parsed.source.kind === 'preset') {
        expect(parsed.source.presetId).toBe(presetId);
      }
    }
  });
});
