/**
 * 4× Interpolated True Peak Estimation (48kHz)
 *
 * Implements 4× oversampled inter-sample peak estimation using a 33-point
 * (radius 16) symmetric cosine-windowed sinc filter per PROJECT_BOOK.md §5.4
 * and P010-T006 task card.
 *
 * IMPORTANT ESTIMATION DISCLAIMER / 近似属性免责声明:
 * -------------------------------------------------------------------------
 * This algorithm provides a simplified 4× windowed-sinc interpolated peak estimation.
 * It is NOT an ITU-R BS.1770 Annex 2 certified true-peak compliance meter.
 * Approximation differences may exist, particularly near the Nyquist frequency
 * and signal boundaries.
 * In accordance with PROJECT_BOOK.md §5.4, all display and documentation terms
 * MUST explicitly designate this quantity as "estimated dBTP", NEVER claiming
 * it as an official or certified ITU dBTP compliance value.
 * -------------------------------------------------------------------------
 *
 * Mathematical Specification:
 * - samplePeak = max_{n, c} |x[n, c]|
 * - 4× Interpolation: 33 points (radius 16) symmetric cosine-windowed sinc.
 *   For each channel c, integer frame n (0 <= n < N), and k in {0, 1, 2, 3}:
 *     t = n + k / 4
 *     sinc(q) = 1 (if q == 0) else sin(π*q) / (π*q)
 *     w(q) = (1 + cos(π*q / 16)) / 2 (if |q| <= 16) else 0
 *     xhat(t) = sum_{m integer, |m-t|<=16, 0<=m<N} x[m]*sinc(t-m)*w(t-m)
 * - Boundary handling: Out-of-range samples (m < 0 or m >= N) are strictly zero.
 *   Window coefficients are NOT renormalized, avoiding input-dependent weights.
 * - Deterministic tie-break: Earliest frame n, minimum quarter k, minimum channel c.
 * - TPamp = max(|xhat(t)|, samplePeak); TPdB = 20 * log10(TPamp).
 * - Computation uses raw unquantized Float64 (never quantized back to 16-bit).
 */

import { GainFrontError } from './errors.js';
import type { PCM, PeakPosition } from './types.js';

/**
 * Filter radius in integer frames: window extends from -16 to +16 frames.
 */
export const SINC_RADIUS = 16;

/**
 * Total integer points in filter kernel: 2 * SINC_RADIUS + 1 = 33 points.
 */
export const SINC_TABLE_SIZE = 33;

/**
 * Oversampling factor: 4× (phases k = 0, 1, 2, 3).
 */
export const OVERSAMPLE_FACTOR = 4;

/**
 * Normalized sinc function:
 *   sinc(q) = 1 if q == 0 else sin(pi * q) / (pi * q)
 *
 * Note: For non-zero integer q, mathematically sin(pi * q) = 0.
 * In IEEE 754 floating point, evaluating sin(pi * q) directly produces ~1e-16.
 * We return exact 0.0 for integer q to strictly preserve cardinal interpolation
 * identity xhat(n) === x[n] at k = 0.
 */
export function sinc(q: number): number {
  if (q === 0) return 1.0;
  if (Number.isInteger(q)) return 0.0;
  return Math.sin(Math.PI * q) / (Math.PI * q);
}

/**
 * Symmetric cosine (Hann) window function with radius 16:
 *   w(q) = (1 + cos(pi * q / 16)) / 2 if |q| <= 16 else 0
 */
export function cosineWindow(q: number): number {
  if (Math.abs(q) <= SINC_RADIUS) {
    return (1.0 + Math.cos((Math.PI * q) / SINC_RADIUS)) / 2.0;
  }
  return 0.0;
}

/**
 * Composite windowed sinc kernel:
 *   kernel(q) = sinc(q) * cosineWindow(q)
 */
export function windowedSinc(q: number): number {
  return sinc(q) * cosineWindow(q);
}

/**
 * Precomputes 4× phase interpolation tables.
 * For each phase k in {0, 1, 2, 3} and integer offset d in [-16, 16]:
 *   t - m = (n + k/4) - (n + d) = k/4 - d = q
 *   table[k][d + 16] = windowedSinc(k/4 - d)
 */
function createInterpolationTables(): readonly Float64Array[] {
  const tables: Float64Array[] = [];
  for (let k = 0; k < OVERSAMPLE_FACTOR; k++) {
    const table = new Float64Array(SINC_TABLE_SIZE);
    for (let d = -SINC_RADIUS; d <= SINC_RADIUS; d++) {
      const q = k / 4.0 - d;
      table[d + SINC_RADIUS] = windowedSinc(q);
    }
    tables.push(table);
  }
  return tables;
}

/**
 * Frozen static 4× interpolation weight tables (Float64).
 */
export const INTERPOLATION_TABLES: readonly Float64Array[] = createInterpolationTables();

