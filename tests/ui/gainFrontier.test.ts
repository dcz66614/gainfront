import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyGainPointState,
  formatStatusInfo,
  type FrontierTriState,
} from '../../src/ui/GainFrontier.js';
import { makePreset } from '../../src/core/presets.js';
import { measure } from '../../src/core/analyze.js';
import { solve } from '../../src/core/gain.js';
import type { Constraints, GainPoint, Session } from '../../src/core/types.js';

describe('P010-T013 GainFrontier Component Contracts & Numerical Consistency', () => {
  describe('Frontier Tri-State Classification & Color-Text Semantic Consistency', () => {
    it('classifies peakEligible=false as PEAK_LIMITED with red palette and warning text', () => {
      const point: GainPoint = {
        tick: 70,
        integratedLufs: -16.0,
        estimatedTpDb: 1.5,
        peakEligible: false,
        levelErrorLu: 0.0,
      };
      const info = classifyGainPointState(point, 0.25);
      expect(info.state).toBe('PEAK_LIMITED');
      expect(info.label).toBe('峰值受限');
      expect(info.badge).toContain('峰值受限');
      expect(info.symbol).toBe('×');
      expect(info.description).toContain('真实峰值超过安全上限');
      // Red palette per project book §9
      expect(info.color).toBe('#f87171');
      expect(info.borderColor).toBe('#ef4444');
    });

    it('classifies peakEligible=true and within tolerance as FEASIBLE with cyan palette and checkmark', () => {
      const point: GainPoint = {
        tick: 30,
        integratedLufs: -16.1,
        estimatedTpDb: -12.0,
        peakEligible: true,
        levelErrorLu: -0.1,
      };
      const info = classifyGainPointState(point, 0.25);
      expect(info.state).toBe('FEASIBLE');
      expect(info.label).toBe('可行');
      expect(info.badge).toContain('可行');
      expect(info.symbol).toBe('✓');
      expect(info.description).toContain('同时满足');
      // Cyan/Teal palette per project book §9
      expect(info.color).toBe('#2dd4bf');
      expect(info.borderColor).toBe('#14b8a6');
    });

    it('classifies peakEligible=true and boundary tolerance |dev| = 0.25 as FEASIBLE', () => {
      const pointTop: GainPoint = {
        tick: 32,
        integratedLufs: -15.75,
        estimatedTpDb: -12.0,
        peakEligible: true,
        levelErrorLu: 0.25,
      };
      const pointBottom: GainPoint = {
        tick: 28,
        integratedLufs: -16.25,
        estimatedTpDb: -12.0,
        peakEligible: true,
        levelErrorLu: -0.25,
      };
      expect(classifyGainPointState(pointTop, 0.25).state).toBe('FEASIBLE');
      expect(classifyGainPointState(pointBottom, 0.25).state).toBe('FEASIBLE');
    });

    it('classifies peakEligible=true but deviation > tolerance as OUT_OF_RANGE with amber palette', () => {
      const point: GainPoint = {
        tick: 0,
        integratedLufs: -23.0,
        estimatedTpDb: -20.0,
        peakEligible: true,
        levelErrorLu: -7.0,
      };
      const info = classifyGainPointState(point, 0.25);
      expect(info.state).toBe('OUT_OF_RANGE');
      expect(info.label).toBe('范围外');
      expect(info.badge).toContain('范围外');
      expect(info.symbol).toBe('~');
      expect(info.description).toContain('偏差超出');
      // Amber palette per project book §9
      expect(info.color).toBe('#fbbf24');
      expect(info.borderColor).toBe('#f59e0b');
    });

    it('classifies points with null integratedLufs (silent/NO_PROGRAM) as OUT_OF_RANGE if peak eligible', () => {
      const point: GainPoint = {
        tick: 0,
        integratedLufs: null,
        estimatedTpDb: null,
        peakEligible: true,
        levelErrorLu: null,
      };
      const info = classifyGainPointState(point, 0.25);
      expect(info.state).toBe('OUT_OF_RANGE');
      expect(info.label).toBe('范围外');
      expect(info.symbol).toBe('~');
    });

    it('ensures all three states strictly provide explicit text semantics (no color-only reliance)', () => {
      const samplePoints: GainPoint[] = [
        { tick: 0, integratedLufs: -16.0, estimatedTpDb: -5.0, peakEligible: true, levelErrorLu: 0.0 },
        { tick: 0, integratedLufs: -16.0, estimatedTpDb: 0.5, peakEligible: false, levelErrorLu: 0.0 },
        { tick: 0, integratedLufs: -20.0, estimatedTpDb: -5.0, peakEligible: true, levelErrorLu: -4.0 },
      ];
      const validStates: FrontierTriState[] = ['FEASIBLE', 'PEAK_LIMITED', 'OUT_OF_RANGE'];

      for (const pt of samplePoints) {
        const info = classifyGainPointState(pt, 0.25);
        expect(validStates).toContain(info.state);
        expect(info.label.length).toBeGreaterThan(0);
        expect(info.badge.length).toBeGreaterThan(0);
        expect(info.symbol.length).toBeGreaterThan(0);
        expect(info.description.length).toBeGreaterThan(0);
        expect(typeof info.color).toBe('string');
        expect(typeof info.bgColor).toBe('string');
        expect(typeof info.borderColor).toBe('string');
      }
    });
  });

  describe('formatStatusInfo Contract Coverage', () => {
    it('accurately maps all 6 Status codes with appropriate titles, descriptions, and colors', () => {
      const statuses = [
        'GAIN_FEASIBLE',
        'GAIN_BLOCKED_PEAK_OR_RANGE',
        'NO_PROGRAM',
        'NO_SAFE_GAIN_IN_GRID',
        'UNSUPPORTED_WAV',
        'OUT_OF_SCOPE',
      ] as const;

      for (const s of statuses) {
        const info = formatStatusInfo(s);
        expect(info.title).toContain(s);
        expect(info.desc.length).toBeGreaterThan(0);
        expect(typeof info.isFeasible).toBe('boolean');
        expect(info.color.startsWith('#')).toBe(true);
        expect(info.badgeClass.length).toBeGreaterThan(0);
      }

      expect(formatStatusInfo('GAIN_FEASIBLE').isFeasible).toBe(true);
      expect(formatStatusInfo('GAIN_BLOCKED_PEAK_OR_RANGE').isFeasible).toBe(false);
      expect(formatStatusInfo('NO_PROGRAM').isFeasible).toBe(false);
    });
  });

  describe('GF-A & GF-B Authoritative Solver Verification (481 Points & Cursors)', () => {
    it('verifies GF-A (Peak Trap): 481 points, status GAIN_BLOCKED_PEAK_OR_RANGE, 0 feasible points', () => {
      const pcmA = makePreset('GF-A');
      const measA = measure(pcmA);
      const constraints: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const result = solve(measA, constraints);

      // 481 points contract
      expect(result.points.length).toBe(481);
      expect(result.points[0].tick).toBe(-240);
      expect(result.points[480].tick).toBe(240);

      // Status GAIN_BLOCKED_PEAK_OR_RANGE
      expect(result.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
      const statusInfo = formatStatusInfo(result.status);
      expect(statusInfo.isFeasible).toBe(false);
      expect(statusInfo.color).toBe('#f87171');

      // T013 Expected Evidence: In GF-A, no point can simultaneously satisfy peak and target!
      const feasibleCount = result.points.filter(
        (p) => classifyGainPointState(p, constraints.toleranceLu).state === 'FEASIBLE',
      ).length;
      expect(feasibleCount).toBe(0);

      // gTarget (~+7.0 dB) violates peak constraint
      expect(result.gTargetTick).not.toBeNull();
      const targetPoint = result.points.find((p) => p.tick === result.gTargetTick);
      expect(targetPoint?.peakEligible).toBe(false);
      expect(classifyGainPointState(targetPoint!, constraints.toleranceLu).state).toBe('PEAK_LIMITED');

      // gBest (safe gain, capped around +0.6 dB) is outside tolerance
      expect(result.gBestTick).not.toBeNull();
      const bestPoint = result.points.find((p) => p.tick === result.gBestTick);
      expect(bestPoint?.peakEligible).toBe(true);
      expect(classifyGainPointState(bestPoint!, constraints.toleranceLu).state).toBe('OUT_OF_RANGE');

      // Peak boundary is present
      expect(result.peakBoundaryDb).not.toBeNull();
      expect(result.peakBoundaryDb).toBeCloseTo(0.6, 1);
    });

    it('verifies GF-B (Safe Gain): 481 points, status GAIN_FEASIBLE, feasible points exist around gBest', () => {
      const pcmB = makePreset('GF-B');
      const measB = measure(pcmB);
      const constraints: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const result = solve(measB, constraints);

      expect(result.points.length).toBe(481);
      expect(result.status).toBe('GAIN_FEASIBLE');
      const statusInfo = formatStatusInfo(result.status);
      expect(statusInfo.isFeasible).toBe(true);
      expect(statusInfo.color).toBe('#2dd4bf');

      // Feasible points must exist
      const feasiblePoints = result.points.filter(
        (p) => classifyGainPointState(p, constraints.toleranceLu).state === 'FEASIBLE',
      );
      expect(feasiblePoints.length).toBeGreaterThan(0);

      // gBest is feasible
      expect(result.gBestTick).not.toBeNull();
      const bestPoint = result.points.find((p) => p.tick === result.gBestTick);
      expect(bestPoint?.peakEligible).toBe(true);
      expect(classifyGainPointState(bestPoint!, constraints.toleranceLu).state).toBe('FEASIBLE');
      expect(result.minimumGridDeviationLu!).toBeLessThanOrEqual(0.25);

      // In GF-B without peak restriction, gBest equals gTarget
      expect(result.gBestTick).toBe(result.gTargetTick);
    });

    it('verifies GF-E (Below Absolute Gate): status NO_PROGRAM, gBest is null, no gBest cursor', () => {
      const pcmE = makePreset('GF-E');
      const measE = measure(pcmE);
      const constraints: Constraints = {
        targetLufs: -16.0,
        peakCeilingDbTp: -1.0,
        toleranceLu: 0.25,
        marginDb: 0.3,
      };

      const result = solve(measE, constraints);
      expect(result.status).toBe('NO_PROGRAM');
      // Contract: NO_PROGRAM 时不画 gBest 游标、不给推荐增益
      expect(result.gBestTick).toBeNull();
      expect(result.gTargetTick).toBeNull();
    });
  });

  describe('Interactive Candidate Gain Inspection Contract (Points Access without Recalculation)', () => {
    it('retrieves candidate metrics directly from points array without mutating solver results', () => {
      const fixturePath = resolve(__dirname, '../fixtures/GF-A.json');
      const fixture: Session = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const pcmA = makePreset('GF-A');
      const measA = measure(pcmA);
      const result = solve(measA, fixture.constraints);

      // Test inspecting arbitrary candidate ticks
      const candidateTicks = [-240, -120, 0, 6, 70, 240];

      for (const tick of candidateTicks) {
        const point = result.points.find((p) => p.tick === tick);
        expect(point).toBeDefined();
        expect(point!.tick).toBe(tick);

        // Values are precomputed numbers or null
        if (point!.integratedLufs !== null) {
          expect(typeof point!.integratedLufs).toBe('number');
        }
        if (point!.estimatedTpDb !== null) {
          expect(typeof point!.estimatedTpDb).toBe('number');
        }
        expect(typeof point!.peakEligible).toBe('boolean');

        const stateInfo = classifyGainPointState(point!, fixture.constraints.toleranceLu);
        expect(['FEASIBLE', 'PEAK_LIMITED', 'OUT_OF_RANGE']).toContain(stateInfo.state);
      }

      // Ensure points array remains unmodified
      expect(result.points.length).toBe(481);
      expect(result.status).toBe('GAIN_BLOCKED_PEAK_OR_RANGE');
    });
  });
});
