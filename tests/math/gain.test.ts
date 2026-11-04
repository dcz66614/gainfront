/**
 * P010-T007 481-Grid Gain Optimization and Loudness/True-Peak Solver Tests
 *
 * Verifies:
 * - measure(pcm): unified pass producing integrated loudness, gates, sample peak, and 4x true peak.
 * - evaluateGain(measurement, tick): re-gating on scaled block powers, linear TP translation, immutability.
 * - solve(measurement, constraints): 481-point grid search, lexicographical tie-break, status classification.
 * - MATH09: exact manual abstract profiles (feasible vs peak-blocked).
 * - MATH10 core side: 481 points, tie-break rules, consistency across synthetic block profiles.
 * - Live dynamic re-gating proof: L(g) !== L0 + g when blocks cross gating thresholds.
 * - Live GF-A / GF-B / GF-E calculation: conclusions dynamically derived by the solver, NEVER hardcoded.
 * - analyzeSource: unified analysis report generation.
 */

import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/core/analyze.js';
import {
  compareCandidates,
  evaluateGain,
  GRID_POINTS_COUNT,
  GRID_TICK_MAX,
  GRID_TICK_MIN,
  measure,
  solve,
} from '../../src/core/gain.js';
import { LUFS_OFFSET } from '../../src/core/gating.js';
import { makePreset } from '../../src/core/presets.js';
import type { Constraints, Measurement } from '../../src/core/types.js';
import { encodePcm16Wav } from '../../src/core/wav.js';