/**
 * Result of 4× cosine-windowed sinc true peak estimation.
 */
export interface TruePeakResult {
  /**
   * Peak linear amplitude among raw samples: max_{n, c} |x[n, c]|.
   * Guaranteed to be >= 0.
   */
  samplePeak: number;

  /**
   * Sample peak level in dBFS: 20 * log10(samplePeak).
   * null if samplePeak <= 0 (silence or empty buffer).
   */
  samplePeakDbFs: number | null;

  /**
   * Zero-based frame index where the earliest sample peak occurs.
   * null if buffer has 0 frames.
   */
  samplePeakFrame: number | null;

  /**
   * Zero-based channel index where the earliest sample peak occurs (0 or 1).
   * null if buffer has 0 frames.
   */
  samplePeakChannel: 0 | 1 | null;

  /**
   * Estimated True Peak linear amplitude: max(|xhat(t)|, samplePeak).
   * Guaranteed to be >= samplePeak.
   */
  estimatedTruePeakAmp: number;

  /**
   * Estimated True Peak level in estimated dBTP: 20 * log10(estimatedTruePeakAmp).
   * null if estimatedTruePeakAmp <= 0 (silence or empty buffer).
   *
   * Note: This is a simplified 4× cosine-windowed sinc approximation,
   * NOT a certified ITU Annex 2 compliance reading.
   */
  estimatedTruePeakDbTp: number | null;

  /**
   * Sub-sample coordinate of the estimated true peak with deterministic tie-break:
   * earliest frame, minimum quarter k, minimum channel c.
   * null if buffer has 0 frames.
   */
  estimatedPeakPosition: PeakPosition | null;
}

/**
 * Directly evaluates the continuous reconstructed sample xhat(t) at any real coordinate t
 * for a specific channel using the 33-point windowed sinc filter:
 *   xhat(t) = sum_{m integer, |m-t|<=16, 0<=m<N} x[m] * sinc(t-m) * w(t-m)
 *
 * Boundary samples outside [0, frames) are zero, without window coefficient renormalization.
 *
 * @param channelData Float64Array of samples for one audio channel
 * @param t Real-valued time index (frame + sub-sample)
 * @param frames Optional explicit frame count (defaults to channelData.length)
 * @returns Reconstructed sample value in Float64
 */
export function interpolateSample(
  channelData: Float64Array,
  t: number,
  frames: number = channelData.length,
): number {
  if (frames <= 0) return 0.0;
  const minM = Math.max(0, Math.ceil(t - SINC_RADIUS));
  const maxM = Math.min(frames - 1, Math.floor(t + SINC_RADIUS));
  let sum = 0.0;
  for (let m = minM; m <= maxM; m++) {
    const q = t - m;
    sum += channelData[m] * windowedSinc(q);
  }
  return sum;
}

/**
 * Computes sample peak and 4× cosine-windowed sinc estimated true peak for PCM audio.
 *
 * Features:
 * - 33-point (radius 16) symmetric cosine-windowed sinc interpolator.
 * - 4× sub-sample evaluation: t = n + k / 4 for k in {0, 1, 2, 3}.
 * - Strict deterministic tie-break: earliest frame n, minimum quarter k, minimum channel c.
 * - Out-of-bounds boundary zero padding without window renormalization.
 * - Pure Float64 arithmetic throughout, no 16-bit requantization.
 * - Results clearly typed and documented with the "estimated" attribute.
 *
 * @param input PCM object or Float64Array[] planar channel array
 * @returns TruePeakResult with samplePeak, estimated true peak, and coordinate localization
 */
