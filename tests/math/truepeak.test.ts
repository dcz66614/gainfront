/**
 * Mathematical Verification Tests for 4× True Peak Estimation (P010-T006)
 *
 * Covers:
 * - MATH07: GF-D (12kHz, π/4 phase) inter-sample peak:
 *   estimatedTruePeakDbTp - samplePeakDbFs >= 2.0 dB, localized at non-integer quarter.
 * - MATH08: GF-B at ±6.0 dB Float64 constant gain shifts strictly by ±6.0 dB (error < 1e-8 dB);
 *   demonstrates why Float64 without requantization is required.
 * - Boundary handling: impulse at frame 0 and frame N-1 with zero-padding and no window renormalization.
 * - Deterministic tie-break: earliest frame n, minimum quarter k, minimum channel c.
 * - Mathematical kernel properties: sinc, cosineWindow, windowedSinc, INTERPOLATION_TABLES.
 * - Golden presets GF-A through GF-F verification.
 * - Input validation and edge cases (0 frames, all-zero silence, invalid PCM formats).
 */

import { describe, expect, it } from 'vitest';
import { GainFrontError } from '../../src/core/errors.js';
import { makePreset } from '../../src/core/presets.js';
import {
  cosineWindow,
  estimateTruePeak,
  INTERPOLATION_TABLES,
  interpolateSample,
  OVERSAMPLE_FACTOR,
  sinc,
  SINC_RADIUS,
  SINC_TABLE_SIZE,
  windowedSinc,
} from '../../src/core/truepeak.js';
import type { PCM } from '../../src/core/types.js';

