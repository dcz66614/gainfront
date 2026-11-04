/**
 * 481-Grid Gain Optimization and Loudness/True-Peak Solver
 *
 * Implements discrete 481-grid constant-gain feasible region search,
 * two-stage re-gating across all candidates, and deterministic tie-breaking
 * per PROJECT_BOOK.md §5.5, §8.1, §8.2 and P010-T007 task card.
 *
 * Mathematical Specification:
 * - Candidate gain grid: G = {-24.0, -23.9, ..., +24.0} dB
 *   Integer ticks q in [-240, 240] (total 481 points), g = q / 10 dB.
 * - For each tick q:
 *     p = 10^(g / 10)
 *     Re-evaluate two-stage gating on scaled block powers p * E[j] per §5.3.
 *     Strictly re-evaluates absolute (> -70) and relative (> max(-70, L_A - 10)) gates.
 *     NEVER assumes L(g) === L(0) + g because blocks dynamically enter/leave gates.
 * - Estimated True Peak:
 *     Linear interpolation operator ensures TP(g) = TP0 + g in unquantized Float64.
 * - Constraints:
 *     targetLufs in [-30, -10] LUFS
 *     peakCeilingDbTp in [-6, 0] estimated dBTP
 *     tolerance = 0.25 LU
 *     margin = 0.30 dB
 *     peakEligible(g) <=> TP(g) <= peakCeilingDbTp - margin
 * - Feasible set:
 *     S = { g in G | L(g) is finite and peakEligible(g) }
 * - Selection & Tie-break:
 *     Deterministic lexicographical ordering by tuple (abs(L(g) - T), abs(g), g).
 *     gBest: chosen from S.
 *     gTarget: chosen from all finite L(g) in G without peak constraint.
 * - Status determination:
 *     If input is NO_PROGRAM -> status = 'NO_PROGRAM', gBestTick = null, gTargetTick = null.
 *     If S is empty -> status = 'NO_SAFE_GAIN_IN_GRID', gBestTick = null.
 *     If abs(L(gBest) - T) <= tolerance -> status = 'GAIN_FEASIBLE'.
 *     Else -> status = 'GAIN_BLOCKED_PEAK_OR_RANGE', reports minimumGridDeviationLu = abs(L(gBest) - T).
 * - Display peak boundary:
 *     peakBoundary = C - margin - TP0, aligned to grid with floor(10 * boundary) / 10.
 */

import { applyKWeight } from './biquad.js';
import {
  computeBlockPowers,
  computeGatedLufsFromPowers,
  gateBlockPowers,
} from './gating.js';
import { estimateTruePeak } from './truepeak.js';
import type {
  Constraints,
  GainPoint,
  Measurement,
  PCM,
  SolverResult,
  Status,
} from './types.js';
import {
  TICK_MAX,
  TICK_MIN,
  TICK_STEP_DB,
  tickToDb,
  validateConstraints,
  validateGainTick,
  validatePcm,
} from './validate.js';

export const GRID_TICK_MIN = TICK_MIN; // -240
export const GRID_TICK_MAX = TICK_MAX; // +240
export const GRID_POINTS_COUNT = 481;
export const GAIN_STEP_DB = TICK_STEP_DB; // 0.1 dB

/**
 * Candidate representation for tie-break sorting.
 */
export interface SolverCandidate {
  tick: number;
  dev: number;
  absTick: number;
}

/**
 * Strict 3-tuple lexicographical comparator: (abs(L(g) - T), abs(g), g).
 *
 * Primary: minimum deviation abs(L(g) - T).
 * Secondary: minimum absolute gain abs(g) (minimum boost/cut).
 * Tertiary: signed gain g (prefer lower gain if equidistant).
 *
 * @param a Candidate A
 * @param b Candidate B
 * @returns Negative if A < B (A is preferred), positive if B < A, 0 if identical
 */
export function compareCandidates(
  a: SolverCandidate,
  b: SolverCandidate,
): number {
  const devDiff = a.dev - b.dev;
  if (Math.abs(devDiff) > 1e-12) {
    return devDiff;
  }
  const absDiff = a.absTick - b.absTick;
  if (absDiff !== 0) {
    return absDiff;
  }
  return a.tick - b.tick;
}

/**
 * Measures integrated loudness, sample peak, and 4x windowed sinc estimated true peak
 * for a PCM audio signal in a single unified pass.
 *
 * @param pcm Decoded 48kHz audio PCM
 * @returns Measurement containing loudness, gates, and peak metrics
 */
