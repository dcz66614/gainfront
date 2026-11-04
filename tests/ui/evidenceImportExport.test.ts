import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatEvidenceMetrics,
  EVIDENCE_DISCLAIMER_TEXT,
} from '../../src/ui/EvidencePanel.js';
import {
  handleExportSession,
  handleImportSessionJson,
  handleRebindWav,
  verifyExternalWavForRebind,
  validateAndDecodeDirectWav,
  IMPORT_EXPORT_DISCLAIMER_TEXT,
  IMPORT_EXPORT_PRIVACY_TEXT,
} from '../../src/ui/ImportExport.js';
import { makePreset } from '../../src/core/presets.js';
import { analyzeSource } from '../../src/core/analyze.js';
import {
  computeSha256Sync,
  createSession,
  exportSession,
  parseSession,
  SESSION_MAX_BYTES,
  SESSION_SCHEMA,
} from '../../src/core/session.js';
import { encodePcm16Wav } from '../../src/core/wav.js';
import type { AnalysisReport, Constraints, PCM, Session } from '../../src/core/types.js';

// Helper to create valid 48kHz 16-bit mono test WAV buffer
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

describe('P010-T014 EvidencePanel & ImportExport Contracts', () => {
  describe('EvidencePanel Component & Numerical Verification', () => {
    it('verifies GF-A (Peak Trap): gBest 0.6, gTarget 7.0, deviation 6.4005, boundary 0.60 matches solver', () => {
      const pcmA = makePreset('GF-A');
      const constraints: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const report = analyzeSource({
        pcm: pcmA,
        constraints,
        source: { kind: 'preset', presetId: 'GF-A' },
      });

      const metrics = formatEvidenceMetrics(report);

      // Status GAIN_BLOCKED_PEAK_OR_RANGE
      expect(metrics.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
      expect(metrics.isFeasible).toBe(false);

      // Numerical verification matches Task Card & Solver
      // gBest: tick 6 => 0.6 dB
      expect(metrics.gBestNum).toBeCloseTo(0.6, 1);
      expect(metrics.gBestText).toBe('+0.6 dB');

      // gTarget: tick 70 => 7.0 dB
      expect(metrics.gTargetNum).toBeCloseTo(7.0, 1);
      expect(metrics.gTargetText).toBe('+7.0 dB');

      // Deviation: minimumGridDeviationLu ~ 6.4005 LU
      expect(metrics.deviationNum).not.toBeNull();
      expect(metrics.deviationNum!).toBeCloseTo(6.4005, 3);
      expect(metrics.deviationText).toContain('6.4005');

      // Boundary: peakBoundaryDb = C - margin - TP0 = -1 - 0.3 - (-1.94) = 0.64 -> 0.60 dB
      expect(metrics.peakBoundaryNum).not.toBeNull();
      expect(metrics.peakBoundaryNum!).toBeCloseTo(0.60, 2);
      expect(metrics.peakBoundaryText).toBe('0.60 dB');

      // Sample peak frame and estimated peak position
      expect(metrics.samplePeakFrameNum).toBe(192000);
      expect(metrics.samplePeakFrameText).toBe('帧 192000');
      expect(report.measurement.estimatedPeakPosition).toEqual({
        frame: 192000,
        quarter: 0,
        channel: 0,
      });
      expect(metrics.estimatedPeakPositionText).toContain('帧 192000');
      expect(metrics.estimatedPeakPositionText).toContain('1/4点: 0');

      // Witness reasons explain peak violation
      expect(metrics.witnessReasons.length).toBeGreaterThan(0);
      expect(metrics.witnessReasons[0]).toContain('cannot be satisfied within safe peak margin');
      expect(metrics.witnessReasons[0]).toContain('Unconstrained target candidate is 7.0 dB');
      expect(metrics.witnessReasons[0]).toContain('Best safe candidate is 0.6 dB');

      // Constraints values
      expect(metrics.targetLufsText).toBe('-16.0 LUFS');
      expect(metrics.peakCeilingText).toBe('-1.0 dBTP');
      expect(metrics.toleranceText).toBe('±0.25 LU');
      expect(metrics.marginText).toBe('0.30 dB');
      expect(metrics.effectiveCeilingText).toBe('-1.30 dBTP');
    });

    it('verifies GF-B (Safe Gain): status GAIN_FEASIBLE, deviation 0.0000 LU', () => {
      const pcmB = makePreset('GF-B');
      const constraints: Constraints = {
        targetLufs: -20.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const report = analyzeSource({
        pcm: pcmB,
        constraints,
        source: { kind: 'preset', presetId: 'GF-B' },
      });

      const metrics = formatEvidenceMetrics(report);

      expect(metrics.status).toBe('GAIN_FEASIBLE');
      expect(metrics.isFeasible).toBe(true);
      expect(metrics.gBestNum).toBeCloseTo(3.0, 1);
      expect(metrics.gTargetNum).toBeCloseTo(3.0, 1);
      expect(metrics.deviationNum).not.toBeNull();
      expect(metrics.deviationNum!).toBeLessThanOrEqual(constraints.toleranceLu);
      expect(metrics.deviationNum!).toBeCloseTo(0.0036, 3);
      expect(metrics.witnessReasons[0]).toContain('is feasible at 3.0 dB gain');
    });

    it('verifies GF-E (Below Gate): status NO_PROGRAM with withheld recommendation', () => {
      const pcmE = makePreset('GF-E');
      const constraints: Constraints = {
        targetLufs: -20.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const report = analyzeSource({
        pcm: pcmE,
        constraints,
        source: { kind: 'preset', presetId: 'GF-E' },
      });

      const metrics = formatEvidenceMetrics(report);

      expect(metrics.status).toBe('NO_PROGRAM');
      expect(metrics.isFeasible).toBe(false);
      expect(metrics.gBestNum).toBeNull();
      expect(metrics.gBestText).toBe('无推荐增益');
      expect(metrics.witnessReasons[0]).toContain('NO_PROGRAM');
    });

    it('ensures permanent disclaimer is immutable and contains required keywords', () => {
      expect(EVIDENCE_DISCLAIMER_TEXT).toContain('4×');
      expect(EVIDENCE_DISCLAIMER_TEXT).toContain('sinc');
      expect(EVIDENCE_DISCLAIMER_TEXT).toContain('0.30 dB');
      expect(EVIDENCE_DISCLAIMER_TEXT).toContain('非 ITU-R BS.1770 Annex 2 认证');
      expect(EVIDENCE_DISCLAIMER_TEXT).toContain('仅供参考');
    });
  });

  describe('ImportExport Session Export & Roundtrip Verification', () => {
    it('exports session to strictly conforming gainfront.session/1 JSON and parses back identically', () => {
      const pcmA = makePreset('GF-A');
      const constraints: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const report = analyzeSource({
        pcm: pcmA,
        constraints,
        source: { kind: 'preset', presetId: 'GF-A' },
      });

      // Export using ImportExport helper (reuses T009 exportSession)
      const exportedJson = handleExportSession(report);

      // Verify serialized length <= 128 KiB
      const byteLength = new TextEncoder().encode(exportedJson).length;
      expect(byteLength).toBeLessThanOrEqual(SESSION_MAX_BYTES);

      // Parse back using parseSession
      const parsedSession = parseSession(exportedJson);

      expect(parsedSession.schema).toBe(SESSION_SCHEMA);
      expect(parsedSession.projectId).toBe('P010');
      expect(parsedSession.specVersion).toBe('1.0.0');
      expect(parsedSession.synthetic).toBe(true);
      expect(parsedSession.source).toEqual({ kind: 'preset', presetId: 'GF-A' });
      expect(parsedSession.constraints).toEqual(constraints);

      // Audit cache verification: must not leak 77 block powers in JSON
      const rawParsed = JSON.parse(exportedJson);
      if (rawParsed.audit?.measurement) {
        expect(rawParsed.audit.measurement.blockPowers).toBeUndefined();
      }
    });

    it('rejects export when report is null with clear error', () => {
      expect(() => handleExportSession(null as unknown as AnalysisReport)).toThrow(
        '当前无有效分析报告',
      );
    });

    it('imports preset session and rebinds fresh report deterministically without external WAV', () => {
      const fixturePath = resolve(__dirname, '../fixtures/GF-B.json');
      const fixtureJson = readFileSync(fixturePath, 'utf8');

      const importResult = handleImportSessionJson(fixtureJson);

      expect(importResult.requiresWavRebind).toBe(false);
      expect(importResult.presetReport).toBeDefined();
      expect(importResult.presetReport!.source).toEqual({ kind: 'preset', presetId: 'GF-B' });
      expect(importResult.presetReport!.solver.status).toBe('GAIN_FEASIBLE');
    });
  });

  describe('External WAV Rebinding Security & Old Report Clearing Rules', () => {
    it('requires WAV rebind for externalWav session and does NOT use old report before rebind', () => {
      const { wavBytes, sha256Hex } = createTestWav(1000, 0.2);
      const fileName = 'test_sample.wav';

      const externalSession: Session = createSession({
        source: {
          kind: 'externalWav',
          sha256Hex,
          fileName,
          requiresReselect: true,
        },
        constraints: {
          targetLufs: -18.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
        synthetic: false,
        inputSummary: {
          fileName,
          sampleRate: 48000,
          channels: 1,
          frames: 48000,
          byteLength: wavBytes.byteLength,
          sha256Hex,
        },
      });

      const sessionJson = exportSession(externalSession);

      // Import session JSON
      const parsed = handleImportSessionJson(sessionJson);

      // Contract check: external WAV MUST flag requiresWavRebind and have NO report
      expect(parsed.requiresWavRebind).toBe(true);
      expect(parsed.presetReport).toBeUndefined();

      // Successful rebind with exact WAV bytes and filename
      const rebindResult = handleRebindWav(parsed.session, wavBytes, fileName);
      expect(rebindResult.verifiedSha256Hex).toBe(sha256Hex);
      expect(rebindResult.report.synthetic).toBe(false);
      expect(rebindResult.report.measurement.integratedLufs).not.toBeNull();
      expect(rebindResult.report.solver.status).toBeDefined();
    });

    it('rejects rebinding when WAV bytes are modified (SHA-256 mismatch)', () => {
      const { wavBytes, sha256Hex } = createTestWav(1000, 0.2);
      const fileName = 'test_speech.wav';

      const externalSession: Session = createSession({
        source: {
          kind: 'externalWav',
          sha256Hex,
          fileName,
          requiresReselect: true,
        },
        constraints: {
          targetLufs: -16.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
        synthetic: false,
      });

      // Modify one byte in audio data
      const tamperedBytes = wavBytes.slice(0);
      const view = new Uint8Array(tamperedBytes);
      view[view.length - 20] ^= 0x55;

      expect(() => handleRebindWav(externalSession, tamperedBytes, fileName)).toThrow(
        /SHA-256 hash mismatch/i,
      );
    });

    it('rejects rebinding when filename is renamed', () => {
      const { wavBytes, sha256Hex } = createTestWav(1000, 0.2);
      const recordedName = 'original.wav';
      const renamedName = 'renamed.wav';

      const externalSession: Session = createSession({
        source: {
          kind: 'externalWav',
          sha256Hex,
          fileName: recordedName,
          requiresReselect: true,
        },
        constraints: {
          targetLufs: -16.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
        synthetic: false,
      });

      expect(() => handleRebindWav(externalSession, wavBytes, renamedName)).toThrow(
        /File name mismatch/i,
      );
    });
  });

  describe('Import Error Handling & Permanent Disclaimer / Privacy Notices', () => {
    it('rejects malformed JSON and unsupported schema faithfully without pretending success', () => {
      expect(() => handleImportSessionJson('not-valid-json')).toThrow();

      const invalidSchema = JSON.stringify({
        schema: 'gainfront.session/999',
        projectId: 'P010',
        specVersion: '1.0.0',
        synthetic: true,
        source: { kind: 'preset', presetId: 'GF-A' },
        constraints: { targetLufs: -16, peakCeilingDbTp: -1, toleranceLu: 0.25, marginDb: 0.3 },
        view: { selectedGainTick: 0, showBlockGates: true },
      });

      expect(() => handleImportSessionJson(invalidSchema)).toThrow(
        /Invalid schema/i,
      );
    });

    it('rejects oversized session JSON (>128 KiB)', () => {
      const largePadding = 'a'.repeat(130000);
      expect(() => handleImportSessionJson(largePadding)).toThrow();
    });

    it('verifies permanent privacy statement and non-certified meter disclaimer', () => {
      // Privacy notice must explicitly affirm 100% offline and no upload
      expect(IMPORT_EXPORT_PRIVACY_TEXT).toContain('100% 纯前端离线');
      expect(IMPORT_EXPORT_PRIVACY_TEXT).toContain('无任何远程网络请求或数据上传');
      expect(IMPORT_EXPORT_PRIVACY_TEXT).toContain('绝不包含原始声音波形');

      // Disclaimer notice
      expect(IMPORT_EXPORT_DISCLAIMER_TEXT).toContain('4× 窗函数 sinc');
      expect(IMPORT_EXPORT_DISCLAIMER_TEXT).toContain('0.30 dB 裕量');
      expect(IMPORT_EXPORT_DISCLAIMER_TEXT).toContain('非广播认证硬件仪表');
      expect(IMPORT_EXPORT_DISCLAIMER_TEXT).toContain('仅供参考');
    });
  });

  describe('P010-FIX-R1-02 Direct WAV Import & Non-blocking Rebind Verification', () => {
    it('B02: decodes and verifies valid WAV directly without prior session JSON', () => {
      const { wavBytes, sha256Hex } = createTestWav(440, 0.3);
      const decoded = validateAndDecodeDirectWav(wavBytes, 'direct_test.wav');

      expect(decoded.pcm.sampleRate).toBe(48000);
      expect(decoded.pcm.channels).toBe(1);
      expect(decoded.pcm.frames).toBe(48000);
      expect(decoded.sha256Hex).toBe(sha256Hex);
    });

    it('B02: rejects invalid WAV bytes (e.g. invalid length, corrupt RIFF) with GainFrontError', () => {
      // Too small
      expect(() => validateAndDecodeDirectWav(new ArrayBuffer(8))).toThrow();

      // Corrupt header
      const invalidHeader = new ArrayBuffer(44);
      new Uint8Array(invalidHeader).fill(0);
      expect(() => validateAndDecodeDirectWav(invalidHeader)).toThrow();
    });

    it('B03: verifies external WAV for rebind without running full analyzeSource on main thread', () => {
      const { wavBytes, sha256Hex } = createTestWav(1000, 0.25);
      const fileName = 'rebind_nonblocking.wav';

      const session: Session = createSession({
        source: {
          kind: 'externalWav',
          sha256Hex,
          fileName,
          requiresReselect: true,
        },
        constraints: {
          targetLufs: -18.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
        synthetic: false,
        inputSummary: {
          fileName,
          sampleRate: 48000,
          channels: 1,
          frames: 48000,
          byteLength: wavBytes.byteLength,
          sha256Hex,
        },
      });

      const verified = verifyExternalWavForRebind(session, wavBytes, fileName);
      expect(verified.sha256Hex).toBe(sha256Hex);
      expect(verified.pcm.frames).toBe(48000);
      expect(verified.pcm.channels).toBe(1);
    });

    it('exports session created from external WAV analysis report with valid inputSummary.byteLength', () => {
      const { wavBytes, sha256Hex } = createTestWav(1000, 0.25);
      const fileName = 'export_external.wav';

      const report: AnalysisReport = analyzeSource({
        wavBytes,
        source: {
          kind: 'externalWav',
          sha256Hex,
          fileName,
          requiresReselect: true,
        },
        constraints: {
          targetLufs: -18.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
      });

      const exportedJson = handleExportSession(report);
      const parsed = parseSession(exportedJson);

      expect(parsed.source.kind).toBe('externalWav');
      expect(parsed.synthetic).toBe(false);
      expect(parsed.inputSummary).toBeDefined();
      expect(parsed.inputSummary?.byteLength).toBe(wavBytes.byteLength);
      expect(parsed.inputSummary?.sha256Hex).toBe(sha256Hex);
    });
  });
});
