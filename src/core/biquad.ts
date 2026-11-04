/**
 * K-weighting Dual Biquad Filter (48kHz)
 *
 * Implements ITU-R BS.1770-4 48kHz dual-stage K-weighting filter per
 * PROJECT_BOOK.md §5.2 and P010-T004 task card.
 *
 * Cascade topology:
 *   Stage 1: High-shelving filter (pre-filter)
 *   Stage 2: High-pass filter (RLB weighting filter)
 *
 * Direct Form I Difference Equation:
 *   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 *   with a0 = 1, double precision (Float64).
 *
 * State contract:
 * - Every channel is strictly independent.
 * - Initial filter state is strictly zero for each invocation (zero-state response).
 * - No external DSP package is used.
 */

import { GainFrontError } from './errors.js';
import type { PCM } from './types.js';

/**
 * Biquad filter coefficients for Direct Form I difference equation:
 *   y[n] = b[0]*x[n] + b[1]*x[n-1] + b[2]*x[n-2] - a[1]*y[n-1] - a[2]*y[n-2]
 * Normalized such that a[0] = 1.
 */
export interface BiquadCoefficients {
  readonly b: readonly [number, number, number];
  readonly a: readonly [number, number, number];
}

/**
 * 48kHz K-weighting Stage 1: High-shelving filter (pre-filter).
 * Verbatim table coefficients per PROJECT_BOOK.md §5.2.
 */
export const K_SHELF_COEFFICIENTS: BiquadCoefficients = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1, -1.69065929318241, 0.73248077421585],
};

/**
 * 48kHz K-weighting Stage 2: High-pass filter (RLB weighting).
 * Verbatim table coefficients per PROJECT_BOOK.md §5.2.
 */
export const K_HIGHPASS_COEFFICIENTS: BiquadCoefficients = {
  b: [1, -2, 1],
  a: [1, -1.99004745483398, 0.99007225036621],
};

/**
 * Applies a single biquad filter (Direct Form I) to a channel Float64Array.
 * Difference equation:
 *   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 *
 * Zero initial state is strictly enforced:
 *   x[-1] = 0, x[-2] = 0, y[-1] = 0, y[-2] = 0.
 *
 * @param input Float64Array of audio samples
 * @param coeffs Biquad coefficients (b0, b1, b2, a0=1, a1, a2)
 * @returns Filtered Float64Array of identical length
 */
export function applyBiquad(
  input: Float64Array,
  coeffs: BiquadCoefficients,
): Float64Array {
  const len = input.length;
  const out = new Float64Array(len);
  const [b0, b1, b2] = coeffs.b;
  const [, a1, a2] = coeffs.a;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let n = 0; n < len; n++) {
    const x0 = input[n];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[n] = y0;
  }

  return out;
}

/**
 * Applies 48kHz dual-stage K-weighting to a single audio channel:
 *   Stage 1: High-shelving filter (K_SHELF_COEFFICIENTS)
 *   Stage 2: High-pass filter (K_HIGHPASS_COEFFICIENTS)
 *
 * Filter state is strictly initialized to zero on every invocation.
 *
 * @param channel Float64Array audio samples for one channel
 * @returns Filtered Float64Array
 */
export function applyKWeightChannel(channel: Float64Array): Float64Array {
  const shelf = applyBiquad(channel, K_SHELF_COEFFICIENTS);
  return applyBiquad(shelf, K_HIGHPASS_COEFFICIENTS);
}

/**
 * Applies 48kHz dual-stage K-weighting to all channels in a PCM structure or planar array.
 *
 * Each channel is processed independently with zero initial state.
 * Monophonic channel weight G=1, stereophonic L/R each G=1.
 * Dual-mono compensation is NOT applied per §5.2.
 *
 * @param input PCM object or array of Float64Array channels
 * @returns Array of filtered Float64Array channels
 */
export function applyKWeight(input: PCM | readonly Float64Array[]): Float64Array[] {
  let channels: readonly Float64Array[];

  if (typeof input === 'object' && input !== null && 'planar' in input) {
    const pcm = input as PCM;
    if (pcm.sampleRate !== 48000) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        `Unsupported sample rate ${pcm.sampleRate}Hz for K-weighting. GainFront requires 48000Hz.`,
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
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new GainFrontError(
        'INVALID_PCM',
        'Input channel array must not be empty',
      );
    }
    channels = input;
  } else {
    throw new GainFrontError(
      'INVALID_PCM',
      'applyKWeight requires a PCM object or Float64Array[] planar buffer',
    );
  }

  const result: Float64Array[] = new Array(channels.length);
  for (let ch = 0; ch < channels.length; ch++) {
    const channelData = channels[ch];
    if (!(channelData instanceof Float64Array)) {
      throw new GainFrontError(
        'INVALID_PCM',
        `Channel ${ch} data must be a Float64Array`,
      );
    }
    result[ch] = applyKWeightChannel(channelData);
  }

  return result;
}