describe('P010-T006 4× Interpolated True Peak Estimation', () => {
  describe('Mathematical Kernel Functions', () => {
    it('verifies filter constants match PROJECT_BOOK §5.4', () => {
      expect(SINC_RADIUS).toBe(16);
      expect(SINC_TABLE_SIZE).toBe(33);
      expect(OVERSAMPLE_FACTOR).toBe(4);
    });

    it('sinc function: satisfies normalized cardinal interpolation axioms', () => {
      // sinc(0) === 1
      expect(sinc(0)).toBe(1.0);

      // Even symmetry: sinc(q) === sinc(-q)
      const testPoints = [0.1, 0.25, 0.5, 0.75, 1.25, 2.5, 7.8, 15.5];
      for (const q of testPoints) {
        expect(sinc(q)).toBeCloseTo(sinc(-q), 14);
      }

      // Root at non-zero integers: sinc(k) === 0 for k in Z \ {0}
      for (let k = -16; k <= 16; k++) {
        if (k !== 0) {
          expect(sinc(k)).toBe(0.0);
        }
      }

      // Midpoint value: sinc(0.5) = sin(pi/2)/(pi/2) = 2/pi
      expect(sinc(0.5)).toBeCloseTo(2.0 / Math.PI, 14);
    });

    it('cosineWindow: satisfies Hann-type radius 16 window definition', () => {
      // w(0) === 1
      expect(cosineWindow(0)).toBe(1.0);

      // Window reaches exactly 0 at boundary |q| = 16
      expect(cosineWindow(16)).toBe(0.0);
      expect(cosineWindow(-16)).toBe(0.0);

      // Strictly 0 outside window |q| > 16
      expect(cosineWindow(16.0001)).toBe(0.0);
      expect(cosineWindow(-16.0001)).toBe(0.0);
      expect(cosineWindow(20)).toBe(0.0);
      expect(cosineWindow(-20)).toBe(0.0);

      // Even symmetry: w(q) === w(-q)
      const testPoints = [1, 2.5, 4, 8, 12.25, 15.9];
      for (const q of testPoints) {
        expect(cosineWindow(q)).toBe(cosineWindow(-q));
      }

      // Intermediate value check: w(8) = (1 + cos(pi*8/16))/2 = (1 + cos(pi/2))/2 = 0.5
      expect(cosineWindow(8)).toBeCloseTo(0.5, 14);
      expect(cosineWindow(-8)).toBeCloseTo(0.5, 14);
    });

    it('windowedSinc: composite kernel matches sinc(q) * cosineWindow(q)', () => {
      const testPoints = [-17, -16, -10.5, -4, 0, 0.25, 0.5, 8.25, 16, 17.5];
      for (const q of testPoints) {
        expect(windowedSinc(q)).toBe(sinc(q) * cosineWindow(q));
      }
    });

    it('INTERPOLATION_TABLES: verifies precomputed table properties', () => {
      expect(INTERPOLATION_TABLES.length).toBe(4);
      for (let k = 0; k < 4; k++) {
        expect(INTERPOLATION_TABLES[k].length).toBe(33);
      }

      // Phase k = 0 corresponds to t = n (integer frame):
      // Must be pure delta function at d = 0 (table index 16 = 1.0, all other 32 entries = 0.0)
      const k0 = INTERPOLATION_TABLES[0];
      for (let d = -16; d <= 16; d++) {
        const expected = d === 0 ? 1.0 : 0.0;
        expect(k0[d + 16]).toBe(expected);
      }

      // Verify tables match windowedSinc(k/4 - d)
      for (let k = 1; k < 4; k++) {
        const tbl = INTERPOLATION_TABLES[k];
        for (let d = -16; d <= 16; d++) {
          const q = k / 4.0 - d;
          expect(tbl[d + 16]).toBe(windowedSinc(q));
        }
      }
    });
  });

  describe('MATH07: Inter-sample Peak Detection (GF-D 12kHz, π/4 Phase)', () => {
    it('verifies estimatedTruePeakDbTp - samplePeakDbFs >= 2.0 dB and non-integer peak localization', () => {
      const gfd = makePreset('GF-D');
      const result = estimateTruePeak(gfd);

      expect(result.samplePeakDbFs).not.toBeNull();
      expect(result.estimatedTruePeakDbTp).not.toBeNull();
      expect(result.estimatedPeakPosition).not.toBeNull();

      const samplePeakDbFs = result.samplePeakDbFs!;
      const estimatedTruePeakDbTp = result.estimatedTruePeakDbTp!;
      const diffDb = estimatedTruePeakDbTp - samplePeakDbFs;

      // Project Book §7 & Task Card P010-T006 Contract:
      // estimatedTruePeakDbTp - samplePeakDbFs >= 2.0 dB
      expect(diffDb).toBeGreaterThanOrEqual(2.0);

      // Numerical check: 12kHz sin wave sampled at angles pi/4, 3pi/4, ...
      // raw sample peak = 0.90 * sin(pi/4) = 0.90 * sqrt(2)/2 ~= 0.636396 dBFS (~ -3.925 dBFS)
      // true analog continuous peak = 0.90 dBTP (~ -0.915 dBTP)
      // 4x sinc reconstruction captures ~ 0.910 dBTP (~ -0.818 dBTP)
      // theoretical difference is ~ 3.1 dB
      expect(samplePeakDbFs).toBeCloseTo(-3.925, 1);
      expect(estimatedTruePeakDbTp).toBeCloseTo(-0.818, 1);
      expect(diffDb).toBeCloseTo(3.108, 1);

      // Peak localization must be at a non-integer sub-sample (quarter !== 0)
      const pos = result.estimatedPeakPosition!;
      expect(pos.quarter).not.toBe(0);
      expect(pos.quarter).toBe(2); // Quarter 2 (t = n + 0.5) aligns with pi/2 sine wave crest
      expect(pos.channel).toBe(0);
    });
  });

  describe('MATH08: Float64 Linearity Under ±6.0 dB Constant Gain (GF-B)', () => {
    it('verifies interpolated peak reading shifts strictly by ±6.0 dB with error < 1e-8 dB', () => {
      const gfb = makePreset('GF-B');
      const baseResult = estimateTruePeak(gfb);

      expect(baseResult.estimatedTruePeakDbTp).not.toBeNull();
      const baseTpDb = baseResult.estimatedTruePeakDbTp!;

      // Apply exact unquantized Float64 scaling factors:
      // +6.0 dB: 10^(+6/20)
      // -6.0 dB: 10^(-6/20)
      const scalePlus6 = Math.pow(10, 6.0 / 20.0);
      const scaleMinus6 = Math.pow(10, -6.0 / 20.0);

      const frames = gfb.frames;
      const chPlus = new Float64Array(frames);
      const chMinus = new Float64Array(frames);

      for (let n = 0; n < frames; n++) {
        chPlus[n] = gfb.planar[0][n] * scalePlus6;
        chMinus[n] = gfb.planar[0][n] * scaleMinus6;
      }

      const resPlus = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [chPlus],
      });

      const resMinus = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [chMinus],
      });

      expect(resPlus.estimatedTruePeakDbTp).not.toBeNull();
      expect(resMinus.estimatedTruePeakDbTp).not.toBeNull();

      const deltaPlus = resPlus.estimatedTruePeakDbTp! - baseTpDb;
      const deltaMinus = resMinus.estimatedTruePeakDbTp! - baseTpDb;

      // Project Book §7 & Task Card P010-T006 Contract:
      // Absolute deviation from +6.0 dB and -6.0 dB must be strictly < 1e-8 dB.
      expect(Math.abs(deltaPlus - 6.0)).toBeLessThan(1e-8);
      expect(Math.abs(deltaMinus - (-6.0))).toBeLessThan(1e-8);

      // Demonstrates linear amplitude scaling: ampPlus / baseAmp === scalePlus6
      expect(resPlus.estimatedTruePeakAmp / baseResult.estimatedTruePeakAmp).toBeCloseTo(scalePlus6, 14);
      expect(resMinus.estimatedTruePeakAmp / baseResult.estimatedTruePeakAmp).toBeCloseTo(scaleMinus6, 14);
    });

    it('demonstrates that 16-bit requantization breaks the < 1e-8 dB precision requirement', () => {
      const gfb = makePreset('GF-B');
      const baseResult = estimateTruePeak(gfb);
      const baseTpDb = baseResult.estimatedTruePeakDbTp!;

      const scalePlus6 = Math.pow(10, 6.0 / 20.0);
      const frames = gfb.frames;
      const quantizedPlus = new Float64Array(frames);

      // Simulate requantizing to 16-bit signed PCM (int16: -32768 to 32767)
      for (let n = 0; n < frames; n++) {
        const continuous = gfb.planar[0][n] * scalePlus6;
        const q16 = Math.round(continuous * 32767.0) / 32767.0;
        quantizedPlus[n] = q16;
      }

      const resQuantized = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [quantizedPlus],
      });

      const deltaQuantized = resQuantized.estimatedTruePeakDbTp! - baseTpDb;
      const error = Math.abs(deltaQuantized - 6.0);

      // Quantization noise introduces error orders of magnitude greater than 1e-8 dB
      expect(error).toBeGreaterThan(1e-6);
    });
  });

  describe('Deterministic Tie-Break Rules', () => {
    it('tie-break: earliest frame wins when peak amplitudes are identical across frames', () => {
      const frames = 100;
      const buffer = new Float64Array(frames);

      // Place identical raw peak 0.8 at frame 10 and frame 30
      buffer[10] = 0.8;
      buffer[30] = 0.8;

      const res = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [buffer],
      });

      expect(res.samplePeak).toBe(0.8);
      expect(res.samplePeakFrame).toBe(10); // Frame 10 is earlier than frame 30
      expect(res.estimatedPeakPosition).toEqual({
        frame: 10,
        quarter: 0,
        channel: 0,
      });
    });

    it('tie-break: minimum quarter k wins when peak amplitudes are identical at same frame', () => {
      const frames = 40;
      const ch = new Float64Array(frames);
      const n = 20;

      // Construct exact equality between k = 0 (t = n) and k = 1 (t = n + 0.25):
      // xhat(n + 0) = ch[n] = 1.0
      // xhat(n + 0.25) = ch[n] * ws(0.25) + ch[n+1] * ws(0.75) = 1.0
      // => ch[n+1] = (1.0 - ws(0.25)) / ws(0.75)
      const w025 = windowedSinc(0.25);
      const w075 = windowedSinc(0.75);
      ch[n] = 1.0;
      ch[n + 1] = (1.0 - w025) / w075;

      const valQuarter0 = Math.abs(interpolateSample(ch, n, frames));
      const valQuarter1 = Math.abs(interpolateSample(ch, n + 0.25, frames));

      // Confirm exact mathematical equality between k = 0 and k = 1
      expect(valQuarter0).toBe(1.0);
      expect(valQuarter1).toBe(1.0);

      const res = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [ch],
      });

      // Tie between quarter 0 and quarter 1 at frame 20 must resolve to smaller k = 0
      expect(res.estimatedPeakPosition?.frame).toBe(n);
      expect(res.estimatedPeakPosition?.quarter).toBe(0);
      expect(res.estimatedTruePeakAmp).toBe(1.0);
    });

    it('tie-break: minimum channel c wins when identical peaks exist on channel 0 and 1', () => {
      const frames = 100;
      const ch0 = new Float64Array(frames);
      const ch1 = new Float64Array(frames);

      // Identical peaks at frame 25 on both channels
      ch0[25] = 0.75;
      ch1[25] = 0.75;

      const res = estimateTruePeak({
        sampleRate: 48000,
        channels: 2,
        frames,
        planar: [ch0, ch1],
      });

      expect(res.samplePeakFrame).toBe(25);
      expect(res.samplePeakChannel).toBe(0); // Channel 0 wins over channel 1
      expect(res.estimatedPeakPosition).toEqual({
        frame: 25,
        quarter: 0,
        channel: 0,
      });
    });

    it('tie-break: compound hierarchy (frame > quarter > channel)', () => {
      const frames = 60;
      const ch0 = new Float64Array(frames);
      const ch1 = new Float64Array(frames);

      // Channel 1 has peak at earlier frame 12
      // Channel 0 has identical peak at later frame 18
      ch1[12] = 0.9;
      ch0[18] = 0.9;

      const res = estimateTruePeak({
        sampleRate: 48000,
        channels: 2,
        frames,
        planar: [ch0, ch1],
      });

      // Earlier frame 12 on channel 1 beats later frame 18 on channel 0
      expect(res.samplePeakFrame).toBe(12);
      expect(res.samplePeakChannel).toBe(1);
      expect(res.estimatedPeakPosition).toEqual({
        frame: 12,
        quarter: 0,
        channel: 1,
      });
    });
  });

  describe('Boundary Handling & Zero-Padding', () => {
    it('head boundary: handles impulse at frame 0 with zero-padding (no window renormalization)', () => {
      const frames = 50;
      const ch = new Float64Array(frames);
      ch[0] = 1.0;

      const res = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [ch],
      });

      // Sample peak is 1.0 at frame 0
      expect(res.samplePeak).toBe(1.0);
      expect(res.samplePeakFrame).toBe(0);

      // Reconstructed value at t = 0 + 0.25 (k=1) depends only on m=0 because m < 0 are 0
      // xhat(0.25) = ch[0] * sinc(0.25) * w(0.25)
      const expectedInterp = 1.0 * windowedSinc(0.25);
      const actualInterp = interpolateSample(ch, 0.25, frames);
      expect(actualInterp).toBeCloseTo(expectedInterp, 14);

      // Does NOT renormalize by dividing by sum of window weights
      expect(actualInterp).not.toBe(1.0);
    });

    it('tail boundary: handles impulse at frame N-1 with zero-padding', () => {
      const frames = 50;
      const ch = new Float64Array(frames);
      ch[frames - 1] = 1.0;

      const res = estimateTruePeak({
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [ch],
      });

      expect(res.samplePeak).toBe(1.0);
      expect(res.samplePeakFrame).toBe(frames - 1);

      // Check t = (frames - 1) + 0.25
      const actualTailInterp = interpolateSample(ch, frames - 1 + 0.25, frames);
      const expectedTailInterp = 1.0 * windowedSinc(0.25);
      expect(actualTailInterp).toBeCloseTo(expectedTailInterp, 14);
    });

    it('interior impulse: reconstructs full 33-point window without truncation', () => {
      const frames = 100;
      const ch = new Float64Array(frames);
      const center = 50;
      ch[center] = 1.0;

      // At t = center + 0.5: distance to center is 0.5
      const interp = interpolateSample(ch, center + 0.5, frames);
      expect(interp).toBeCloseTo(windowedSinc(0.5), 14);

      // Beyond radius 16 (e.g. t = center + 17): value must be strictly 0
      const outside = interpolateSample(ch, center + 17, frames);
      expect(outside).toBe(0.0);
    });
  });

  describe('Golden Presets Spot Checks (GF-A through GF-F)', () => {
    it('GF-A: detects isolated burst pulse at n = 192000 as peak', () => {
      const gfa = makePreset('GF-A');
      const res = estimateTruePeak(gfa);

      expect(res.samplePeak).toBe(0.80);
      expect(res.samplePeakFrame).toBe(192000); // 4 * 48000
      expect(res.samplePeakChannel).toBe(0);
      expect(res.samplePeakDbFs).toBeCloseTo(20 * Math.log10(0.80), 10);
      expect(res.estimatedPeakPosition).toEqual({
        frame: 192000,
        quarter: 0,
        channel: 0,
      });
    });

    it('GF-B: safe gain 1000Hz mono sine wave', () => {
      const gfb = makePreset('GF-B');
      const res = estimateTruePeak(gfb);

      expect(res.samplePeak).toBeCloseTo(0.10, 3);
      expect(res.samplePeakDbFs).toBeCloseTo(20 * Math.log10(0.10), 1);
      expect(res.estimatedTruePeakDbTp).toBeCloseTo(20 * Math.log10(0.10), 1);
    });

    it('GF-C: stereo identical channels do not double peak amplitude (G=1 per channel)', () => {
      const gfc = makePreset('GF-C');
      const gfb = makePreset('GF-B');

      const resC = estimateTruePeak(gfc);
      const resB = estimateTruePeak(gfb);

      // Stereo peaks must match mono peaks (unlike energy/loudness which increases by 3 LU)
      expect(resC.samplePeak).toBeCloseTo(resB.samplePeak, 10);
      expect(resC.estimatedTruePeakDbTp).toBeCloseTo(resB.estimatedTruePeakDbTp!, 10);
      expect(resC.estimatedPeakPosition?.channel).toBe(0); // tie-break chooses channel 0
    });

    it('GF-E: sub-threshold signal (0.00001) returns valid non-null finite peak', () => {
      const gfe = makePreset('GF-E');
      const res = estimateTruePeak(gfe);

      expect(res.samplePeak).toBeCloseTo(0.00001, 8);
      expect(res.samplePeakDbFs).toBeCloseTo(20 * Math.log10(0.00001), 1);
      expect(res.estimatedTruePeakDbTp).toBeCloseTo(20 * Math.log10(0.00001), 1);
    });

    it('GF-F: silent prefix gates out peak in prefix, detects peak in active region n >= 96000', () => {
      const gff = makePreset('GF-F');
      const res = estimateTruePeak(gff);

      expect(res.samplePeak).toBeCloseTo(0.10, 3);
      expect(res.samplePeakFrame).toBeGreaterThanOrEqual(96000);
      expect(res.estimatedPeakPosition?.frame).toBeGreaterThanOrEqual(96000);
    });
  });

  describe('Edge Cases & Input Validation', () => {
    it('handles empty buffer (0 frames) returning null levels and null coordinates', () => {
      const emptyPcm: PCM = {
        sampleRate: 48000,
        channels: 1,
        frames: 0,
        planar: [new Float64Array(0)],
      };

      const res = estimateTruePeak(emptyPcm);
      expect(res.samplePeak).toBe(0.0);
      expect(res.samplePeakDbFs).toBeNull();
      expect(res.samplePeakFrame).toBeNull();
      expect(res.samplePeakChannel).toBeNull();
      expect(res.estimatedTruePeakAmp).toBe(0.0);
      expect(res.estimatedTruePeakDbTp).toBeNull();
      expect(res.estimatedPeakPosition).toBeNull();
    });

    it('handles all-zero buffer (silence) returning null dBFS/dBTP and frame 0 coordinate', () => {
      const frames = 1000;
      const silencePcm: PCM = {
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [new Float64Array(frames)],
      };

      const res = estimateTruePeak(silencePcm);
      expect(res.samplePeak).toBe(0.0);
      expect(res.samplePeakDbFs).toBeNull();
      expect(res.estimatedTruePeakAmp).toBe(0.0);
      expect(res.estimatedTruePeakDbTp).toBeNull();
      // By tie-break (earliest frame, smallest quarter, smallest channel):
      expect(res.samplePeakFrame).toBe(0);
      expect(res.samplePeakChannel).toBe(0);
      expect(res.estimatedPeakPosition).toEqual({
        frame: 0,
        quarter: 0,
        channel: 0,
      });
    });

    it('accepts raw Float64Array[] planar channels directly', () => {
      const frames = 100;
      const ch = new Float64Array(frames);
      ch[10] = 0.5;

      const res = estimateTruePeak([ch]);
      expect(res.samplePeak).toBe(0.5);
      expect(res.samplePeakFrame).toBe(10);
    });

    it('throws GainFrontError on invalid inputs', () => {
      // Invalid sample rate
      expect(() =>
        estimateTruePeak({
          sampleRate: 44100 as unknown as 48000,
          channels: 1,
          frames: 100,
          planar: [new Float64Array(100)],
        }),
      ).toThrow(GainFrontError);

      // Invalid channel count
      expect(() =>
        estimateTruePeak({
          sampleRate: 48000,
          channels: 3 as unknown as 1,
          frames: 100,
          planar: [new Float64Array(100), new Float64Array(100), new Float64Array(100)],
        }),
      ).toThrow(GainFrontError);

      // Empty channel array
      expect(() => estimateTruePeak([])).toThrow(GainFrontError);

      // Non-Float64 channel
      expect(() =>
        estimateTruePeak({
          sampleRate: 48000,
          channels: 1,
          frames: 100,
          planar: [new Float32Array(100) as unknown as Float64Array],
        }),
      ).toThrow(GainFrontError);

      // Mismatched channel length
      expect(() =>
        estimateTruePeak({
          sampleRate: 48000,
          channels: 1,
          frames: 100,
          planar: [new Float64Array(90)],
        }),
      ).toThrow(GainFrontError);
    });
  });
});
