/**
 * Two-Stage 400ms Gating and Integrated Loudness (48kHz)
 *
 * Implements ITU-R BS.1770-4 §5.3 two-stage gating per PROJECT_BOOK.md §5.3
 * and P010-T005 task card.
 *
 * Specifications:
 * - Window length N = 19200 frames (0.4s @ 48kHz).
 * - Hop size H = 4800 frames (0.1s @ 48kHz).
 * - Only windows completely contained in the signal are evaluated (no zero-padding at boundaries).
 * - Channel block power: z[j, c] = sum_{n=jH}^{jH+N-1} (y_c[n]^2) / N.
 * - Total block power: E[j] = sum_c z[j, c] (G_c = 1 for mono and stereo L/R; no dual-mono compensation).
 * - Block loudness: L[j] = -0.691 + 10 * log10(E[j]); zero-energy blocks have L[j] = -Infinity.
 * - Absolute gate: A = { j | L[j] > -70 LUFS } (strictly greater).
 * - If A is empty -> NO_PROGRAM.
 * - Absolute mean: L_A = -0.691 + 10 * log10(mean_{j in A} E[j]).
 * - Relative threshold: relativeThreshold = max(-70, L_A - 10).
 * - Relative gate: R = { j in A | L[j] > relativeThreshold } (strictly greater).
 * - If R is empty -> NO_PROGRAM.
 * - Integrated loudness: I = -0.691 + 10 * log10(mean_{j in R} E[j]).
 * - Pure block power API: evaluates gating on raw block powers without re-filtering (used for 481-grid search).
 */

import { applyKWeight } from './biquad.js';
import { GainFrontError } from './errors.js';
import type { GateSummary, PCM } from './types.js';

// --- Numerical Constants per PROJECT_BOOK.md §5.3 & §4.3 ---
export const BLOCK_SIZE_FRAMES = 19200; // 0.4s at 48kHz
export const HOP_SIZE_FRAMES = 4800; // 0.1s at 48kHz
export const BLOCK_DURATION_SEC = 0.4;
export const HOP_DURATION_SEC = 0.1;
export const LUFS_OFFSET = -0.691;
export const ABSOLUTE_THRESHOLD_LUFS = -70.0;
export const RELATIVE_THRESHOLD_OFFSET_LU = -10.0;

/**
 * Result of two-stage gating evaluation.
 */
export interface GatingResult {
  /**
   * Integrated loudness in LUFS per ITU-R BS.1770-4 §5.3.
   * null if NO_PROGRAM (no active blocks pass absolute or relative gate).
   */
  integratedLufs: number | null;

  /**
   * Whether the signal has NO_PROGRAM (no active audio content above gate).
   */
  isNoProgram: boolean;

  /**
   * Total power E[j] for each complete 400ms block.
   */
  blockPowers: number[];

  /**
   * Loudness L[j] in LUFS for each 400ms block.
   * -Infinity for zero-energy blocks.
   */
  blockLoudness: number[];

  /**
   * Boolean flag for each block indicating whether L[j] > -70 LUFS.
   */
  absoluteGate: boolean[];

  /**
   * Boolean flag for each block indicating whether L[j] > max(-70, L_A - 10).
   */
  relativeGate: boolean[];

  /**
   * Loudness of absolute-gated blocks L_A, or null if NO_PROGRAM.
   */
  lA: number | null;

  /**
   * Relative threshold max(-70, L_A - 10), or null if NO_PROGRAM.
   */
  relativeThreshold: number | null;

  /**
   * Gate summary counts per PROJECT_BOOK §8.
   */
  gateSummary: GateSummary;
}

/**
 * Computes the number of complete 400ms (19200 frames) windows with 100ms (4800 frames) hop.
 * Trailing incomplete windows are excluded per §5.3 ("只取完全包含于信号的窗").
 *
 * @param totalFrames Total number of audio frames
 * @returns Number of complete blocks (0 if totalFrames < 19200)
 */
export function computeBlockCount(totalFrames: number): number {
  if (totalFrames < BLOCK_SIZE_FRAMES) {
    return 0;
  }
  return Math.floor((totalFrames - BLOCK_SIZE_FRAMES) / HOP_SIZE_FRAMES) + 1;
}

/**
 * Computes block powers E[j] across all channels for filtered audio.
 * Input must already be K-weighted (via applyKWeight).
 *
 * Formula:
 *   z[j, c] = sum_{n=jH}^{jH+N-1} (y_c[n]^2) / N
 *   E[j] = sum_c z[j, c]
 *
 * @param input K-weighted PCM object or array of filtered Float64Array channels
 * @returns Array of block powers E[j] (length equals computeBlockCount(totalFrames))
 */