export function measure(pcm: PCM): Measurement {
  validatePcm(pcm);

  // 1. Estimated True Peak & Sample Peak
  const tp = estimateTruePeak(pcm);

  // 2. K-Weighting filtering
  const filtered = applyKWeight(pcm);

  // 3. 400ms block power calculation
  const blockPowers = computeBlockPowers(filtered);

  // 4. Two-stage gating at 0 dB gain
  const gating = gateBlockPowers(blockPowers, 0);

  return {
    integratedLufs: gating.integratedLufs,
    samplePeakDbFs: tp.samplePeakDbFs,
    estimatedTruePeakDbTp: tp.estimatedTruePeakDbTp,
    samplePeakFrame: tp.samplePeakFrame,
    estimatedPeakPosition: tp.estimatedPeakPosition,
    blockPowers: gating.blockPowers,
    absoluteGate: gating.absoluteGate,
    relativeGate: gating.relativeGate,
  };
}

/**
 * Evaluates a single gain grid point by re-running two-stage gating on scaled block powers
 * and translating estimated true peak linearly.
 *
 * Does NOT modify the input measurement object.
 *
 * @param measurement Precomputed audio measurement
 * @param tick Integer gain tick in [-240, 240] (corresponds to tick * 0.1 dB)
 * @param constraints Optional constraints to evaluate peak eligibility and level error
 * @returns GainPoint
 */
export function evaluateGain(
  measurement: Measurement,
  tick: number,
  constraints?: Constraints,
): GainPoint {
  validateGainTick(tick);
  const gainDb = tickToDb(tick);

  // 1. Re-gate block powers at scaled level
  let integratedLufs: number | null = null;
  if (measurement.blockPowers && measurement.blockPowers.length > 0) {
    integratedLufs = computeGatedLufsFromPowers(measurement.blockPowers, gainDb);
  }

  // 2. Linear true peak shift TP(g) = TP0 + g
  let estimatedTpDb: number | null = null;
  if (
    measurement.estimatedTruePeakDbTp !== null &&
    Number.isFinite(measurement.estimatedTruePeakDbTp)
  ) {
    estimatedTpDb = measurement.estimatedTruePeakDbTp + gainDb;
  }

  // 3. Peak eligibility and level error under constraints
  let peakEligible = true;
  let levelErrorLu: number | null = null;

  if (constraints) {
    const peakCeilingEffective =
      constraints.peakCeilingDbTp - constraints.marginDb;
    peakEligible =
      estimatedTpDb !== null ? estimatedTpDb <= peakCeilingEffective + 1e-9 : true;

    if (integratedLufs !== null && Number.isFinite(integratedLufs)) {
      levelErrorLu = integratedLufs - constraints.targetLufs;
    }
  }

  return {
    tick,
    integratedLufs,
    estimatedTpDb,
    peakEligible,
    levelErrorLu,
  };
}

/**
 * Solves the constant-gain optimization problem across all 481 grid points in [-24.0, +24.0] dB.
 *
 * Strictly executes §5.5:
 * - Re-runs two-stage gating on every grid point.
 * - Evaluates TP(g) = TP0 + g.
 * - Applies 0.30 dB margin to peak ceiling: peakEligible(g) <=> TP(g) <= C - margin.
 * - Performs 3-tuple lexicographical tie-breaking (abs(L-T), abs(g), g).
 * - Identifies unconstrained gTarget and constrained gBest.
 * - Calculates grid-aligned peakBoundary = floor(10 * (C - margin - TP0)) / 10.
 * - Correctly identifies NO_PROGRAM and withholds recommended gain.
 *
 * @param measurement Precomputed audio measurement
 * @param constraints Optimization constraints (targetLufs, peakCeilingDbTp, toleranceLu, marginDb)
 * @returns SolverResult
 */
