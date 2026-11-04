/**
 * Unified Source Audio Analysis Engine
 *
 * Implements analyzeSource per PROJECT_BOOK.md §8.1, §8.2 and P010-T007 task card.
 * Orchestrates PCM acquisition (preset or decoded WAV), loudness/true-peak measurement,
 * 481-grid constraint solving, and summary aggregation into a single authoritative AnalysisReport.
 */

import { GainFrontError } from './errors.js';
import { measure, solve } from './gain.js';
import { makePreset } from './presets.js';
import type {
  AnalysisReport,
  Constraints,
  GateSummary,
  Measurement,
  PCM,
  PresetId,
  ProvenanceInfo,
  SolverResult,
  SourceRef,
  WaveformSummary,
} from './types.js';
import {
  validateConstraints,
  validatePcm,
  validatePresetId,
  validateWavByteLength,
} from './validate.js';
import { decodePcm16Wav } from './wav.js';

/**
 * Input request specification for analyzeSource.
 * Supports preset generation, raw WAV byte decoding, or direct in-memory PCM.
 */
export interface AnalyzeSourceRequest {
  constraints: Constraints;
  type?: string;
  requestId?: number;
  presetId?: PresetId;
  wavBytes?: ArrayBuffer;
  pcm?: PCM;
  source?: SourceRef;
  fileName?: string;
  sha256Hex?: string;
}

/**
 * Computes peak amplitude per audio channel.
 */
function computeChannelPeaks(pcm: PCM): number[] {
  const peaks: number[] = [];
  for (let c = 0; c < pcm.channels; c++) {
    const channel = pcm.planar[c];
    let maxVal = 0.0;
    for (let i = 0; i < channel.length; i++) {
      const absVal = Math.abs(channel[i]);
      if (absVal > maxVal) {
        maxVal = absVal;
      }
    }
    peaks.push(maxVal);
  }
  return peaks;
}

/**
 * Analyzes an audio source by measuring loudness and true peak, solving the 481-point
 * gain optimization grid against constraints, and compiling a complete AnalysisReport.
 *
 * @param request AnalyzeSourceRequest containing constraints and audio source definition
 * @returns Comprehensive AnalysisReport with measurement, solver result, and provenance
 */
export function analyzeSource(request: AnalyzeSourceRequest): AnalysisReport {
  if (typeof request !== 'object' || request === null) {
    throw new GainFrontError(
      'INVALID_CONSTRAINTS',
      'analyzeSource requires a valid request object',
    );
  }

  const constraints = validateConstraints(request.constraints);

  let pcm: PCM;
  let synthetic: boolean;
  let source: SourceRef;

  if (request.presetId !== undefined) {
    const presetId = validatePresetId(request.presetId);
    pcm = makePreset(presetId);
    synthetic = true;
    source = { kind: 'preset', presetId };
  } else if (request.wavBytes !== undefined) {
    if (!(request.wavBytes instanceof ArrayBuffer)) {
      throw new GainFrontError(
        'UNSUPPORTED_WAV',
        'wavBytes must be an instance of ArrayBuffer',
      );
    }
    validateWavByteLength(request.wavBytes.byteLength);
    pcm = decodePcm16Wav(request.wavBytes);
    synthetic = false;

    if (request.source && request.source.kind === 'externalWav') {
      // FIX-R2-01: persist the real file byteLength, not the 44+data guess.
      // RIFF extra chunks (LIST/JUNK/bext, extended fmt, odd-size padding)
      // make the real length larger than 44 + frames*channels*2.
      source = {
        ...request.source,
        byteLength: request.wavBytes.byteLength,
      };
    } else {
      source = {
        kind: 'externalWav',
        sha256Hex: (request.sha256Hex || '').toLowerCase(),
        fileName: request.fileName,
        requiresReselect: true,
        byteLength: request.wavBytes.byteLength,
      };
    }
  } else if (request.pcm !== undefined) {
    pcm = validatePcm(request.pcm);
    if (request.source) {
      source = request.source;
      synthetic = source.kind === 'preset';
    } else {
      synthetic = false;
      source = {
        kind: 'externalWav',
        sha256Hex: (request.sha256Hex || '').toLowerCase(),
        fileName: request.fileName,
        requiresReselect: true,
      };
    }
  } else {
    throw new GainFrontError(
      'INVALID_SOURCE_REF',
      'analyzeSource requires presetId, wavBytes, or pcm in request',
    );
  }

  // Unified measurement: loudness, gates, sample peak, and 4x sinc estimated true peak
  const measurement: Measurement = measure(pcm);

  // 481-grid optimization solver
  const solver: SolverResult = solve(measurement, constraints);

  // Summaries
  const waveformSummary: WaveformSummary = {
    channels: pcm.channels,
    peaks: computeChannelPeaks(pcm),
  };

  const gateSummary: GateSummary = {
    blockCount: measurement.blockPowers.length,
    absoluteGateCount: measurement.absoluteGate.filter(Boolean).length,
    relativeGateCount: measurement.relativeGate.filter(Boolean).length,
  };

  const provenance: ProvenanceInfo = {
    specVersion: '1.0.0',
    sampleRate: pcm.sampleRate,
    frames: pcm.frames,
    durationSeconds: pcm.frames / pcm.sampleRate,
  };

  return {
    synthetic,
    source,
    constraints,
    measurement,
    solver,
    waveformSummary,
    gateSummary,
    provenance,
  };
}

// Re-export core solver methods for convenience
export { evaluateGain, measure, solve } from './gain.js';