describe('P010-T007 481-Grid Gain Optimization and Solver', () => {
  // Standard test constraints per PROJECT_BOOK §5.5
  const standardConstraints: Constraints = {
    targetLufs: -16.0,
    peakCeilingDbTp: -1.0,
    toleranceLu: 0.25,
    marginDb: 0.3,
  };

  describe('measure API (Unified Measurement)', () => {
    it('measures integrated loudness, sample peak, and 4x true peak in a single pass', () => {
      const pcm = makePreset('GF-B');
      const meas = measure(pcm);

      expect(meas.integratedLufs).not.toBeNull();
      expect(meas.integratedLufs!).toBeCloseTo(-23.0, 0.5);

      expect(meas.samplePeakDbFs).not.toBeNull();
      // GF-B sample peak is 0.10 -> 20*log10(0.10) = -20 dBFS
      expect(meas.samplePeakDbFs!).toBeCloseTo(-20.0, 0.1);

      expect(meas.estimatedTruePeakDbTp).not.toBeNull();
      expect(meas.estimatedTruePeakDbTp!).toBeGreaterThanOrEqual(
        meas.samplePeakDbFs!,
      );

      expect(meas.blockPowers.length).toBe(77); // 8s @ 48kHz: (384000 - 19200)/4800 + 1 = 77
      expect(meas.absoluteGate.length).toBe(77);
      expect(meas.relativeGate.length).toBe(77);
      expect(meas.estimatedPeakPosition).not.toBeNull();
      expect(meas.samplePeakFrame).not.toBeNull();
    });

    it('does not mutate input PCM planar buffers', () => {
      const pcm = makePreset('GF-B');
      const firstSampleOrig = pcm.planar[0][100];
      measure(pcm);
      expect(pcm.planar[0][100]).toBe(firstSampleOrig);
    });
  });

  describe('evaluateGain API & Dynamic Re-Gating Verification', () => {
    it('evaluates gain without modifying the original measurement object', () => {
      const pcm = makePreset('GF-B');
      const meas = measure(pcm);
      const originalPowers = [...meas.blockPowers];

      const point = evaluateGain(meas, 30, standardConstraints); // +3.0 dB

      expect(meas.blockPowers).toEqual(originalPowers);
      expect(point.tick).toBe(30);
      expect(point.integratedLufs).toBeCloseTo(meas.integratedLufs! + 3.0, 0.2);
      expect(point.estimatedTpDb).toBeCloseTo(
        meas.estimatedTruePeakDbTp! + 3.0,
        1e-8,
      );
    });

    it('strictly re-gates block powers: demonstrates L(g) !== L0 + g when blocks cross gating threshold', () => {
      /**
       * Crucial requirement:
       * "严禁只用 L0+g 代替每格重门限（门限块进出会使 L(g) ≠ L(0)+g）"
       *
       * Construction:
       * Create an audio profile with 2 blocks:
       * Block 0: power P_high corresponding to L[0] = -65.0 LUFS.
       * Block 1: power P_low corresponding to L[1] = -72.0 LUFS.
       *
       * At g = 0 dB:
       * Block 0: -65.0 > -70 (passes absolute gate).
       * Block 1: -72.0 <= -70 (strictly excluded by absolute gate).
       * Only Block 0 enters the gate!
       * Therefore L(0) = L[0] = -65.0 LUFS.
       *
       * At g = +5 dB:
       * Scaled powers:
       * Block 0: -65.0 + 5 = -60.0 LUFS.
       * Block 1: -72.0 + 5 = -67.0 LUFS.
       * Now both blocks pass the absolute gate (-70 LUFS)!
       *
       * Relative gate check:
       * Mean power of both blocks in absolute gate:
       * P0_scaled = 10^((-60 - LUFS_OFFSET)/10)
       * P1_scaled = 10^((-67 - LUFS_OFFSET)/10)
       * L_A ≈ -62.22 LUFS.
       * Relative threshold = max(-70, L_A - 10) = max(-70, -72.22) = -70 LUFS.
       * Both blocks pass the relative gate (> -70 LUFS).
       * Re-gated integrated loudness: L(+5 dB) ≈ -62.22 LUFS!
       *
       * But naive L0 + g would predict -65.0 + 5.0 = -60.0 LUFS!
       * The difference is ~2.22 LU!
       */
      const pHigh = Math.pow(10, (-65.0 - LUFS_OFFSET) / 10);
      const pLow = Math.pow(10, (-72.0 - LUFS_OFFSET) / 10);

      const syntheticMeas: Measurement = {
        integratedLufs: -65.0,
        samplePeakDbFs: -10.0,
        estimatedTruePeakDbTp: -9.0,
        samplePeakFrame: 0,
        estimatedPeakPosition: { frame: 0, quarter: 0, channel: 0 },
        blockPowers: [pHigh, pLow],
        absoluteGate: [true, false],
        relativeGate: [true, false],
      };

      const pointAt0 = evaluateGain(syntheticMeas, 0);
      expect(pointAt0.integratedLufs).toBeCloseTo(-65.0, 0.01);

      const pointAt50 = evaluateGain(syntheticMeas, 50); // +5.0 dB
      const naiveL = syntheticMeas.integratedLufs! + 5.0; // -60.0 LUFS

      // Re-gated loudness must reflect the entry of Block 1, differing significantly from naive L0 + g
      expect(pointAt50.integratedLufs).not.toBeNull();
      expect(Math.abs(pointAt50.integratedLufs! - naiveL)).toBeGreaterThan(2.0);
      expect(pointAt50.integratedLufs!).toBeCloseTo(-62.22, 0.1);
    });

    it('translates estimated true peak strictly linearly: TP(g) = TP0 + g', () => {
      const pcm = makePreset('GF-B');
      const meas = measure(pcm);
      const tp0 = meas.estimatedTruePeakDbTp!;

      for (const tick of [-240, -120, -50, 0, 50, 120, 240]) {
        const point = evaluateGain(meas, tick);
        const expectedTp = tp0 + tick * 0.1;
        expect(point.estimatedTpDb).toBeCloseTo(expectedTp, 1e-8);
      }
    });
  });

  describe('MATH09 Abstract Profiles (Handcrafted Verification)', () => {
    /**
     * Handcrafted Profile 1 (from PROJECT_BOOK §7 & task card):
     * L0 = -20, TP0 = -2, T = -14, C = -1, margin = 0.3, tolerance = 0.25.
     * Target loudness T = -14 LUFS requires +6.0 dB gain from L0 = -20.
     * But peak limit is C - margin = -1.0 - 0.3 = -1.3 dBTP.
     * At g = +6.0 dB, TP = -2 + 6 = +4.0 dBTP > -1.3 dBTP -> peak constraint violated!
     * Peak boundary = C - margin - TP0 = -1 - 0.3 - (-2) = +0.7 dB.
     * Maximum safe gain on 0.1 dB grid is +0.7 dB (tick +7).
     * gTarget = +6.0 dB (tick +60).
     * gBest = +0.7 dB (tick +7).
     * Status = GAIN_BLOCKED_PEAK_OR_RANGE.
     * minimumGridDeviation = abs((-20 + 0.7) - (-14)) = 5.3 LU.
     */
    it('MATH09 Case 1: verifies gTarget≈+6.0 is peak-infeasible and solver identifies GAIN_BLOCKED_PEAK_OR_RANGE', () => {
      // Profile with uniform power blocks so that L(g) = L0 + g across this range
      const blockCount = 50;
      const power = Math.pow(10, (-20.0 - LUFS_OFFSET) / 10);
      const blockPowers = new Array<number>(blockCount).fill(power);

      const meas1: Measurement = {
        integratedLufs: -20.0,
        samplePeakDbFs: -2.5,
        estimatedTruePeakDbTp: -2.0,
        samplePeakFrame: 100,
        estimatedPeakPosition: { frame: 100, quarter: 0, channel: 0 },
        blockPowers,
        absoluteGate: new Array<boolean>(blockCount).fill(true),
        relativeGate: new Array<boolean>(blockCount).fill(true),
      };

      const constraints1: Constraints = {
        targetLufs: -14.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const result = solve(meas1, constraints1);

      expect(result.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
      expect(result.gTargetTick).toBe(60); // +6.0 dB
      expect(result.gBestTick).toBe(7); // +0.7 dB (tick 7)
      expect(result.peakBoundaryDb).toBeCloseTo(0.7, 1e-9);
      expect(result.minimumGridDeviationLu).not.toBeNull();
      expect(result.minimumGridDeviationLu!).toBeCloseTo(5.3, 0.05);

      // Verify that gTarget is indeed peak-ineligible in points
      const targetPoint = result.points.find((p) => p.tick === 60);
      expect(targetPoint?.peakEligible).toBe(false);

      // Verify that gBest is peak-eligible in points
      const bestPoint = result.points.find((p) => p.tick === 7);
      expect(bestPoint?.peakEligible).toBe(true);
    });

    /**
     * Handcrafted Profile 2 (from PROJECT_BOOK §7 & task card):
     * L0 = -20, TP0 = -12, T = -16, C = -1, margin = 0.3, tolerance = 0.25.
     * Target loudness T = -16 LUFS requires +4.0 dB gain from L0 = -20.
     * Peak ceiling: C - margin = -1.0 - 0.3 = -1.3 dBTP.
     * At g = +4.0 dB, TP = -12 + 4 = -8.0 dBTP <= -1.3 dBTP -> peak constraint satisfied!
     * Loudness at +4.0 dB = -16.0 LUFS (error 0.0 <= tolerance 0.25).
     * gTarget = +4.0 dB (tick +40).
     * gBest = +4.0 dB (tick +40).
     * Status = GAIN_FEASIBLE.
     * minimumGridDeviation = 0.0 LU.
     */
    it('MATH09 Case 2: verifies gBest≈+4.0 is peak-feasible and solver identifies GAIN_FEASIBLE', () => {
      const blockCount = 50;
      const power = Math.pow(10, (-20.0 - LUFS_OFFSET) / 10);
      const blockPowers = new Array<number>(blockCount).fill(power);

      const meas2: Measurement = {
        integratedLufs: -20.0,
        samplePeakDbFs: -12.5,
        estimatedTruePeakDbTp: -12.0,
        samplePeakFrame: 100,
        estimatedPeakPosition: { frame: 100, quarter: 0, channel: 0 },
        blockPowers,
        absoluteGate: new Array<boolean>(blockCount).fill(true),
        relativeGate: new Array<boolean>(blockCount).fill(true),
      };

      const constraints2: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const result = solve(meas2, constraints2);

      expect(result.status).toBe('GAIN_FEASIBLE');
      expect(result.gTargetTick).toBe(40); // +4.0 dB
      expect(result.gBestTick).toBe(40); // +4.0 dB
      expect(result.minimumGridDeviationLu).not.toBeNull();
      expect(result.minimumGridDeviationLu!).toBeCloseTo(0.0, 1e-9);

      // Peak boundary = -1 - 0.3 - (-12) = +10.7 dB
      expect(result.peakBoundaryDb).toBeCloseTo(10.7, 1e-9);

      const bestPoint = result.points.find((p) => p.tick === 40);
      expect(bestPoint?.peakEligible).toBe(true);
      expect(bestPoint?.levelErrorLu).toBeCloseTo(0.0, 1e-9);
    });
  });

  describe('MATH10 Core Side & Tie-break Rules', () => {
    it('enumerates all 481 discrete grid points strictly from -240 to +240', () => {
      const pcm = makePreset('GF-B');
      const meas = measure(pcm);
      const result = solve(meas, standardConstraints);

      expect(result.points).toHaveLength(GRID_POINTS_COUNT);
      expect(result.points[0].tick).toBe(GRID_TICK_MIN);
      expect(result.points[result.points.length - 1].tick).toBe(GRID_TICK_MAX);

      for (let i = 0; i < result.points.length; i++) {
        expect(result.points[i].tick).toBe(GRID_TICK_MIN + i);
      }
    });

    it('implements 3-tuple lexicographical tie-break: (abs(L - T), abs(g), g)', () => {
      // 1. Primary key: deviation abs(L - T)
      const candA = { dev: 0.1, absTick: 10, tick: 10 };
      const candB = { dev: 0.2, absTick: 5, tick: 5 };
      expect(compareCandidates(candA, candB)).toBeLessThan(0); // candA has smaller dev

      // 2. Secondary key: smaller abs(g) wins when deviations are identical
      const candC = { dev: 0.1, absTick: 20, tick: 20 };
      const candD = { dev: 0.1, absTick: 10, tick: 10 };
      expect(compareCandidates(candD, candC)).toBeLessThan(0); // candD has smaller absTick

      // 3. Tertiary key: smaller signed gain g wins when dev and abs(g) are both identical
      // e.g. tick -10 (-1.0 dB) vs tick +10 (+1.0 dB)
      const candNeg = { dev: 0.1, absTick: 10, tick: -10 };
      const candPos = { dev: 0.1, absTick: 10, tick: 10 };
      expect(compareCandidates(candNeg, candPos)).toBeLessThan(0); // candNeg (-10) wins over candPos (+10)
    });
  });

  describe('Status Classification & Constraints Boundaries', () => {
    it('withholds recommendation and returns NO_PROGRAM when signal has no active content', () => {
      const pcm = makePreset('GF-E'); // Sub-threshold 0.00001 sine
      const meas = measure(pcm);
      expect(meas.integratedLufs).toBeNull();

      const result = solve(meas, standardConstraints);

      expect(result.status).toBe('NO_PROGRAM');
      expect(result.gBestTick).toBeNull();
      expect(result.gTargetTick).toBeNull();
      expect(result.minimumGridDeviationLu).toBeNull();
      expect(result.points).toHaveLength(481);
      expect(result.witness.reasons.length).toBeGreaterThanOrEqual(1);
      expect(result.witness.reasons[0]).toContain('NO_PROGRAM');
    });

    it('returns NO_SAFE_GAIN_IN_GRID when peak ceiling is excessively restrictive', () => {
      // Peak ceiling is -6 dBTP, margin is 0.3 dB -> effective limit -6.3 dBTP
      // Audio with TP0 = +20 dBTP means even at -24 dB gain, TP = 20 - 24 = -4 dBTP > -6.3 dBTP!
      const blockCount = 50;
      const power = Math.pow(10, (-10.0 - LUFS_OFFSET) / 10);
      const blockPowers = new Array<number>(blockCount).fill(power);

      const measExtremePeak: Measurement = {
        integratedLufs: -10.0,
        samplePeakDbFs: 19.5,
        estimatedTruePeakDbTp: 20.0,
        samplePeakFrame: 0,
        estimatedPeakPosition: { frame: 0, quarter: 0, channel: 0 },
        blockPowers,
        absoluteGate: new Array<boolean>(blockCount).fill(true),
        relativeGate: new Array<boolean>(blockCount).fill(true),
      };

      const restrictiveConstraints: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -6.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const result = solve(measExtremePeak, restrictiveConstraints);

      expect(result.status).toBe('NO_SAFE_GAIN_IN_GRID');
      expect(result.gBestTick).toBeNull();
      expect(result.minimumGridDeviationLu).toBeNull();
      expect(result.points.every((p) => !p.peakEligible)).toBe(true);
    });
  });

  describe('GF-A & GF-B Live Verification (Calculated, NOT Hardcoded)', () => {
    /**
     * Requirement:
     * "GF-A/GF-B 结论必须由求解器算出，不得硬编码。"
     *
     * GF-A: Isolated peak spike (0.80) at 4s on top of 0.10 sine.
     * With target = -16 LUFS, ceiling = -1 dBTP:
     * Reaching -16 LUFS requires ~+7 dB boost, which drives the spike to ~+5 dBTP > -1.3 dBTP.
     * The solver must calculate GAIN_BLOCKED_PEAK_OR_RANGE.
     */
    it('calculates GAIN_BLOCKED_PEAK_OR_RANGE for GF-A with T=-16 and C=-1', () => {
      const pcmA = makePreset('GF-A');
      const measA = measure(pcmA);

      const constraintsA: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const resultA = solve(measA, constraintsA);

      // Conclusion must be GAIN_BLOCKED_PEAK_OR_RANGE, derived purely by solver
      expect(resultA.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
      expect(resultA.gTargetTick).not.toBeNull();
      expect(resultA.gBestTick).not.toBeNull();

      // gTarget should be around +7.0 dB (tick ~ 70)
      expect(resultA.gTargetTick!).toBeGreaterThan(60);
      expect(resultA.gTargetTick!).toBeLessThan(80);

      // gBest must be peak-eligible (capped around +0.6 dB, tick ~ 6)
      expect(resultA.gBestTick!).toBeLessThanOrEqual(10);
      expect(resultA.minimumGridDeviationLu!).toBeGreaterThan(5.0);

      // Verify unconstrained target violates peak, safe best satisfies peak
      const targetPoint = resultA.points.find(
        (p) => p.tick === resultA.gTargetTick,
      );
      const bestPoint = resultA.points.find((p) => p.tick === resultA.gBestTick);
      expect(targetPoint?.peakEligible).toBe(false);
      expect(bestPoint?.peakEligible).toBe(true);
    });

    /**
     * GF-B: Uniform 0.10 sine, no isolated peak spikes.
     * With target = -20 LUFS, ceiling = -1 dBTP:
     * Original loudness is ~ -23 LUFS.
     * Reaching -20 LUFS requires ~+3.0 dB gain.
     * At +3.0 dB, TP is ~ -17 dBTP << -1.3 dBTP.
     * The solver must calculate GAIN_FEASIBLE.
     */
    it('calculates GAIN_FEASIBLE for GF-B with T=-20 and C=-1', () => {
      const pcmB = makePreset('GF-B');
      const measB = measure(pcmB);

      const constraintsB: Constraints = {
        targetLufs: -20.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const resultB = solve(measB, constraintsB);

      expect(resultB.status).toBe('GAIN_FEASIBLE');
      expect(resultB.gBestTick).not.toBeNull();

      // gBest should be around +3.0 dB (tick ~ 30)
      expect(resultB.gBestTick!).toBeGreaterThanOrEqual(28);
      expect(resultB.gBestTick!).toBeLessThanOrEqual(32);

      // Minimum grid deviation must be within tolerance (0.25 LU)
      expect(resultB.minimumGridDeviationLu!).toBeLessThanOrEqual(0.25);
      expect(resultB.gTargetTick).toBe(resultB.gBestTick);

      const bestPoint = resultB.points.find((p) => p.tick === resultB.gBestTick);
      expect(bestPoint?.peakEligible).toBe(true);
    });
  });

  describe('analyzeSource API (End-to-End Orchestration)', () => {
    it('generates a full AnalysisReport for preset sources', () => {
      const report = analyzeSource({
        presetId: 'GF-A',
        constraints: standardConstraints,
      });

      expect(report.synthetic).toBe(true);
      expect(report.source).toEqual({ kind: 'preset', presetId: 'GF-A' });
      expect(report.constraints).toEqual(standardConstraints);

      // Measurement completeness
      expect(report.measurement.integratedLufs).not.toBeNull();
      expect(report.measurement.estimatedTruePeakDbTp).not.toBeNull();
      expect(report.measurement.blockPowers.length).toBe(77);

      // Solver result completeness
      expect(report.solver.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
      expect(report.solver.points).toHaveLength(481);

      // Summaries
      expect(report.waveformSummary).toBeDefined();
      expect(report.waveformSummary!.channels).toBe(1);
      expect(report.waveformSummary!.peaks).toHaveLength(1);
      expect(report.waveformSummary!.peaks[0]).toBeCloseTo(0.8, 0.01);

      expect(report.gateSummary).toBeDefined();
      expect(report.gateSummary!.blockCount).toBe(77);

      expect(report.provenance).toBeDefined();
      expect(report.provenance!.specVersion).toBe('1.0.0');
      expect(report.provenance!.sampleRate).toBe(48000);
      expect(report.provenance!.frames).toBe(384000);
      expect(report.provenance!.durationSeconds).toBe(8.0);
    });

    it('generates a full AnalysisReport for in-memory PCM audio', () => {
      const pcm = makePreset('GF-B');
      const report = analyzeSource({
        pcm,
        constraints: {
          targetLufs: -20.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
      });

      expect(report.solver.status).toBe('GAIN_FEASIBLE');
      expect(report.solver.gBestTick).toBeCloseTo(30, 2);
      expect(report.provenance?.frames).toBe(384000);
    });

    it('generates a full AnalysisReport from encoded WAV bytes (externalWav)', () => {
      const pcm = makePreset('GF-B');
      const wavBytes = encodePcm16Wav(pcm);

      const report = analyzeSource({
        wavBytes,
        fileName: 'test-external.wav',
        sha256Hex:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        constraints: {
          targetLufs: -20.0,
          peakCeilingDbTp: -1.0,
          toleranceLu: 0.25,
          marginDb: 0.3,
        },
      });

      expect(report.synthetic).toBe(false);
      expect(report.source.kind).toBe('externalWav');
      if (report.source.kind === 'externalWav') {
        expect(report.source.fileName).toBe('test-external.wav');
        expect(report.source.requiresReselect).toBe(true);
      }
      expect(report.solver.status).toBe('GAIN_FEASIBLE');
      expect(report.measurement.integratedLufs).not.toBeNull();
    });
  });

  describe('MATH10 Core Side Seeded Synthetic Profiles', () => {
    it('reliably evaluates 100 seeded synthetic block power profiles', () => {
      // Deterministic PRNG (LCG)
      let seed = 42;
      function nextRand(): number {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      }

      for (let run = 0; run < 100; run++) {
        const blockCount = 10 + Math.floor(nextRand() * 20);
        const blockPowers: number[] = [];
        const baseLevel = -35 + nextRand() * 20; // -35 to -15 LUFS
        for (let b = 0; b < blockCount; b++) {
          const blockLevel = baseLevel + (nextRand() - 0.5) * 12;
          const p = Math.pow(10, (blockLevel - LUFS_OFFSET) / 10);
          blockPowers.push(p);
        }

        const tp0 = baseLevel + 2 + nextRand() * 10;
        const targetLufs = -28 + nextRand() * 16; // -28 to -12
        const peakCeilingDbTp = -5 + nextRand() * 4; // -5 to -1

        const meas: Measurement = {
          integratedLufs: baseLevel,
          samplePeakDbFs: tp0 - 0.5,
          estimatedTruePeakDbTp: tp0,
          samplePeakFrame: 0,
          estimatedPeakPosition: { frame: 0, quarter: 0, channel: 0 },
          blockPowers,
          absoluteGate: new Array(blockCount).fill(true),
          relativeGate: new Array(blockCount).fill(true),
        };

        const constraints: Constraints = {
          targetLufs,
          peakCeilingDbTp,
          toleranceLu: 0.25,
          marginDb: 0.3,
        };

        const result = solve(meas, constraints);

        expect(result.points).toHaveLength(481);
        expect(
          [
            'GAIN_FEASIBLE',
            'GAIN_BLOCKED_PEAK_OR_RANGE',
            'NO_SAFE_GAIN_IN_GRID',
            'NO_PROGRAM',
          ],
        ).toContain(result.status);

        if (result.status === 'GAIN_FEASIBLE') {
          expect(result.gBestTick).not.toBeNull();
          expect(result.minimumGridDeviationLu).not.toBeNull();
          expect(result.minimumGridDeviationLu!).toBeLessThanOrEqual(0.25 + 1e-9);
        } else if (result.status === 'GAIN_BLOCKED_PEAK_OR_RANGE') {
          expect(result.gBestTick).not.toBeNull();
          expect(result.minimumGridDeviationLu).not.toBeNull();
          expect(result.minimumGridDeviationLu!).toBeGreaterThan(0.25 - 1e-9);
        } else if (result.status === 'NO_SAFE_GAIN_IN_GRID') {
          expect(result.gBestTick).toBeNull();
          expect(result.minimumGridDeviationLu).toBeNull();
        }
      }
    });
  });
});