export function computeBlockPowers(input: PCM | readonly Float64Array[]): number[] {
  let channels: readonly Float64Array[];

  if (typeof input === 'object' && input !== null && 'planar' in input) {
    const pcm = input as PCM;
    if (pcm.sampleRate !== 48000) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        `Unsupported sample rate ${pcm.sampleRate}Hz for gating. GainFront requires 48000Hz.`,
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
      throw new GainFrontError('INVALID_PCM', 'Input channel array must not be empty');
    }
    channels = input;
  } else {
    throw new GainFrontError(
      'INVALID_PCM',
      'computeBlockPowers requires a PCM object or Float64Array[] planar buffer',
    );
  }

  const numChannels = channels.length;
  for (let c = 0; c < numChannels; c++) {
    if (!(channels[c] instanceof Float64Array)) {
      throw new GainFrontError('INVALID_PCM', `Channel ${c} must be a Float64Array`);
    }
  }

  const totalFrames = Math.min(...channels.map((ch) => ch.length));
  const blockCount = computeBlockCount(totalFrames);

  if (blockCount === 0) {
    return [];
  }

  const blockPowers = new Float64Array(blockCount);
  const invN = 1.0 / BLOCK_SIZE_FRAMES;

  for (let j = 0; j < blockCount; j++) {
    const start = j * HOP_SIZE_FRAMES;
    const end = start + BLOCK_SIZE_FRAMES;
    let totalPower = 0.0;

    for (let c = 0; c < numChannels; c++) {
      const channel = channels[c];
      let sumSq = 0.0;
      for (let n = start; n < end; n++) {
        const s = channel[n];
        sumSq += s * s;
      }
      totalPower += sumSq * invN;
    }

    blockPowers[j] = totalPower;
  }

  return Array.from(blockPowers);
}

/**
 * Pure Block Power Two-Stage Gating API.
 *
 * Runs the absolute gate and relative gate per ITU-R BS.1770-4 §5.3 on precomputed
 * block powers E[j], with an optional constant gain in dB applied.
 *
 * If gainDb is specified:
 *   E_scaled[j] = E[j] * 10^(gainDb / 10)
 *
 * Comparisons:
 * - Absolute gate: L[j] > -70 (strictly greater, never >=)
 * - Relative gate: L[j] > max(-70, L_A - 10) (strictly greater, never >=)
 * - Returns NO_PROGRAM (integratedLufs: null) if either gate is empty.
 *
 * @param blockPowers Array or Float64Array of block powers E[j]
 * @param gainDb Optional gain in dB (defaults to 0.0)
 * @returns GatingResult
 */
export function gateBlockPowers(
  blockPowers: readonly number[] | Float64Array,
  gainDb = 0,
): GatingResult {
  const blockCount = blockPowers.length;

  if (blockCount === 0) {
    return {
      integratedLufs: null,
      isNoProgram: true,
      blockPowers: [],
      blockLoudness: [],
      absoluteGate: [],
      relativeGate: [],
      lA: null,
      relativeThreshold: null,
      gateSummary: {
        blockCount: 0,
        absoluteGateCount: 0,
        relativeGateCount: 0,
      },
    };
  }

  const powerMultiplier = gainDb === 0 ? 1.0 : Math.pow(10, gainDb / 10);
  const powers = new Float64Array(blockCount);
  const loudness = new Float64Array(blockCount);
  const absoluteGate = new Array<boolean>(blockCount);
  const relativeGate = new Array<boolean>(blockCount);

  let absoluteGateCount = 0;
  let sumPowerA = 0.0;

  for (let j = 0; j < blockCount; j++) {
    const pRaw = blockPowers[j];
    const p = pRaw * powerMultiplier;
    powers[j] = p;

    let l: number;
    if (p <= 0 || !Number.isFinite(p)) {
      l = -Infinity;
    } else {
      l = LUFS_OFFSET + 10 * Math.log10(p);
    }
    loudness[j] = l;

    // Absolute gate: strictly L[j] > -70 per §5.3
    const passAbs = l > ABSOLUTE_THRESHOLD_LUFS;
    absoluteGate[j] = passAbs;
    relativeGate[j] = false;

    if (passAbs) {
      absoluteGateCount++;
      sumPowerA += p;
    }
  }

  // If A is empty -> NO_PROGRAM
  if (absoluteGateCount === 0) {
    return {
      integratedLufs: null,
      isNoProgram: true,
      blockPowers: Array.from(powers),
      blockLoudness: Array.from(loudness),
      absoluteGate,
      relativeGate,
      lA: null,
      relativeThreshold: null,
      gateSummary: {
        blockCount,
        absoluteGateCount: 0,
        relativeGateCount: 0,
      },
    };
  }

  // L_A = -0.691 + 10 * log10(mean_{j in A} E[j])
  const meanPowerA = sumPowerA / absoluteGateCount;
  const lA = LUFS_OFFSET + 10 * Math.log10(meanPowerA);

  // Relative threshold = max(-70, L_A - 10)
  const relativeThreshold = Math.max(
    ABSOLUTE_THRESHOLD_LUFS,
    lA + RELATIVE_THRESHOLD_OFFSET_LU,
  );

  let relativeGateCount = 0;
  let sumPowerR = 0.0;

  for (let j = 0; j < blockCount; j++) {
    // Only blocks j in A can qualify for R; strictly > relativeThreshold
    if (absoluteGate[j] && loudness[j] > relativeThreshold) {
      relativeGate[j] = true;
      relativeGateCount++;
      sumPowerR += powers[j];
    }
  }

  // If R is empty -> NO_PROGRAM
  if (relativeGateCount === 0) {
    return {
      integratedLufs: null,
      isNoProgram: true,
      blockPowers: Array.from(powers),
      blockLoudness: Array.from(loudness),
      absoluteGate,
      relativeGate,
      lA,
      relativeThreshold,
      gateSummary: {
        blockCount,
        absoluteGateCount,
        relativeGateCount: 0,
      },
    };
  }

  // Final I = -0.691 + 10 * log10(mean_{j in R} E[j])
  const meanPowerR = sumPowerR / relativeGateCount;
  const integratedLufs = LUFS_OFFSET + 10 * Math.log10(meanPowerR);

  return {
    integratedLufs,
    isNoProgram: false,
    blockPowers: Array.from(powers),
    blockLoudness: Array.from(loudness),
    absoluteGate,
    relativeGate,
    lA,
    relativeThreshold,
    gateSummary: {
      blockCount,
      absoluteGateCount,
      relativeGateCount,
    },
  };
}

