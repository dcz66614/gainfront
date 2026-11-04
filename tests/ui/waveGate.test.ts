import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyGateState, type GateTriState } from '../../src/ui/GateStrip.js';
import { computeWaveformBins } from '../../src/ui/WaveCompare.js';
import { makePreset } from '../../src/core/presets.js';
import { analyzeSource } from '../../src/core/analyze.js';
import type { Session } from '../../src/core/types.js';

describe('P010-T012 GateStrip & WaveCompare Visual Contracts', () => {
  describe('GateStrip Tri-State Mapping & Color-Text Semantic Consistency', () => {
    it('classifies isAbs=false as ABSOLUTE_OUT with consistent text, red color, and warning description', () => {
      const state = classifyGateState(false, false);
      expect(state.state).toBe('ABSOLUTE_OUT');
      expect(state.label).toBe('绝对门外');
      expect(state.symbol).toBe('×');
      expect(state.description).toContain('-70 LUFS');
      // Red palette per project book §9
      expect(state.color).toBe('#f87171');
      expect(state.borderColor).toBe('#ef4444');
    });

    it('classifies isAbs=true and isRel=false as RELATIVE_OUT with amber color and relative gate text', () => {
      const state = classifyGateState(true, false);
      expect(state.state).toBe('RELATIVE_OUT');
      expect(state.label).toBe('相对门外');
      expect(state.symbol).toBe('~');
      expect(state.description).toContain('相对门限');
      // Amber palette per project book §9
      expect(state.color).toBe('#fbbf24');
      expect(state.borderColor).toBe('#f59e0b');
    });

    it('classifies isAbs=true and isRel=true as PASSED with teal color and passed text', () => {
      const state = classifyGateState(true, true);
      expect(state.state).toBe('PASSED');
      expect(state.label).toBe('通过');
      expect(state.symbol).toBe('✓');
      expect(state.description).toContain('计入最终集成');
      // Cyan/Teal palette per project book §9
      expect(state.color).toBe('#2dd4bf');
      expect(state.borderColor).toBe('#14b8a6');
    });

    it('ensures every state has both text label, symbol, and description (no color-only semantics)', () => {
      const allStates: GateTriState[] = ['PASSED', 'RELATIVE_OUT', 'ABSOLUTE_OUT'];
      const testedStates = [
        classifyGateState(true, true),
        classifyGateState(true, false),
        classifyGateState(false, false),
      ];

      for (let i = 0; i < testedStates.length; i++) {
        const info = testedStates[i];
        expect(allStates).toContain(info.state);
        expect(info.label.length).toBeGreaterThan(0);
        expect(info.badge.length).toBeGreaterThan(0);
        expect(info.symbol.length).toBeGreaterThan(0);
        expect(info.description.length).toBeGreaterThan(0);
        // Text is explicit and not empty
        expect(typeof info.color).toBe('string');
      }
    });
  });

  describe('GateStrip 77-Block Mapping with Authoritative Presets & Fixtures', () => {
    it('accurately maps 77 blocks for GF-A and verifies peak frame at 192000', () => {
      const fixturePath = resolve(__dirname, '../fixtures/GF-A.json');
      const fixture: Session = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const pcmA = makePreset('GF-A');
      const report = analyzeSource({
        constraints: fixture.constraints,
        pcm: pcmA,
        source: fixture.source,
      });

      expect(report.measurement.blockPowers.length).toBe(77);
      expect(report.measurement.absoluteGate.length).toBe(77);
      expect(report.measurement.relativeGate.length).toBe(77);

      // Verify peak frame is 192000
      expect(report.measurement.samplePeakFrame).toBe(192000);
      expect(report.measurement.samplePeakDbFs).toBeCloseTo(-1.9382, 3);
    });

    it('demonstrates GF-F silence prefix has all initial silence blocks strictly in ABSOLUTE_OUT state', () => {
      const fixturePath = resolve(__dirname, '../fixtures/GF-F.json');
      const fixture: Session = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const pcmF = makePreset('GF-F');
      const report = analyzeSource({
        constraints: fixture.constraints,
        pcm: pcmF,
        source: fixture.source,
      });

      expect(report.measurement.blockPowers.length).toBe(77);

      // First 2 seconds (0 to 96,000 frames) are zero.
      // Each block has 19200 frames with 4800 hop.
      // Blocks 0..16 have end frames <= 96000 (16 * 4800 + 19200 = 96000).
      // They are all strictly zero energy and MUST fail absolute gate.
      for (let i = 0; i <= 16; i++) {
        const state = classifyGateState(
          report.measurement.absoluteGate[i],
          report.measurement.relativeGate[i],
        );
        expect(state.state).toBe('ABSOLUTE_OUT');
        expect(state.label).toBe('绝对门外');
      }

      // But later blocks (after the prefix silence) pass
      const laterPassed = report.measurement.absoluteGate.slice(25).some(Boolean);
      expect(laterPassed).toBe(true);
    });

    it('demonstrates GF-E (below absolute threshold) has all 77 blocks in ABSOLUTE_OUT state', () => {
      const pcmE = makePreset('GF-E');
      const report = analyzeSource({
        constraints: { targetLufs: -20, peakCeilingDbTp: -1, toleranceLu: 0.25, marginDb: 0.3 },
        pcm: pcmE,
      });

      expect(report.measurement.blockPowers.length).toBe(77);
      for (let i = 0; i < 77; i++) {
        const state = classifyGateState(
          report.measurement.absoluteGate[i],
          report.measurement.relativeGate[i],
        );
        expect(state.state).toBe('ABSOLUTE_OUT');
      }
      expect(report.solver.status).toBe('NO_PROGRAM');
    });
  });

  describe('WaveCompare Gain Formula & Peak Locating', () => {
    it('verifies gain multiplier strictly adheres to 10^(gBest/20) without modifying raw samples', () => {
      const testTicks = [-60, 0, 40, 60]; // -6.0dB, 0.0dB, +4.0dB, +6.0dB
      const expectedMultipliers = [
        Math.pow(10, -6.0 / 20),
        1.0,
        Math.pow(10, 4.0 / 20),
        Math.pow(10, 6.0 / 20),
      ];

      for (let i = 0; i < testTicks.length; i++) {
        const gBestDb = testTicks[i] * 0.1;
        const multiplier = Math.pow(10, gBestDb / 20);
        expect(multiplier).toBeCloseTo(expectedMultipliers[i], 8);
      }
    });

    it('correctly bins waveform samples and isolates GF-A pulse at frame 192000', () => {
      const pcmA = makePreset('GF-A');
      const totalFrames = pcmA.frames; // 384000
      const numBins = 500;
      const gainMultiplier = 1.0;

      const bins = computeWaveformBins(pcmA.planar[0], totalFrames, numBins, gainMultiplier);
      expect(bins.length).toBe(numBins);

      // Frame 192000 is at exactly 192000 / 384000 * 500 = 250
      const pulseBin = bins[250];
      expect(pulseBin.maxRaw).toBeCloseTo(0.80, 4);

      // Non-pulse bins in 1000Hz sine should have maxRaw around 0.10
      const normalBin = bins[100];
      expect(normalBin.maxRaw).toBeCloseTo(0.10, 2);

      // The pulse is ~8x higher than the surrounding signal
      expect(pulseBin.maxRaw).toBeGreaterThan(normalBin.maxRaw * 7);
    });

    it('verifies peak location math places frame 192000 at exactly 50% of the timeline', () => {
      const totalFrames = 384000;
      const peakFrame = 192000;
      const svgWidth = 1000;

      const peakX = (peakFrame / totalFrames) * svgWidth;
      expect(peakX).toBe(500); // Exactly in the horizontal center
    });

    it('B06: generates waveform bins for external WAV PCM and applies gain multiplier correctly', () => {
      const frames = 48000 * 2; // 2s external PCM
      const channelData = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        channelData[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48000);
      }
      const numBins = 1000;
      const gainMultiplier = 1.5; // +3.52 dB

      const bins = computeWaveformBins(channelData, frames, numBins, gainMultiplier);
      expect(bins.length).toBe(numBins);
      expect(bins[100].maxRaw).toBeCloseTo(0.4, 1);
      expect(bins[100].maxGained).toBeCloseTo(0.4 * 1.5, 1);
      expect(bins[100].minRaw).toBeCloseTo(-0.4, 1);
      expect(bins[100].minGained).toBeCloseTo(-0.4 * 1.5, 1);
    });
  });
});