export function estimateTruePeak(
  input: PCM | readonly Float64Array[],
): TruePeakResult {
  let channels: readonly Float64Array[];
  let frames: number;

  if (typeof input === 'object' && input !== null && 'planar' in input) {
    const pcm = input as PCM;
    if (pcm.sampleRate !== 48000) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        `Unsupported sample rate ${pcm.sampleRate}Hz for true-peak estimation. GainFront requires 48000Hz.`,
        { sampleRate: pcm.sampleRate, expected: 48000 },
      );
    }
    if (!Array.isArray(pcm.planar) || pcm.planar.length === 0) {
      throw new GainFrontError(
        'INVALID_PCM',
        'PCM planar must be a non-empty array of channel buffers',
      );
    }
    channels = pcm.planar;
    frames = pcm.frames;
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new GainFrontError('INVALID_PCM', 'Input channel array must not be empty');
    }
    channels = input;
    frames = Math.min(...channels.map((ch) => ch.length));
  } else {
    throw new GainFrontError(
      'INVALID_PCM',
      'estimateTruePeak requires a PCM object or Float64Array[] planar buffer',
    );
  }

  const numChannels = channels.length;
  if (numChannels !== 1 && numChannels !== 2) {
    throw new GainFrontError(
      'UNSUPPORTED_WAV',
      `Unsupported channel count ${numChannels}. GainFront requires mono (1) or stereo (2).`,
      { channels: numChannels, expected: [1, 2] },
    );
  }

  for (let c = 0; c < numChannels; c++) {
    const channelData = channels[c];
    if (!(channelData instanceof Float64Array)) {
      throw new GainFrontError('INVALID_PCM', `Channel ${c} must be a Float64Array`);
    }
    if (channelData.length !== frames) {
      throw new GainFrontError(
        'INVALID_PCM',
        `Channel ${c} length ${channelData.length} does not match frame count ${frames}`,
      );
    }
  }

  // Edge case: Empty buffer (0 frames)
  if (frames === 0) {
    return {
      samplePeak: 0.0,
      samplePeakDbFs: null,
      samplePeakFrame: null,
      samplePeakChannel: null,
      estimatedTruePeakAmp: 0.0,
      estimatedTruePeakDbTp: null,
      estimatedPeakPosition: null,
    };
  }

  let samplePeak = 0.0;
  let samplePeakFrame = 0;
  let samplePeakChannel: 0 | 1 = 0;

  let maxEstAmp = 0.0;
  let bestEstimatedPos: PeakPosition = { frame: 0, quarter: 0, channel: 0 };

  const ch0 = channels[0];
  const isStereo = numChannels === 2;
  const ch1 = isStereo ? channels[1] : ch0;

  const t1 = INTERPOLATION_TABLES[1];
  const t2 = INTERPOLATION_TABLES[2];
  const t3 = INTERPOLATION_TABLES[3];

  // Helper for evaluating single frame with exact tie-break order (n, k, c)
  const processFrameAtBoundary = (n: number) => {
    // k = 0
    const s0 = Math.abs(ch0[n]);
    if (s0 > samplePeak) {
      samplePeak = s0;
      samplePeakFrame = n;
      samplePeakChannel = 0;
    }
    if (s0 > maxEstAmp) {
      maxEstAmp = s0;
      bestEstimatedPos = { frame: n, quarter: 0, channel: 0 };
    }

    if (isStereo) {
      const s1 = Math.abs(ch1[n]);
      if (s1 > samplePeak) {
        samplePeak = s1;
        samplePeakFrame = n;
        samplePeakChannel = 1;
      }
      if (s1 > maxEstAmp) {
        maxEstAmp = s1;
        bestEstimatedPos = { frame: n, quarter: 0, channel: 1 };
      }
    }

    const minD = n < SINC_RADIUS ? -n : -SINC_RADIUS;
    const maxD = n + SINC_RADIUS >= frames ? frames - 1 - n : SINC_RADIUS;

    for (let k = 1; k < OVERSAMPLE_FACTOR; k++) {
      const tbl = INTERPOLATION_TABLES[k];

      let sum0 = 0.0;
      for (let d = minD; d <= maxD; d++) {
        sum0 += ch0[n + d] * tbl[d + SINC_RADIUS];
      }
      const a0 = Math.abs(sum0);
      if (a0 > maxEstAmp) {
        maxEstAmp = a0;
        bestEstimatedPos = { frame: n, quarter: k as 0 | 1 | 2 | 3, channel: 0 };
      }

      if (isStereo) {
        let sum1 = 0.0;
        for (let d = minD; d <= maxD; d++) {
          sum1 += ch1[n + d] * tbl[d + SINC_RADIUS];
        }
        const a1 = Math.abs(sum1);
        if (a1 > maxEstAmp) {
          maxEstAmp = a1;
          bestEstimatedPos = { frame: n, quarter: k as 0 | 1 | 2 | 3, channel: 1 };
        }
      }
    }
  };

  // If buffer is small (< 33 frames), evaluate entire buffer with boundary logic
  if (frames < SINC_TABLE_SIZE) {
    for (let n = 0; n < frames; n++) {
      processFrameAtBoundary(n);
    }
  } else {
    // 1. Head boundary (0 <= n < 16)
    for (let n = 0; n < SINC_RADIUS; n++) {
      processFrameAtBoundary(n);
    }

    // 2. Interior frames (16 <= n < frames - 16)
    // In interior, filter window is strictly contained in [0, frames) without clipping.
    // Inner loop loads each sample once for all phases k in {1, 2, 3}.
    const interiorEnd = frames - SINC_RADIUS;
    if (!isStereo) {
      for (let n = SINC_RADIUS; n < interiorEnd; n++) {
        // k = 0
        const s0 = Math.abs(ch0[n]);
        if (s0 > samplePeak) {
          samplePeak = s0;
          samplePeakFrame = n;
          samplePeakChannel = 0;
        }
        if (s0 > maxEstAmp) {
          maxEstAmp = s0;
          bestEstimatedPos = { frame: n, quarter: 0, channel: 0 };
        }

        const offset = n - SINC_RADIUS;
        let sum1 = 0.0;
        let sum2 = 0.0;
        let sum3 = 0.0;

        for (let i = 0; i < SINC_TABLE_SIZE; i++) {
          const x = ch0[offset + i];
          sum1 += x * t1[i];
          sum2 += x * t2[i];
          sum3 += x * t3[i];
        }

        const a1 = Math.abs(sum1);
        if (a1 > maxEstAmp) {
          maxEstAmp = a1;
          bestEstimatedPos = { frame: n, quarter: 1, channel: 0 };
        }

        const a2 = Math.abs(sum2);
        if (a2 > maxEstAmp) {
          maxEstAmp = a2;
          bestEstimatedPos = { frame: n, quarter: 2, channel: 0 };
        }

        const a3 = Math.abs(sum3);
        if (a3 > maxEstAmp) {
          maxEstAmp = a3;
          bestEstimatedPos = { frame: n, quarter: 3, channel: 0 };
        }
      }
    } else {
      // Stereo interior loop
      for (let n = SINC_RADIUS; n < interiorEnd; n++) {
        // k = 0
        const s0 = Math.abs(ch0[n]);
        if (s0 > samplePeak) {
          samplePeak = s0;
          samplePeakFrame = n;
          samplePeakChannel = 0;
        }
        if (s0 > maxEstAmp) {
          maxEstAmp = s0;
          bestEstimatedPos = { frame: n, quarter: 0, channel: 0 };
        }

        const s1 = Math.abs(ch1[n]);
        if (s1 > samplePeak) {
          samplePeak = s1;
          samplePeakFrame = n;
          samplePeakChannel = 1;
        }
        if (s1 > maxEstAmp) {
          maxEstAmp = s1;
          bestEstimatedPos = { frame: n, quarter: 0, channel: 1 };
        }

        const offset = n - SINC_RADIUS;
        let sum1_0 = 0.0;
        let sum2_0 = 0.0;
        let sum3_0 = 0.0;
        let sum1_1 = 0.0;
        let sum2_1 = 0.0;
        let sum3_1 = 0.0;

        for (let i = 0; i < SINC_TABLE_SIZE; i++) {
          const w1 = t1[i];
          const w2 = t2[i];
          const w3 = t3[i];

          const x0 = ch0[offset + i];
          sum1_0 += x0 * w1;
          sum2_0 += x0 * w2;
          sum3_0 += x0 * w3;

          const x1 = ch1[offset + i];
          sum1_1 += x1 * w1;
          sum2_1 += x1 * w2;
          sum3_1 += x1 * w3;
        }

        // k = 1
        const a1_0 = Math.abs(sum1_0);
        if (a1_0 > maxEstAmp) {
          maxEstAmp = a1_0;
          bestEstimatedPos = { frame: n, quarter: 1, channel: 0 };
        }
        const a1_1 = Math.abs(sum1_1);
        if (a1_1 > maxEstAmp) {
          maxEstAmp = a1_1;
          bestEstimatedPos = { frame: n, quarter: 1, channel: 1 };
        }

        // k = 2
        const a2_0 = Math.abs(sum2_0);
        if (a2_0 > maxEstAmp) {
          maxEstAmp = a2_0;
          bestEstimatedPos = { frame: n, quarter: 2, channel: 0 };
        }
        const a2_1 = Math.abs(sum2_1);
        if (a2_1 > maxEstAmp) {
          maxEstAmp = a2_1;
          bestEstimatedPos = { frame: n, quarter: 2, channel: 1 };
        }

        // k = 3
        const a3_0 = Math.abs(sum3_0);
        if (a3_0 > maxEstAmp) {
          maxEstAmp = a3_0;
          bestEstimatedPos = { frame: n, quarter: 3, channel: 0 };
        }
        const a3_1 = Math.abs(sum3_1);
        if (a3_1 > maxEstAmp) {
          maxEstAmp = a3_1;
          bestEstimatedPos = { frame: n, quarter: 3, channel: 1 };
        }
      }
    }

    // 3. Tail boundary (frames - 16 <= n < frames)
    for (let n = interiorEnd; n < frames; n++) {
      processFrameAtBoundary(n);
    }
  }

  const tpAmp = Math.max(maxEstAmp, samplePeak);
  const samplePeakDbFs = samplePeak > 0 ? 20.0 * Math.log10(samplePeak) : null;
  const estimatedTruePeakDbTp = tpAmp > 0 ? 20.0 * Math.log10(tpAmp) : null;

  return {
    samplePeak,
    samplePeakDbFs,
    samplePeakFrame,
    samplePeakChannel,
    estimatedTruePeakAmp: tpAmp,
    estimatedTruePeakDbTp,
    estimatedPeakPosition: bestEstimatedPos,
  };
}
