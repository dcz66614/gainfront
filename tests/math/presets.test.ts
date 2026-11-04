/**
 * Tests for Deterministic Presets Generator & Fixtures (P010-T003)
 *
 * Covers:
 * - Mathematical generation of GF-A through GF-F per PROJECT_BOOK.md §6
 * - GF-A isolated peak overwrite (NOT addition) at n = 192000
 * - Sample spot checks (first, peak, transition, last)
 * - Determinism and Float64 bitwise reproducibility
 * - Rejection of invalid preset IDs
 * - Contract verification of fixture JSON files (GF-A.json - GF-F.json)
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makePreset, PRESET_DEFINITIONS, PRESET_TOTAL_FRAMES } from '../../src/core/presets.js';
import type { PresetId, Session } from '../../src/core/types.js';
import { PRESET_IDS } from '../../src/core/types.js';

describe('P010-T003 Presets Generation (GF-A through GF-F)', () => {
  it('generates all 6 presets with exact frame count 384,000 (8 seconds at 48000 Hz)', () => {
    for (const id of PRESET_IDS) {
      const pcm = makePreset(id);
      expect(pcm.sampleRate).toBe(48000);
      expect(pcm.frames).toBe(PRESET_TOTAL_FRAMES);
      expect(pcm.frames).toBe(8 * 48000);

      const expectedChannels = id === 'GF-C' ? 2 : 1;
      expect(pcm.channels).toBe(expectedChannels);
      expect(pcm.planar.length).toBe(expectedChannels);
      for (const ch of pcm.planar) {
        expect(ch).toBeInstanceOf(Float64Array);
        expect(ch.length).toBe(384000);
      }
    }
  });

  describe('GF-A: 峰值陷阱 (Peak Trap)', () => {
    it('generates 1000 Hz sine wave and strictly OVERWRITES sample at n=192000 to 0.80', () => {
      const pcm = makePreset('GF-A');
      const ch0 = pcm.planar[0];

      // n = 0: sin(0) = 0
      expect(ch0[0]).toBe(0);

      // n = 12: (1000 * 12 / 48000) = 1/4 cycle -> sin(pi/2) = 1.0 -> 0.10
      expect(ch0[12]).toBeCloseTo(0.1, 10);

      // n = 192000 (4 seconds): Must be OVERWRITTEN to exactly 0.80, NOT added
      expect(ch0[192000]).toBe(0.8);

      // Surrounding samples must follow standard 1000 Hz sine wave
      const omega = (2 * Math.PI * 1000) / 48000;
      expect(ch0[191999]).toBeCloseTo(0.1 * Math.sin(omega * 191999), 14);
      expect(ch0[192001]).toBeCloseTo(0.1 * Math.sin(omega * 192001), 14);

      // Check last sample
      expect(ch0[383999]).toBeCloseTo(0.1 * Math.sin(omega * 383999), 14);
    });
  });

  describe('GF-B: 安全增益 (Safe Gain)', () => {
    it('generates continuous 1000 Hz sine wave with amplitude 0.10 throughout', () => {
      const pcm = makePreset('GF-B');
      const ch0 = pcm.planar[0];
      const omega = (2 * Math.PI * 1000) / 48000;

      expect(ch0[0]).toBe(0);
      expect(ch0[12]).toBeCloseTo(0.1, 10);

      // At n = 192000, GF-B is standard sine (no peak overwrite like GF-A)
      expect(ch0[192000]).toBeCloseTo(0.1 * Math.sin(omega * 192000), 14);
      expect(Math.abs(ch0[192000])).toBeLessThan(1e-12); // sin(2*pi*4000) is near 0

      // All samples strictly within [-0.10, 0.10]
      let maxAbs = 0;
      for (let n = 0; n < pcm.frames; n += 96) {
        if (Math.abs(ch0[n]) > maxAbs) maxAbs = Math.abs(ch0[n]);
      }
      expect(maxAbs).toBeLessThanOrEqual(0.1000000000001);
    });
  });

  describe('GF-C: 双声道能量 (Stereo Power)', () => {
    it('generates two identical, independent L/R tracks matching GF-B', () => {
      const pcmC = makePreset('GF-C');
      const pcmB = makePreset('GF-B');

      expect(pcmC.channels).toBe(2);
      const [left, right] = pcmC.planar;

      // Independent Float64Array instances
      expect(left).not.toBe(right);
      expect(left.buffer).not.toBe(right.buffer);

      // Identical values across both channels and matching GF-B
      const bCh = pcmB.planar[0];
      let identical = true;
      for (let n = 0; n < pcmC.frames; n++) {
        if (left[n] !== right[n] || left[n] !== bCh[n]) {
          identical = false;
          break;
        }
      }
      expect(identical).toBe(true);
    });
  });

  describe('GF-D: 采样间峰值 (Inter-sample Peak)', () => {
    it('generates 12000 Hz sine wave with pi/4 phase and 0.90 amplitude', () => {
      const pcm = makePreset('GF-D');
      const ch0 = pcm.planar[0];

      // n = 0: 0.90 * sin(pi/4) = 0.90 * sqrt(2)/2 ≈ 0.636396103
      const expected0 = 0.9 * Math.sin(Math.PI / 4);
      expect(ch0[0]).toBeCloseTo(expected0, 14);

      // Periodicity check: 48000 / 12000 = 4 samples per period
      for (let n = 0; n < 40; n++) {
        expect(ch0[n + 4]).toBeCloseTo(ch0[n], 14);
      }

      // Check sample peak does not reach 0.90 at integer sampling points
      let maxSample = 0;
      for (let n = 0; n < 100; n++) {
        if (Math.abs(ch0[n]) > maxSample) maxSample = Math.abs(ch0[n]);
      }
      expect(maxSample).toBeCloseTo(expected0, 10);
      expect(maxSample).toBeLessThan(0.9);
    });
  });

  describe('GF-E: 绝对门限下 (Below Absolute Gate)', () => {
    it('generates ultra-low amplitude 0.00001 sine wave', () => {
      const pcm = makePreset('GF-E');
      const ch0 = pcm.planar[0];

      expect(ch0[0]).toBe(0);
      expect(ch0[12]).toBeCloseTo(0.00001, 14);

      let maxAbs = 0;
      for (let n = 0; n < pcm.frames; n += 1000) {
        if (Math.abs(ch0[n]) > maxAbs) maxAbs = Math.abs(ch0[n]);
      }
      expect(maxAbs).toBeLessThanOrEqual(0.0000100000001);
    });
  });

  describe('GF-F: 静音前缀 (Silence Prefix)', () => {
    it('generates 2 seconds (96,000 frames) of exact zero followed by GF-B sine', () => {
      const pcmF = makePreset('GF-F');
      const pcmB = makePreset('GF-B');
      const ch0 = pcmF.planar[0];
      const bCh = pcmB.planar[0];

      // Samples n < 96000 must be exact 0.0
      expect(ch0[0]).toBe(0);
      expect(ch0[48000]).toBe(0);
      expect(ch0[95999]).toBe(0);

      // Samples n >= 96000 must match GF-B
      expect(ch0[96000]).toBe(bCh[96000]);
      expect(ch0[96012]).toBeCloseTo(0.1, 10);
      expect(ch0[96012]).toBe(bCh[96012]);
      expect(ch0[383999]).toBe(bCh[383999]);
    });
  });

  it('guarantees deterministic, reproducible generation with exact float equality', () => {
    const run1 = makePreset('GF-A');
    const run2 = makePreset('GF-A');

    expect(run1.planar[0].length).toBe(run2.planar[0].length);
    let identical = true;
    for (let n = 0; n < run1.frames; n++) {
      if (run1.planar[0][n] !== run2.planar[0][n]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(true);
  });

  it('rejects invalid preset ID with INVALID_PRESET_ID', () => {
    expect(() => makePreset('INVALID' as unknown as PresetId)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PRESET_ID' }),
    );
  });
});

describe('P010-T003 Preset Fixtures Contract Verification', () => {
  const fixtureFiles: Record<PresetId, string> = {
    'GF-A': 'GF-A.json',
    'GF-B': 'GF-B.json',
    'GF-C': 'GF-C.json',
    'GF-D': 'GF-D.json',
    'GF-E': 'GF-E.json',
    'GF-F': 'GF-F.json',
  };

  const expectedConstraints: Record<PresetId, { targetLufs: number; peakCeilingDbTp: number }> = {
    'GF-A': { targetLufs: -16, peakCeilingDbTp: -1 },
    'GF-B': { targetLufs: -20, peakCeilingDbTp: -1 },
    'GF-C': { targetLufs: -20, peakCeilingDbTp: -1 },
    'GF-D': { targetLufs: -12, peakCeilingDbTp: -1 },
    'GF-E': { targetLufs: -20, peakCeilingDbTp: -1 },
    'GF-F': { targetLufs: -20, peakCeilingDbTp: -1 },
  };

  for (const presetId of PRESET_IDS) {
    it(`validates fixture ${fixtureFiles[presetId]} structure strictly per contract`, () => {
      const filePath = resolve(__dirname, '../fixtures', fixtureFiles[presetId]);
      const content = readFileSync(filePath, 'utf-8');
      const session = JSON.parse(content) as Session;

      // Validate session schema fields
      expect(session.schema).toBe('gainfront.session/1');
      expect(session.projectId).toBe('P010');
      expect(session.specVersion).toBe('1.0.0');
      expect(session.synthetic).toBe(true);

      // Source ref
      expect(session.source.kind).toBe('preset');
      if (session.source.kind === 'preset') {
        expect(session.source.presetId).toBe(presetId);
      }

      // Constraints
      const expected = expectedConstraints[presetId];
      expect(session.constraints.targetLufs).toBe(expected.targetLufs);
      expect(session.constraints.peakCeilingDbTp).toBe(expected.peakCeilingDbTp);
      expect(session.constraints.toleranceLu).toBe(0.25);
      expect(session.constraints.marginDb).toBe(0.3);

      // View
      expect(session.view.selectedGainTick).toBe(0);
      expect(session.view.showBlockGates).toBe(true);

      // Contract rule: Fixtures only store preset definitions, NO measurement conclusions
      expect(session.audit).toBeUndefined();
      expect((session as unknown as Record<string, unknown>).measurement).toBeUndefined();
      expect((session as unknown as Record<string, unknown>).solver).toBeUndefined();
    });
  }

  it('provides complete PRESET_DEFINITIONS matching project specification', () => {
    for (const presetId of PRESET_IDS) {
      const def = PRESET_DEFINITIONS[presetId];
      expect(def.id).toBe(presetId);
      expect(def.channels).toBe(presetId === 'GF-C' ? 2 : 1);
      expect(def.targetLufs).toBe(expectedConstraints[presetId].targetLufs);
      expect(def.peakCeilingDbTp).toBe(expectedConstraints[presetId].peakCeilingDbTp);
      expect(typeof def.name).toBe('string');
      expect(typeof def.description).toBe('string');
    }
  });
});
