/**
 * Tests for Two-Stage 400ms Gating and Integrated Loudness (P010-T005)
 *
 * Covers:
 * - MATH04: Mono vs Stereo identical channel verification (GF-C relative to GF-B, delta within 0.03 LU of 10*log10(2))
 * - MATH05: Gated integrated loudness of GF-F (silent prefix) vs GF-B within 0.25 LU; verification of inactive silent blocks
 * - MATH06: GF-E (all blocks < -70 LUFS) strictly returns NO_PROGRAM; JSON output free of NaN / Infinity
 * - Block boundary verification: incomplete head/tail frames excluded, exact window indexing
 * - Strict threshold review: exact -70.0 LUFS block excluded from absolute gate; exact L_A - 10 block excluded from relative gate
 * - Pure block power re-gating API: evaluates gating on raw block powers, dynamic threshold crossing per gain tick
 * - Fast-path computeGatedLufsFromPowers: verified against full gateBlockPowers, 481-grid performance check
 * - Error handling and zero-signal edge cases
 */

import { describe, expect, it } from 'vitest';
import { applyKWeight } from '../../src/core/biquad.js';
import { GainFrontError } from '../../src/core/errors.js';
import {
  ABSOLUTE_THRESHOLD_LUFS,
  BLOCK_DURATION_SEC,
  BLOCK_SIZE_FRAMES,
  computeBlockCount,
  computeBlockPowers,
  computeGatedLufsFromPowers,
  gateBlockPowers,
  gateFilteredPcm,
  gateRawPcm,
  HOP_DURATION_SEC,
  HOP_SIZE_FRAMES,
  LUFS_OFFSET,
  RELATIVE_THRESHOLD_OFFSET_LU,
} from '../../src/core/gating.js';
import { makePreset } from '../../src/core/presets.js';


