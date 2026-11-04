/**
 * GainFront Core Type Definitions
 *
 * Types frozen per PROJECT_BOOK.md §8 and implementation plan §4.1.
 * Business code MUST import types only from core/types.ts.
 */

// --- Status Codes ---
export type Status =
  | 'GAIN_FEASIBLE'
  | 'GAIN_BLOCKED_PEAK_OR_RANGE'
  | 'NO_PROGRAM'
  | 'NO_SAFE_GAIN_IN_GRID'
  | 'UNSUPPORTED_WAV'
  | 'OUT_OF_SCOPE';

export const STATUS_CODES: readonly Status[] = [
  'GAIN_FEASIBLE',
  'GAIN_BLOCKED_PEAK_OR_RANGE',
  'NO_PROGRAM',
  'NO_SAFE_GAIN_IN_GRID',
  'UNSUPPORTED_WAV',
  'OUT_OF_SCOPE',
] as const;

// --- Preset Identifiers ---
export type PresetId = 'GF-A' | 'GF-B' | 'GF-C' | 'GF-D' | 'GF-E' | 'GF-F';

export const PRESET_IDS: readonly PresetId[] = [
  'GF-A',
  'GF-B',
  'GF-C',
  'GF-D',
  'GF-E',
  'GF-F',
] as const;

// --- Audio Source Reference ---
export type SourceRef =
  | { kind: 'preset'; presetId: PresetId }
  | { kind: 'externalWav'; sha256Hex: string; fileName?: string; requiresReselect: true; byteLength?: number };

// --- Optimization Constraints ---
export type Constraints = {
  targetLufs: number;
  peakCeilingDbTp: number;
  toleranceLu: 0.25;
  marginDb: 0.3;
};

// --- Peak Position Sub-sample Coordinate ---
export type PeakPosition = {
  frame: number;
  quarter: 0 | 1 | 2 | 3;
  channel: 0 | 1;
};

// --- Loudness and Peak Measurement ---
export type Measurement = {
  integratedLufs: number | null;
  samplePeakDbFs: number | null;
  estimatedTruePeakDbTp: number | null;
  samplePeakFrame: number | null;
  estimatedPeakPosition: PeakPosition | null;
  blockPowers: number[];
  absoluteGate: boolean[];
  relativeGate: boolean[];
};

// --- Single Grid Point Evaluation (0.1 dB step) ---
export type GainPoint = {
  tick: number;
  integratedLufs: number | null;
  estimatedTpDb: number | null;
  peakEligible: boolean;
  levelErrorLu: number | null;
};

// --- Solver Result for 481-Point Search ---
export type SolverResult = {
  status: Status;
  gBestTick: number | null;
  gTargetTick: number | null;
  minimumGridDeviationLu: number | null;
  peakBoundaryDb: number | null;
  points: GainPoint[];
  witness: { reasons: string[] };
};

// --- PCM In-Memory Representation ---
export type PCM = {
  sampleRate: 48000;
  channels: 1 | 2;
  frames: number;
  planar: Float64Array[];
};

// --- Analysis Report Structure (Worker / UI payload) ---
export interface WaveformSummary {
  channels: number;
  peaks: number[];
}

export interface GateSummary {
  blockCount: number;
  absoluteGateCount: number;
  relativeGateCount: number;
}

export interface ProvenanceInfo {
  specVersion: string;
  sampleRate: number;
  frames: number;
  durationSeconds: number;
}

export interface AnalysisReport {
  synthetic: boolean;
  source: SourceRef;
  constraints: Constraints;
  measurement: Measurement;
  solver: SolverResult;
  waveformSummary?: WaveformSummary;
  gateSummary?: GateSummary;
  provenance?: ProvenanceInfo;
}

// --- Session JSON Export / Import Contract (gainfront.session/1) ---
export interface SessionView {
  selectedGainTick: number;
  showBlockGates: boolean;
}

export interface Session {
  schema: 'gainfront.session/1';
  projectId: 'P010';
  specVersion: '1.0.0';
  synthetic: boolean;
  source: SourceRef;
  constraints: Constraints;
  view: SessionView;
  audit?: {
    measurement?: Partial<Measurement>;
    solver?: Partial<SolverResult>;
  };
}
