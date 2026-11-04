/**
 * Tests for K-weighting Dual Biquad Filter (P010-T004)
 *
 * Covers:
 * - MATH01: Verbatim 48k IIR coefficients per PROJECT_BOOK.md §5.2 (< 1e-12 difference)
 * - MATH01: All-zero input produces strictly zero output (zero-state response)
 * - MATH01: Highpass DC response decays to near-zero
 * - Shelving filter DC unity gain (0 dB steady state)
 * - Impulse response spot checks for stage 1, stage 2, and combined K-weighting
 * - Dual-channel independence (changing one channel has zero effect on the other)
 * - Zero initial state on every invocation (no state leakage between runs)
 * - Preset integration (GF-B mono, GF-C stereo identical channel preservation)
 * - Error handling for invalid sample rates and non-Float64Array buffers
 */

import { describe, expect, it } from 'vitest';
import {
  applyBiquad,
  applyKWeight,
  applyKWeightChannel,
  K_HIGHPASS_COEFFICIENTS,
  K_SHELF_COEFFICIENTS,
} from '../../src/core/biquad.js';
import { GainFrontError } from '../../src/core/errors.js';
import { makePreset } from '../../src/core/presets.js';
import type { PCM } from '../../src/core/types.js';

describe('P010-T004 K-weighting Dual Biquad Filter', () => {
  describe('MATH01: Verbatim 48k IIR Coefficients Verification', () => {
    it('shelf filter coefficients match PROJECT_BOOK.md §5.2 verbatim with delta < 1e-12', () => {
      // Expected from §5.2:
      // shelf b=[1.53512485958697,-2.69169618940638,1.19839281085285]
      // shelf a=[1,-1.69065929318241,0.73248077421585]
      const expectedShelfB = [1.53512485958697, -2.69169618940638, 1.19839281085285];
      const expectedShelfA = [1.0, -1.69065929318241, 0.73248077421585];

      expect(K_SHELF_COEFFICIENTS.b.length).toBe(3);
      expect(K_SHELF_COEFFICIENTS.a.length).toBe(3);

      for (let i = 0; i < 3; i++) {
        expect(Math.abs(K_SHELF_COEFFICIENTS.b[i] - expectedShelfB[i])).toBeLessThan(1e-12);
        expect(K_SHELF_COEFFICIENTS.b[i]).toBe(expectedShelfB[i]);
      }

      for (let i = 0; i < 3; i++) {
        expect(Math.abs(K_SHELF_COEFFICIENTS.a[i] - expectedShelfA[i])).toBeLessThan(1e-12);
        expect(K_SHELF_COEFFICIENTS.a[i]).toBe(expectedShelfA[i]);
      }
    });

    it('highpass filter coefficients match PROJECT_BOOK.md §5.2 verbatim with delta < 1e-12', () => {
      // Expected from §5.2:
      // highpass b=[1,-2,1]
      // highpass a=[1,-1.99004745483398,0.99007225036621]
      const expectedHighpassB = [1.0, -2.0, 1.0];
      const expectedHighpassA = [1.0, -1.99004745483398, 0.99007225036621];

      expect(K_HIGHPASS_COEFFICIENTS.b.length).toBe(3);
      expect(K_HIGHPASS_COEFFICIENTS.a.length).toBe(3);

      for (let i = 0; i < 3; i++) {
        expect(Math.abs(K_HIGHPASS_COEFFICIENTS.b[i] - expectedHighpassB[i])).toBeLessThan(1e-12);
        expect(K_HIGHPASS_COEFFICIENTS.b[i]).toBe(expectedHighpassB[i]);
      }

      for (let i = 0; i < 3; i++) {
        expect(Math.abs(K_HIGHPASS_COEFFICIENTS.a[i] - expectedHighpassA[i])).toBeLessThan(1e-12);
        expect(K_HIGHPASS_COEFFICIENTS.a[i]).toBe(expectedHighpassA[i]);
      }
    });

    it('MATH01: all-zero input produces strictly zero output across all samples', () => {
      const lengths = [1, 10, 256, 48000];
      for (const len of lengths) {
        const zeroChannel = new Float64Array(len);
        const filtered = applyKWeightChannel(zeroChannel);

        expect(filtered.length).toBe(len);
        for (let i = 0; i < len; i++) {
          expect(filtered[i]).toBe(0);
        }
      }
    });

    it('MATH01: highpass filter DC response decays to near-zero', () => {
      // A constant DC step input (x[n] = 1.0) into the highpass filter alone
      // Highpass numerator sum is b0 + b1 + b2 = 1 - 2 + 1 = 0.
      // Therefore, the DC transfer function H(z=1) is identically 0.
      const N = 48000; // 1 second at 48kHz
      const dcInput = new Float64Array(N).fill(1.0);
      const hpOutput = applyBiquad(dcInput, K_HIGHPASS_COEFFICIENTS);

      // After 0.1 second (4800 samples), DC response is already < 1e-8
      expect(Math.abs(hpOutput[4800])).toBeLessThan(1e-8);

      // At end of 1 second (sample 47999), DC response is near zero (< 1e-12)
      expect(Math.abs(hpOutput[N - 1])).toBeLessThan(1e-12);

      // Also verify combined K-weighting with DC input decays to near zero
      const kWeightedDC = applyKWeightChannel(dcInput);
      expect(Math.abs(kWeightedDC[4800])).toBeLessThan(1e-8);
      expect(Math.abs(kWeightedDC[N - 1])).toBeLessThan(1e-12);
    });

    it('shelf filter DC gain is unity (0 dB steady state)', () => {
      // For the shelving filter at DC (z = 1):
      // sum(b) = 1.53512485958697 - 2.69169618940638 + 1.19839281085285 = 0.04182148103344
      // sum(a) = 1 - 1.69065929318241 + 0.73248077421585 = 0.04182148103344
      // H_shelf(1) = sum(b) / sum(a) = 1.0 (exact 0 dB at DC)
      const N = 48000;
      const dcInput = new Float64Array(N).fill(1.0);
      const shelfOutput = applyBiquad(dcInput, K_SHELF_COEFFICIENTS);

      // In steady state, shelf output must converge to exactly 1.0
      expect(shelfOutput[N - 1]).toBeCloseTo(1.0, 10);
      expect(Math.abs(shelfOutput[N - 1] - 1.0)).toBeLessThan(1e-12);
    });
  });

  describe('Impulse Response Spot Checks (Zero-State Response)', () => {
    it('verifies exact analytical values for Stage 1 (shelving) impulse response', () => {
      const impulse = new Float64Array(10);
      impulse[0] = 1.0;

      const s = applyBiquad(impulse, K_SHELF_COEFFICIENTS);

      // n = 0: b0 = 1.53512485958697
      expect(s[0]).toBeCloseTo(1.53512485958697, 14);

      // n = 1: b1 - a1 * s[0] = -2.69169618940638 - (-1.69065929318241) * 1.53512485958697
      const expectedS1 = -2.69169618940638 + 1.69065929318241 * 1.53512485958697;
      expect(s[1]).toBeCloseTo(expectedS1, 14);
      expect(s[1]).toBeCloseTo(-0.09632307935032669, 14);

      // n = 2: b2 - a1 * s[1] - a2 * s[0]
      const expectedS2 = 1.19839281085285 + 1.69065929318241 * expectedS1 - 0.73248077421585 * 1.53512485958697;
      expect(s[2]).toBeCloseTo(expectedS2, 14);
      expect(s[2]).toBeCloseTo(-0.08890614406698827, 14);
    });

    it('verifies exact analytical values for Stage 2 (high-pass) impulse response', () => {
      const impulse = new Float64Array(10);
      impulse[0] = 1.0;

      const h = applyBiquad(impulse, K_HIGHPASS_COEFFICIENTS);

      // n = 0: b0 = 1.0
      expect(h[0]).toBe(1.0);

      // n = 1: b1 - a1 * h[0] = -2.0 - (-1.99004745483398) * 1.0 = -0.00995254516602
      expect(h[1]).toBeCloseTo(-0.00995254516602, 14);

      // n = 2: b2 - a1 * h[1] - a2 * h[0] = 1.0 - (-1.99004745483398)*h[1] - 0.99007225036621*1.0
      const expectedH2 = 1.0 + 1.99004745483398 * h[1] - 0.99007225036621;
      expect(h[2]).toBeCloseTo(expectedH2, 14);
    });

    it('verifies combined dual-stage K-weighting impulse response first 5 samples and decay', () => {
      const impulse = new Float64Array(48000);
      impulse[0] = 1.0;

      const y = applyKWeightChannel(impulse);

      // Handcrafted closed-form cascaded convolution values:
      // y[0] = b_shelf[0] * b_hp[0] = 1.53512485958697
      expect(y[0]).toBeCloseTo(1.53512485958697, 14);

      // y[1] = -0.11160147885084637
      expect(y[1]).toBeCloseTo(-0.11160147885084637, 14);

      // y[2] = -0.10311188904658364
      expect(y[2]).toBeCloseTo(-0.10311188904658364, 14);

      // y[3] = -0.09297001121705906
      expect(y[3]).toBeCloseTo(-0.09297001121705906, 14);

      // y[4] = -0.08203908862042975
      expect(y[4]).toBeCloseTo(-0.08203908862042975, 14);

      // Stability: impulse response must decay to zero
      expect(Math.abs(y[47999])).toBeLessThan(1e-12);
    });
  });

  describe('Channel Independence (双通道独立性)', () => {
    it('processes stereo channels completely independently without cross-talk', () => {
      const frames = 4800; // 0.1s
      const ch0 = new Float64Array(frames);
      const ch1 = new Float64Array(frames);

      // Channel 0 has high-energy 1000 Hz sine wave
      const omega = (2 * Math.PI * 1000) / 48000;
      for (let n = 0; n < frames; n++) {
        ch0[n] = 0.5 * Math.sin(omega * n);
      }
      // Channel 1 is completely silent (zeros)

      const stereoPcm: PCM = {
        sampleRate: 48000,
        channels: 2,
        frames,
        planar: [ch0, ch1],
      };

      const [filteredCh0, filteredCh1] = applyKWeight(stereoPcm);

      // Filtered Channel 0 has non-zero signal
      expect(filteredCh0.length).toBe(frames);
      let maxCh0 = 0;
      for (let n = 0; n < frames; n++) {
        maxCh0 = Math.max(maxCh0, Math.abs(filteredCh0[n]));
      }
      expect(maxCh0).toBeGreaterThan(0.1);

      // Filtered Channel 1 must remain strictly zero
      expect(filteredCh1.length).toBe(frames);
      for (let n = 0; n < frames; n++) {
        expect(filteredCh1[n]).toBe(0);
      }
    });

    it('modifying Channel 0 has strictly zero impact on Channel 1 output', () => {
      const frames = 4800;
      const ch1 = new Float64Array(frames);
      for (let n = 0; n < frames; n++) {
        ch1[n] = 0.05 * Math.cos((2 * Math.PI * 400 * n) / 48000);
      }

      // Run 1: Channel 0 is silent
      const ch0A = new Float64Array(frames);
      const resA = applyKWeight([ch0A, ch1]);

      // Run 2: Channel 0 has huge amplitude noise/pulses
      const ch0B = new Float64Array(frames);
      for (let n = 0; n < frames; n++) {
        ch0B[n] = n % 2 === 0 ? 0.99 : -0.99;
      }
      const resB = applyKWeight([ch0B, ch1]);

      // Channel 1 output in Run A and Run B must be bitwise identical
      for (let n = 0; n < frames; n++) {
        expect(resA[1][n]).toBe(resB[1][n]);
      }
    });

    it('filtering stereo channels together equals filtering each channel individually', () => {
      const pcmC = makePreset('GF-C'); // 2-channel stereo with identical 1000 Hz signals
      const [filteredL, filteredR] = applyKWeight(pcmC);

      const singleL = applyKWeightChannel(pcmC.planar[0]);
      const singleR = applyKWeightChannel(pcmC.planar[1]);

      for (let n = 0; n < 1000; n++) {
        expect(filteredL[n]).toBe(singleL[n]);
        expect(filteredR[n]).toBe(singleR[n]);
        expect(filteredL[n]).toBe(filteredR[n]);
      }
    });
  });

  describe('Zero Initial State & Stateless Invocations', () => {
    it('resets filter state completely to zero on every invocation', () => {
      const frames = 1000;
      const highEnergy = new Float64Array(frames).fill(0.9);
      const silence = new Float64Array(frames);

      // Run high-energy signal first
      applyKWeightChannel(highEnergy);

      // Run silence immediately after
      const silenceOutput = applyKWeightChannel(silence);

      // All samples of silenceOutput must be strictly 0 (no lingering filter state)
      for (let n = 0; n < frames; n++) {
        expect(silenceOutput[n]).toBe(0);
      }
    });

    it('is strictly deterministic and yields identical Float64 bits on repeated runs', () => {
      const pcmB = makePreset('GF-B');
      const run1 = applyKWeight(pcmB);
      const run2 = applyKWeight(pcmB);

      expect(run1[0].length).toBe(run2[0].length);
      for (let n = 0; n < 1000; n++) {
        expect(run1[0][n]).toBe(run2[0][n]);
      }
    });

    it('preserves leading zeros without drift for signals with silence prefix', () => {
      const pcmF = makePreset('GF-F'); // 96000 frames of silence followed by sine wave
      const [filtered] = applyKWeight(pcmF);

      // For n < 96000, output must be strictly 0
      for (let n = 0; n < 96000; n += 1000) {
        expect(filtered[n]).toBe(0);
      }
      expect(filtered[95999]).toBe(0);

      // For n >= 96000, signal becomes non-zero
      let nonZeroCount = 0;
      for (let n = 96000; n < 97000; n++) {
        if (filtered[n] !== 0) nonZeroCount++;
      }
      expect(nonZeroCount).toBeGreaterThan(900);
    });
  });

  describe('Input Validation & Error Handling', () => {
    it('rejects PCM with sampleRate other than 48000 with UNSUPPORTED_WAV error', () => {
      const badPcm = {
        sampleRate: 44100 as unknown as 48000,
        channels: 1 as const,
        frames: 48000,
        planar: [new Float64Array(48000)],
      };

      expect(() => applyKWeight(badPcm)).toThrow(GainFrontError);
      try {
        applyKWeight(badPcm);
      } catch (err) {
        expect(err).toBeInstanceOf(GainFrontError);
        expect((err as GainFrontError).code).toBe('UNSUPPORTED_WAV');
      }
    });

    it('rejects empty channel array or invalid planar buffer with INVALID_PCM error', () => {
      expect(() => applyKWeight([])).toThrow(GainFrontError);
      expect(() => applyKWeight(null as unknown as PCM)).toThrow(GainFrontError);

      const invalidChannelPcm = {
        sampleRate: 48000 as const,
        channels: 1 as const,
        frames: 10,
        planar: ['not-a-float-array' as unknown as Float64Array],
      };
      expect(() => applyKWeight(invalidChannelPcm)).toThrow(GainFrontError);
    });

    it('does not mutate input buffers', () => {
      const frames = 100;
      const input = new Float64Array(frames);
      for (let i = 0; i < frames; i++) input[i] = i * 0.01;
      const inputCopy = new Float64Array(input);

      applyKWeightChannel(input);

      for (let i = 0; i < frames; i++) {
        expect(input[i]).toBe(inputCopy[i]);
      }
    });
  });
});