describe('P010-T005 Two-Stage 400ms Gating and Integrated Loudness', () => {
  describe('Constants & Block Geometry', () => {
    it('verifies fixed constants match PROJECT_BOOK §5.3', () => {
      expect(BLOCK_SIZE_FRAMES).toBe(19200);
      expect(HOP_SIZE_FRAMES).toBe(4800);
      expect(BLOCK_DURATION_SEC).toBe(0.4);
      expect(HOP_DURATION_SEC).toBe(0.1);
      expect(LUFS_OFFSET).toBe(-0.691);
      expect(ABSOLUTE_THRESHOLD_LUFS).toBe(-70.0);
      expect(RELATIVE_THRESHOLD_OFFSET_LU).toBe(-10.0);
    });

    it('computeBlockCount excludes incomplete trailing frames', () => {
      // Less than 1 window -> 0 blocks
      expect(computeBlockCount(0)).toBe(0);
      expect(computeBlockCount(19199)).toBe(0);

      // Exactly 1 window
      expect(computeBlockCount(19200)).toBe(1);
      expect(computeBlockCount(19201)).toBe(1);
      expect(computeBlockCount(23999)).toBe(1);

      // Exactly 2 windows at 24000 frames (19200 + 4800)
      expect(computeBlockCount(24000)).toBe(2);
      expect(computeBlockCount(24001)).toBe(2);
      expect(computeBlockCount(28799)).toBe(2);

      // 3 windows at 28800 frames
      expect(computeBlockCount(28800)).toBe(3);

      // Standard 8s preset (384,000 frames)
      // (384000 - 19200) / 4800 + 1 = 76 + 1 = 77 blocks
      expect(computeBlockCount(384000)).toBe(77);

      // Standard 30s max duration (1,440,000 frames)
      // (1440000 - 19200) / 4800 + 1 = 296 + 1 = 297 blocks
      expect(computeBlockCount(1440000)).toBe(297);
    });
  });

  describe('Block Power Calculation (computeBlockPowers)', () => {
    it('computes exact power for known DC and square signals', () => {
      // 1 channel with constant value 1.0, length 24000 (2 blocks)
      const ch = new Float64Array(24000);
      ch.fill(1.0);
      const powers = computeBlockPowers([ch]);
      expect(powers).toHaveLength(2);
      // For constant 1.0, mean square is 1.0
      expect(powers[0]).toBeCloseTo(1.0, 12);
      expect(powers[1]).toBeCloseTo(1.0, 12);
    });

    it('sums powers across channels with G=1 per channel (no dual-mono compensation)', () => {
      const ch1 = new Float64Array(19200);
      const ch2 = new Float64Array(19200);
      ch1.fill(0.5); // mean square = 0.25
      ch2.fill(0.5); // mean square = 0.25

      const powersMono = computeBlockPowers([ch1]);
      const powersStereo = computeBlockPowers([ch1, ch2]);

      expect(powersMono[0]).toBeCloseTo(0.25, 12);
      expect(powersStereo[0]).toBeCloseTo(0.5, 12);
      expect(powersStereo[0]).toBeCloseTo(powersMono[0] * 2, 12);
    });

    it('returns empty array when total frames < 19200', () => {
      const shortCh = new Float64Array(10000);
      expect(computeBlockPowers([shortCh])).toEqual([]);
    });

    it('throws GainFrontError on invalid inputs', () => {
      expect(() => computeBlockPowers([])).toThrow(GainFrontError);
      expect(() =>
        computeBlockPowers({
          sampleRate: 44100 as unknown as 48000,
          channels: 1,
          frames: 19200,
          planar: [new Float64Array(19200)],
        }),
      ).toThrow(GainFrontError);
    });
  });

  describe('Strict Threshold Review (Gate Threshold Boundaries)', () => {
    it('strictly excludes blocks with loudness exactly equal to -70.0 LUFS from absolute gate', () => {
      // L[j] = -0.691 + 10 * log10(E) = -70.0
      // 10 * log10(E) = -69.309
      // E = 10^(-6.9309)
      const exactMinus70Power = Math.pow(10, (-70.0 - LUFS_OFFSET) / 10);
      const exactL = LUFS_OFFSET + 10 * Math.log10(exactMinus70Power);
      expect(exactL).toBe(-70.0);

      // Test with exact -70.0 block
      const resultExact = gateBlockPowers([exactMinus70Power]);
      expect(resultExact.blockLoudness[0]).toBe(-70.0);
      expect(resultExact.absoluteGate[0]).toBe(false);
      expect(resultExact.isNoProgram).toBe(true);
      expect(resultExact.integratedLufs).toBeNull();

      // Test with slightly above -70.0 block (e.g. by 1e-6 factor)
      const aboveMinus70Power = exactMinus70Power * (1 + 1e-6);
      const resultAbove = gateBlockPowers([aboveMinus70Power]);
      expect(resultAbove.absoluteGate[0]).toBe(true);
      expect(resultAbove.isNoProgram).toBe(false);
      expect(resultAbove.integratedLufs).not.toBeNull();
    });

    it('strictly excludes blocks with loudness exactly equal to L_A - 10 from relative gate', () => {
      // Construct a two-block test case where:
      // Block 0: High power, determines L_A
      // Block 1: Power chosen so that L[1] is exactly equal to L_A - 10
      //
      // Let Block 0 power = E0, Block 1 power = E1.
      // Both blocks are > -70, so both pass absolute gate.
      // Mean power A = (E0 + E1) / 2.
      // L_A = -0.691 + 10 * log10((E0 + E1) / 2).
      // We want L[1] = -0.691 + 10 * log10(E1) === L_A - 10.
      // 10 * log10(E1) = 10 * log10((E0 + E1) / 2) - 10
      // log10(E1) = log10((E0 + E1) / 2) - 1
      // E1 = (E0 + E1) / 20
      // 20 * E1 = E0 + E1 => 19 * E1 = E0 => E0 = 19 * E1.
      //
      // Let's choose E1 = 1e-4:
      // E0 = 19 * 1e-4 = 1.9e-3.
      // Let's verify:
      // (E0 + E1) / 2 = 20 * 1e-4 / 2 = 10 * 1e-4 = 1e-3.
      // L_A = -0.691 + 10 * log10(1e-3) = -0.691 - 30 = -30.691 LUFS.
      // L_A - 10 = -40.691 LUFS.
      // L[1] = -0.691 + 10 * log10(1e-4) = -0.691 - 40 = -40.691 LUFS.
      // L[1] is EXACTLY L_A - 10!
      const E1 = 1e-4;
      const E0 = 19 * E1;

      const result = gateBlockPowers([E0, E1]);

      expect(result.absoluteGate[0]).toBe(true);
      expect(result.absoluteGate[1]).toBe(true);
      expect(result.lA).toBeCloseTo(-30.691, 10);
      expect(result.relativeThreshold).toBeCloseTo(-40.691, 10);
      expect(result.blockLoudness[1]).toBeCloseTo(result.relativeThreshold!, 10);

      // Block 1 has L[1] === L_A - 10; strictly > must exclude it!
      expect(result.relativeGate[0]).toBe(true);
      expect(result.relativeGate[1]).toBe(false);

      // Only Block 0 contributes to final integrated loudness
      // mean_E_R = E0
      // I = -0.691 + 10 * log10(E0) = -0.691 + 10 * log10(1.9e-3)
      const expectedI = LUFS_OFFSET + 10 * Math.log10(E0);
      expect(result.integratedLufs).toBeCloseTo(expectedI, 10);
    });
  });

  describe('Pure Block Power API (gateBlockPowers & computeGatedLufsFromPowers)', () => {
    it('evaluates pure block powers without audio PCM or re-filtering', () => {
      // 4 synthetic blocks:
      // Block 0: 0.01 (-20.691 LUFS) -> passes abs & rel
      // Block 1: 0.01 (-20.691 LUFS) -> passes abs & rel
      // Block 2: 1e-6 (-60.691 LUFS) -> passes abs, fails rel
      // Block 3: 1e-9 (-90.691 LUFS) -> fails abs
      const powers = [0.01, 0.01, 1e-6, 1e-9];
      const res = gateBlockPowers(powers);

      expect(res.blockPowers).toHaveLength(4);
      expect(res.absoluteGate).toEqual([true, true, true, false]);
      expect(res.relativeGate).toEqual([true, true, false, false]);
      expect(res.isNoProgram).toBe(false);

      // Fast-path scalar calculation matches full evaluation
      const fastLufs = computeGatedLufsFromPowers(powers);
      expect(fastLufs).not.toBeNull();
      expect(fastLufs).toBeCloseTo(res.integratedLufs!, 12);
    });

    it('dynamically crosses gate thresholds when gainDb is applied', () => {
      // Block at 1e-7 power: L = -0.691 + 10 * log10(1e-7) = -70.691 LUFS
      // At gain = 0 dB: fails absolute gate
      const powers = [1e-7];
      const res0 = gateBlockPowers(powers, 0);
      expect(res0.blockLoudness[0]).toBeCloseTo(-70.691, 3);
      expect(res0.absoluteGate[0]).toBe(false);
      expect(res0.isNoProgram).toBe(true);

      // At gain = +3 dB: power = 1e-7 * 10^0.3 = 1.995e-7
      // L = -70.691 + 3 = -67.691 LUFS > -70 LUFS -> passes absolute gate!
      const res3 = gateBlockPowers(powers, 3.0);
      expect(res3.blockLoudness[0]).toBeCloseTo(-67.691, 3);
      expect(res3.absoluteGate[0]).toBe(true);
      expect(res3.isNoProgram).toBe(false);
      expect(res3.integratedLufs).toBeCloseTo(-67.691, 3);
    });

    it('matches pre-scaled block powers when gainDb is applied', () => {
      const powers = [0.002, 0.005, 0.001, 0.0001];
      const gainDb = 4.5;
      const mult = Math.pow(10, gainDb / 10);
      const preScaled = powers.map((p) => p * mult);

      const resWithGain = gateBlockPowers(powers, gainDb);
      const resPreScaled = gateBlockPowers(preScaled, 0);

      expect(resWithGain.integratedLufs).toBeCloseTo(resPreScaled.integratedLufs!, 12);
      expect(resWithGain.absoluteGate).toEqual(resPreScaled.absoluteGate);
      expect(resWithGain.relativeGate).toEqual(resPreScaled.relativeGate);
    });

    it('handles empty block array as NO_PROGRAM', () => {
      const res = gateBlockPowers([]);
      expect(res.isNoProgram).toBe(true);
      expect(res.integratedLufs).toBeNull();
      expect(computeGatedLufsFromPowers([])).toBeNull();
    });

    it('handles all-zero block powers with -Infinity loudness as NO_PROGRAM', () => {
      const res = gateBlockPowers([0, 0, 0]);
      expect(res.isNoProgram).toBe(true);
      expect(res.integratedLufs).toBeNull();
      expect(res.blockLoudness).toEqual([-Infinity, -Infinity, -Infinity]);
      expect(res.absoluteGate).toEqual([false, false, false]);
      expect(res.relativeGate).toEqual([false, false, false]);
      expect(computeGatedLufsFromPowers([0, 0, 0])).toBeNull();
    });

    it('evaluates 481-grid search fast path within high performance limit', () => {
      // 77 blocks (8s audio)
      const powers = new Float64Array(77);
      for (let i = 0; i < 77; i++) {
        powers[i] = 0.005 * (0.5 + 0.5 * Math.sin(i * 0.1));
      }

      // Warm-up run to eliminate JIT compilation / cold start overhead
      for (let tick = -240; tick <= 240; tick++) {
        computeGatedLufsFromPowers(powers, tick * 0.1);
      }

      const t0 = performance.now();
      for (let tick = -240; tick <= 240; tick++) {
        const gainDb = tick * 0.1;
        const lufs = computeGatedLufsFromPowers(powers, gainDb);
        expect(typeof lufs === 'number' || lufs === null).toBe(true);
      }
      const elapsedMs = performance.now() - t0;
      // 481 evaluations of 77 blocks should finish in < 250ms in Node
      expect(elapsedMs).toBeLessThan(250);
    });
  });

  describe('MATH04: GF-C Stereo vs GF-B Mono Identical Signal Verification', () => {
    it('verifies I_C - I_B is within 0.03 LU of 10*log10(2) per PROJECT_BOOK §7', () => {
      const pcmB = makePreset('GF-B');
      const pcmC = makePreset('GF-C');

      expect(pcmB.channels).toBe(1);
      expect(pcmC.channels).toBe(2);
      expect(pcmB.frames).toBe(384000);
      expect(pcmC.frames).toBe(384000);

      // Filter both presets
      const filtB = applyKWeight(pcmB);
      const filtC = applyKWeight(pcmC);

      const resB = gateFilteredPcm(filtB);
      const resC = gateFilteredPcm(filtC);

      expect(resB.isNoProgram).toBe(false);
      expect(resC.isNoProgram).toBe(false);
      expect(resB.integratedLufs).not.toBeNull();
      expect(resC.integratedLufs).not.toBeNull();

      const expectedDelta = 10 * Math.log10(2); // 3.0102999566...
      const actualDelta = resC.integratedLufs! - resB.integratedLufs!;

      // Project book §7 MATH04 threshold: |(I_C - I_B) - 10*log10(2)| <= 0.03 LU
      expect(Math.abs(actualDelta - expectedDelta)).toBeLessThan(0.03);

      // In fact, since the L and R tracks in GF-C are strictly identical to GF-B,
      // every single block power E_C[j] should equal 2 * E_B[j] to machine precision!
      expect(resB.blockPowers).toHaveLength(77);
      expect(resC.blockPowers).toHaveLength(77);
      for (let j = 0; j < 77; j++) {
        expect(resC.blockPowers[j]).toBeCloseTo(resB.blockPowers[j] * 2, 10);
        expect(resC.blockLoudness[j] - resB.blockLoudness[j]).toBeCloseTo(expectedDelta, 10);
      }
    });
  });

  describe('MATH05: GF-F Silent Prefix vs GF-B Gated Comparison', () => {
    it('correctly gates out silent blocks and verifies |I_F - I_B| <= 0.25 LU per §7', () => {
      const pcmB = makePreset('GF-B');
      const pcmF = makePreset('GF-F');

      const filtB = applyKWeight(pcmB);
      const filtF = applyKWeight(pcmF);

      const resB = gateFilteredPcm(filtB);
      const resF = gateFilteredPcm(filtF);

      expect(resB.isNoProgram).toBe(false);
      expect(resF.isNoProgram).toBe(false);

      // Verify GF-F block properties:
      // GF-F has silence for n < 96000 (first 2 seconds = 96000 frames)
      // Hop size is 4800 frames, window is 19200 frames.
      // For j=0..16, start is j*4800, end is j*4800+19200.
      // When j=16: start=76800, end=96000. All frames are in silence (y=0).
      // Therefore, blocks j=0 through 16 (17 blocks total) must have strictly zero power!
      for (let j = 0; j <= 16; j++) {
        expect(resF.blockPowers[j]).toBe(0.0);
        expect(resF.blockLoudness[j]).toBe(-Infinity);
        expect(resF.absoluteGate[j]).toBe(false);
        expect(resF.relativeGate[j]).toBe(false);
      }

      // Starting at j=17, signal enters the window:
      // j=17: start=81600, end=100800. Frames 96000..100800 contain active signal.
      expect(resF.blockPowers[17]).toBeGreaterThan(0);
      expect(resF.blockLoudness[17]).toBeGreaterThan(-70);
      expect(resF.absoluteGate[17]).toBe(true);

      // Verify MATH05 tolerance: |I_F - I_B| <= 0.25 LU
      const diffLu = Math.abs(resF.integratedLufs! - resB.integratedLufs!);
      expect(diffLu).toBeLessThanOrEqual(0.25);

      // Verify that gating actually made a difference:
      // If we computed un-gated average over all 77 blocks (including silence),
      // the loudness would be much lower (by > 1.0 LU).
      const unGatedPowerF = resF.blockPowers.reduce((a, b) => a + b, 0) / resF.blockPowers.length;
      const unGatedLufsF = LUFS_OFFSET + 10 * Math.log10(unGatedPowerF);
      const unGatedDiff = Math.abs(unGatedLufsF - resB.integratedLufs!);
      expect(unGatedDiff).toBeGreaterThan(1.0);
    });
  });

  describe('MATH06: GF-E Sub-threshold Loudness NO_PROGRAM Verification', () => {
    it('returns NO_PROGRAM for GF-E and JSON contains no NaN or Infinity', () => {
      const pcmE = makePreset('GF-E');
      const filtE = applyKWeight(pcmE);
      const resE = gateFilteredPcm(filtE);

      // All blocks must be below -70 LUFS (around -103 LUFS for amplitude 1e-5)
      expect(resE.isNoProgram).toBe(true);
      expect(resE.integratedLufs).toBeNull();
      expect(resE.lA).toBeNull();
      expect(resE.relativeThreshold).toBeNull();

      expect(resE.gateSummary.blockCount).toBe(77);
      expect(resE.gateSummary.absoluteGateCount).toBe(0);
      expect(resE.gateSummary.relativeGateCount).toBe(0);

      // All absolute gate flags must be strictly false
      expect(resE.absoluteGate.every((g) => g === false)).toBe(true);
      expect(resE.relativeGate.every((g) => g === false)).toBe(true);

      for (let j = 0; j < 77; j++) {
        expect(resE.blockLoudness[j]).toBeLessThan(-70.0);
      }

      // JSON Serialization verification per MATH06:
      // Must serialize cleanly without NaN or Infinity
      const jsonStr = JSON.stringify(resE);
      expect(jsonStr).toContain('"integratedLufs":null');
      expect(jsonStr).not.toContain('NaN');
      expect(jsonStr).not.toContain('Infinity');

      const parsed = JSON.parse(jsonStr);
      expect(parsed.integratedLufs).toBeNull();
      expect(parsed.isNoProgram).toBe(true);
      expect(parsed.gateSummary.absoluteGateCount).toBe(0);
    });
  });

  describe('High-Level Helper (gateRawPcm)', () => {
    it('integrates K-weighting and gating end-to-end for GF-A and GF-B', () => {
      const pcmA = makePreset('GF-A');
      const pcmB = makePreset('GF-B');

      const resA = gateRawPcm(pcmA);
      const resB = gateRawPcm(pcmB);

      expect(resA.isNoProgram).toBe(false);
      expect(resB.isNoProgram).toBe(false);
      expect(resA.integratedLufs).not.toBeNull();
      expect(resB.integratedLufs).not.toBeNull();

      // GF-A has an isolated 1-sample spike at 4s (overwritten), which adds negligible total energy
      // to the 400ms integrated loudness compared to GF-B
      expect(Math.abs(resA.integratedLufs! - resB.integratedLufs!)).toBeLessThan(0.05);
    });
  });
});