/**
 * Fast pure block power integrated loudness calculator for grid evaluation.
 *
 * Specifically optimized for the 481-point grid search (T007):
 * avoids allocating intermediate boolean/loudness arrays while executing the exact
 * same two-stage gating algorithm.
 *
 * @param blockPowers Array or Float64Array of block powers E[j]
 * @param gainDb Optional gain in dB (defaults to 0.0)
 * @returns Integrated LUFS, or null if NO_PROGRAM
 */
export function computeGatedLufsFromPowers(
  blockPowers: readonly number[] | Float64Array,
  gainDb = 0,
): number | null {
  const blockCount = blockPowers.length;
  if (blockCount === 0) {
    return null;
  }

  const powerMultiplier = gainDb === 0 ? 1.0 : Math.pow(10, gainDb / 10);

  // Stage 1: Absolute gate
  let sumPowerA = 0.0;
  let countA = 0;

  for (let j = 0; j < blockCount; j++) {
    const p = blockPowers[j] * powerMultiplier;
    if (p > 0 && Number.isFinite(p)) {
      const l = LUFS_OFFSET + 10 * Math.log10(p);
      if (l > ABSOLUTE_THRESHOLD_LUFS) {
        sumPowerA += p;
        countA++;
      }
    }
  }

  if (countA === 0) {
    return null;
  }

  const meanPowerA = sumPowerA / countA;
  const lA = LUFS_OFFSET + 10 * Math.log10(meanPowerA);
  const relativeThreshold = Math.max(
    ABSOLUTE_THRESHOLD_LUFS,
    lA + RELATIVE_THRESHOLD_OFFSET_LU,
  );

  // Stage 2: Relative gate
  let sumPowerR = 0.0;
  let countR = 0;

  for (let j = 0; j < blockCount; j++) {
    const p = blockPowers[j] * powerMultiplier;
    if (p > 0 && Number.isFinite(p)) {
      const l = LUFS_OFFSET + 10 * Math.log10(p);
      if (l > relativeThreshold) {
        sumPowerR += p;
        countR++;
      }
    }
  }

  if (countR === 0) {
    return null;
  }

  const meanPowerR = sumPowerR / countR;
  return LUFS_OFFSET + 10 * Math.log10(meanPowerR);
}

/**
 * Runs two-stage gating on K-weighted audio.
 *
 * @param input K-weighted PCM object or array of filtered Float64Array channels
 * @param gainDb Optional gain in dB (defaults to 0.0)
 * @returns GatingResult
 */
export function gateFilteredPcm(
  input: PCM | readonly Float64Array[],
  gainDb = 0,
): GatingResult {
  const blockPowers = computeBlockPowers(input);
  return gateBlockPowers(blockPowers, gainDb);
}

/**
 * High-level gating helper: applies K-weighting filter to raw PCM and computes two-stage gating.
 *
 * @param pcm Input raw PCM (sampleRate: 48000, 1 or 2 channels)
 * @param gainDb Optional gain in dB (defaults to 0.0)
 * @returns GatingResult
 */
export function gateRawPcm(pcm: PCM, gainDb = 0): GatingResult {
  const filtered = applyKWeight(pcm);
  return gateFilteredPcm(filtered, gainDb);
}