export function solve(
  measurement: Measurement,
  constraints: Constraints,
): SolverResult {
  const validatedConstraints = validateConstraints(constraints);
  const { targetLufs, peakCeilingDbTp, toleranceLu, marginDb } =
    validatedConstraints;
  const peakCeilingEffective = peakCeilingDbTp - marginDb;

  const TP0 = measurement.estimatedTruePeakDbTp;

  // Display peak boundary: C - margin - TP0, aligned to 0.1dB grid
  let peakBoundaryDb: number | null = null;
  if (TP0 !== null && Number.isFinite(TP0)) {
    const rawBoundary = peakCeilingEffective - TP0;
    // Add 1e-9 before Math.floor to avoid precision underflow (e.g., -0.4999999999999999 -> -0.5)
    peakBoundaryDb = Math.floor(10 * rawBoundary + 1e-9) / 10;
  }

  // Handle NO_PROGRAM input: no active audio content above gating threshold
  if (
    measurement.integratedLufs === null ||
    !measurement.blockPowers ||
    measurement.blockPowers.length === 0
  ) {
    const points: GainPoint[] = [];
    for (let tick = GRID_TICK_MIN; tick <= GRID_TICK_MAX; tick++) {
      points.push(evaluateGain(measurement, tick, validatedConstraints));
    }

    return {
      status: 'NO_PROGRAM',
      gBestTick: null,
      gTargetTick: null,
      minimumGridDeviationLu: null,
      peakBoundaryDb,
      points,
      witness: {
        reasons: [
          'Signal has no active audio content above gating threshold (-70 LUFS) at 0 dB gain (NO_PROGRAM). Recommended gain is withheld.',
        ],
      },
    };
  }

  // Evaluate all 481 grid points
  const points: GainPoint[] = [];
  const allCandidates: SolverCandidate[] = [];
  const safeCandidates: SolverCandidate[] = [];

  for (let tick = GRID_TICK_MIN; tick <= GRID_TICK_MAX; tick++) {
    const gainDb = tickToDb(tick);
    const lufs = computeGatedLufsFromPowers(measurement.blockPowers, gainDb);
    const tpDb = TP0 !== null && Number.isFinite(TP0) ? TP0 + gainDb : null;
    const peakEligible = tpDb !== null ? tpDb <= peakCeilingEffective + 1e-9 : true;
    const levelErrorLu =
      lufs !== null && Number.isFinite(lufs) ? lufs - targetLufs : null;

    points.push({
      tick,
      integratedLufs: lufs,
      estimatedTpDb: tpDb,
      peakEligible,
      levelErrorLu,
    });

    if (lufs !== null && Number.isFinite(lufs)) {
      const dev = Math.abs(lufs - targetLufs);
      const cand: SolverCandidate = {
        tick,
        dev,
        absTick: Math.abs(tick),
      };

      allCandidates.push(cand);
      if (peakEligible) {
        safeCandidates.push(cand);
      }
    }
  }

  // Select gTarget: best unconstrained candidate across entire grid
  let gTargetTick: number | null = null;
  if (allCandidates.length > 0) {
    allCandidates.sort(compareCandidates);
    gTargetTick = allCandidates[0].tick;
  }

  // Evaluate feasible set S (safeCandidates)
  if (safeCandidates.length === 0) {
    const reasons: string[] = [
      `No candidate gain in [-24.0, +24.0] dB meets the estimated true-peak ceiling (<= ${peakCeilingEffective.toFixed(2)} dBTP).`,
    ];
    if (gTargetTick !== null) {
      reasons.push(
        `Target loudness ${targetLufs} LUFS would require ${(gTargetTick * 0.1).toFixed(1)} dB gain, which exceeds true-peak limits.`,
      );
    }

    return {
      status: 'NO_SAFE_GAIN_IN_GRID',
      gBestTick: null,
      gTargetTick,
      minimumGridDeviationLu: null,
      peakBoundaryDb,
      points,
      witness: { reasons },
    };
  }

  safeCandidates.sort(compareCandidates);
  const best = safeCandidates[0];
  const gBestTick = best.tick;
  const minimumGridDeviationLu = best.dev;

  let status: Status;
  const reasons: string[] = [];

  const gBestDb = (gBestTick * 0.1).toFixed(1);
  const gBestTp = TP0 !== null ? (TP0 + gBestTick * 0.1).toFixed(2) : '-Infinity';

  if (best.dev <= toleranceLu) {
    status = 'GAIN_FEASIBLE';
    reasons.push(
      `Target loudness ${targetLufs} LUFS is feasible at ${gBestDb} dB gain (deviation ${best.dev.toFixed(3)} LU <= tolerance ${toleranceLu} LU; estimated TP ${gBestTp} dBTP <= ceiling ${peakCeilingEffective.toFixed(2)} dBTP).`,
    );
  } else {
    status = 'GAIN_BLOCKED_PEAK_OR_RANGE';
    const gTargetDb =
      gTargetTick !== null ? (gTargetTick * 0.1).toFixed(1) : 'none';
    reasons.push(
      `Target loudness ${targetLufs} LUFS cannot be satisfied within safe peak margin (ceiling <= ${peakCeilingEffective.toFixed(2)} dBTP). Unconstrained target candidate is ${gTargetDb} dB. Best safe candidate is ${gBestDb} dB with minimum grid deviation ${best.dev.toFixed(3)} LU > tolerance ${toleranceLu} LU.`,
    );
  }

  return {
    status,
    gBestTick,
    gTargetTick,
    minimumGridDeviationLu,
    peakBoundaryDb,
    points,
    witness: { reasons },
  };
}
