/**
 * GainFront Core Module Entrypoint
 *
 * Freezes types, errors, and validation logic.
 * Core DSP algorithms (wav, biquad, gating, truepeak, gain, analyze) are
 * isolated into their respective task files in accordance with project boundaries.
 */

export * from './types.js';
export * from './errors.js';
export * from './validate.js';
