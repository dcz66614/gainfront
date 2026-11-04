/**
 * GainFront Deterministic Golden Presets Generator
 *
 * Implements mathematical formulas for GF-A through GF-F per PROJECT_BOOK.md §6.
 * All presets are purely deterministic with synthetic Float64 signals.
 * Embedding empirical or precalculated measurement results is strictly forbidden.
 */

import type { PCM, PresetId } from './types.js';
import { validatePresetId } from './validate.js';

export const PRESET_SAMPLE_RATE = 48000;
export const PRESET_DURATION_SECONDS = 8;
export const PRESET_TOTAL_FRAMES = PRESET_DURATION_SECONDS * PRESET_SAMPLE_RATE; // 384,000 frames

export interface PresetDefinition {
  id: PresetId;
  name: string;
  channels: 1 | 2;
  targetLufs: number;
  peakCeilingDbTp: number;
  description: string;
}

/**
 * Metadata table for presets matching PROJECT_BOOK §6.
 * Note: targetLufs and peakCeilingDbTp are input optimization constraints, not measurement results.
 */
export const PRESET_DEFINITIONS: Record<PresetId, PresetDefinition> = {
  'GF-A': {
    id: 'GF-A',
    name: '峰值陷阱（默认）',
    channels: 1,
    targetLufs: -16,
    peakCeilingDbTp: -1,
    description: '1000Hz正弦波，并在第4秒覆写0.80突发孤立峰值，恒定增益撞上TP约束',
  },
  'GF-B': {
    id: 'GF-B',
    name: '安全增益',
    channels: 1,
    targetLufs: -20,
    peakCeilingDbTp: -1,
    description: '1000Hz正弦波，峰值可达安全增益',
  },
  'GF-C': {
    id: 'GF-C',
    name: '双声道能量',
    channels: 2,
    targetLufs: -20,
    peakCeilingDbTp: -1,
    description: '立体声同信号双轨，相比单声道响度增加约3.01LU，峰值不翻倍',
  },
  'GF-D': {
    id: 'GF-D',
    name: '采样间峰值',
    channels: 1,
    targetLufs: -12,
    peakCeilingDbTp: -1,
    description: '12000Hz正弦波+π/4相位，采样峰与4x插值真峰存在显著差异',
  },
  'GF-E': {
    id: 'GF-E',
    name: '绝对门限下',
    channels: 1,
    targetLufs: -20,
    peakCeilingDbTp: -1,
    description: '近零低幅正弦波，所有块均低于-70 LUFS绝对门限，期望判定NO_PROGRAM',
  },
  'GF-F': {
    id: 'GF-F',
    name: '静音前缀',
    channels: 1,
    targetLufs: -20,
    peakCeilingDbTp: -1,
    description: '前2秒静音(96000帧为0)，后6秒为GF-B正弦波，用于对照门限块进出',
  },
};

/**
 * Generates an in-memory PCM struct for a given preset ID.
 *
 * Formulas:
 * - GF-A: x[n] = 0.10 * sin(2π * 1000 * n / 48000); at n = 192000, x[n] is OVERWRITTEN to 0.80.
 * - GF-B: x[n] = 0.10 * sin(2π * 1000 * n / 48000).
 * - GF-C: Two independent L/R tracks, each identical to GF-B.
 * - GF-D: x[n] = 0.90 * sin(2π * 12000 * n / 48000 + π/4).
 * - GF-E: x[n] = 0.00001 * sin(2π * 1000 * n / 48000).
 * - GF-F: x[n] = 0 for n < 96000, otherwise 0.10 * sin(2π * 1000 * n / 48000).
 */
export function makePreset(id: PresetId): PCM {
  const validId = validatePresetId(id);
  const frames = PRESET_TOTAL_FRAMES;
  const sampleRate = PRESET_SAMPLE_RATE;

  switch (validId) {
    case 'GF-A': {
      const data = new Float64Array(frames);
      const omega = (2 * Math.PI * 1000) / sampleRate;
      for (let n = 0; n < frames; n++) {
        data[n] = 0.1 * Math.sin(omega * n);
      }
      // Overwrite (NOT add) isolated peak at n = 4 * 48000 = 192000
      data[4 * sampleRate] = 0.8;
      return {
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [data],
      };
    }

    case 'GF-B': {
      const data = new Float64Array(frames);
      const omega = (2 * Math.PI * 1000) / sampleRate;
      for (let n = 0; n < frames; n++) {
        data[n] = 0.1 * Math.sin(omega * n);
      }
      return {
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [data],
      };
    }

    case 'GF-C': {
      const left = new Float64Array(frames);
      const right = new Float64Array(frames);
      const omega = (2 * Math.PI * 1000) / sampleRate;
      for (let n = 0; n < frames; n++) {
        const val = 0.1 * Math.sin(omega * n);
        left[n] = val;
        right[n] = val;
      }
      return {
        sampleRate: 48000,
        channels: 2,
        frames,
        planar: [left, right],
      };
    }

    case 'GF-D': {
      const data = new Float64Array(frames);
      const omega = (2 * Math.PI * 12000) / sampleRate;
      const phase = Math.PI / 4;
      for (let n = 0; n < frames; n++) {
        data[n] = 0.9 * Math.sin(omega * n + phase);
      }
      return {
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [data],
      };
    }

    case 'GF-E': {
      const data = new Float64Array(frames);
      const omega = (2 * Math.PI * 1000) / sampleRate;
      for (let n = 0; n < frames; n++) {
        data[n] = 0.00001 * Math.sin(omega * n);
      }
      return {
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [data],
      };
    }

    case 'GF-F': {
      const data = new Float64Array(frames);
      const silenceFrames = 96000;
      const omega = (2 * Math.PI * 1000) / sampleRate;
      // n < 96000 is 0.0 (Float64Array initialized to 0.0)
      for (let n = silenceFrames; n < frames; n++) {
        data[n] = 0.1 * Math.sin(omega * n);
      }
      return {
        sampleRate: 48000,
        channels: 1,
        frames,
        planar: [data],
      };
    }
  }
}
