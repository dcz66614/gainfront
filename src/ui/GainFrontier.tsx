import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { AnalysisReport, GainPoint, Status } from '../core/types.js';

export type FrontierTriState = 'FEASIBLE' | 'PEAK_LIMITED' | 'OUT_OF_RANGE';

export interface FrontierPointStateInfo {
  state: FrontierTriState;
  label: string;
  badge: string;
  symbol: string;
  description: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

/**
 * Classifies a single gain grid point into one of three visual/contractual states:
 * 1. FEASIBLE: peak eligible AND within loudness tolerance (|L - T| <= toleranceLu)
 * 2. PEAK_LIMITED: peak ineligible (TP > C - 0.3 dB)
 * 3. OUT_OF_RANGE: peak eligible, but level error exceeds tolerance or is null
 */
export function classifyGainPointState(
  point: GainPoint,
  toleranceLu: number = 0.25,
): FrontierPointStateInfo {
  // 1. Peak limit constraint: peakEligible must be true
  if (!point.peakEligible) {
    return {
      state: 'PEAK_LIMITED',
      label: '峰值受限',
      badge: '峰值受限 (TP超标)',
      symbol: '×',
      description: '真实峰值超过安全上限 (TP > C - 0.3 dB)，存在削波或过载风险',
      color: '#f87171',
      bgColor: 'rgba(248, 113, 113, 0.22)',
      borderColor: '#ef4444',
    };
  }

  // 2. Tolerance constraint: |L - T| <= toleranceLu
  if (
    point.levelErrorLu !== null &&
    Math.abs(point.levelErrorLu) <= toleranceLu + 1e-9
  ) {
    return {
      state: 'FEASIBLE',
      label: '可行',
      badge: '可行 (双约束满足)',
      symbol: '✓',
      description: '同时满足安全峰值上限与目标响度容差 (|L - T| ≤ 0.25 LU, TP ≤ C - 0.3 dB)',
      color: '#2dd4bf',
      bgColor: 'rgba(45, 212, 191, 0.22)',
      borderColor: '#14b8a6',
    };
  }

  // 3. Out of range: peak eligible, but level error exceeds tolerance or null
  return {
    state: 'OUT_OF_RANGE',
    label: '范围外',
    badge: '范围外 (偏差超容差)',
    symbol: '~',
    description: '真实峰值合格，但响度偏差超出 ±0.25 LU 容差范围或低于静音门限',
    color: '#fbbf24',
    bgColor: 'rgba(251, 191, 36, 0.22)',
    borderColor: '#f59e0b',
  };
}

export function formatStatusInfo(status: Status): {
  title: string;
  desc: string;
  isFeasible: boolean;
  color: string;
  badgeClass: string;
} {
  switch (status) {
    case 'GAIN_FEASIBLE':
      return {
        title: 'GAIN_FEASIBLE (可达成目标)',
        desc: '在满足真实峰值上限的同时，响度偏差处于容差范围 (±0.25 LU) 内。',
        isFeasible: true,
        color: '#2dd4bf',
        badgeClass: 'badge-feasible',
      };
    case 'GAIN_BLOCKED_PEAK_OR_RANGE':
      return {
        title: 'GAIN_BLOCKED_PEAK_OR_RANGE (不可行：峰值受限或偏差超标)',
        desc: '受真实峰值上限压制，无法在安全峰值内达到目标响度。',
        isFeasible: false,
        color: '#f87171',
        badgeClass: 'badge-blocked',
      };
    case 'NO_PROGRAM':
      return {
        title: 'NO_PROGRAM (无有效节目内容)',
        desc: '所有 400ms 块都未超过门限，不能给出可靠目标调整，不提供推荐最优增益。',
        isFeasible: false,
        color: '#fbbf24',
        badgeClass: 'badge-warning',
      };
    case 'NO_SAFE_GAIN_IN_GRID':
      return {
        title: 'NO_SAFE_GAIN_IN_GRID (网格内无安全增益)',
        desc: '在 -24.0 dB 至 +24.0 dB 搜索范围内，所有候选增益均超出峰值上限。',
        isFeasible: false,
        color: '#f87171',
        badgeClass: 'badge-blocked',
      };
    case 'UNSUPPORTED_WAV':
      return {
        title: 'UNSUPPORTED_WAV (不支持的音频格式)',
        desc: '输入音频格式不符合规范要求。',
        isFeasible: false,
        color: '#f87171',
        badgeClass: 'badge-blocked',
      };
    case 'OUT_OF_SCOPE':
      return {
        title: 'OUT_OF_SCOPE (超出处理范围)',
        desc: '输入超出当前工程规范边界。',
        isFeasible: false,
        color: '#f87171',
        badgeClass: 'badge-blocked',
      };
  }
}

export interface GainFrontierProps {
  report: AnalysisReport | null;
  selectedTick?: number | null;
  onSelectTick?: (tick: number) => void;
}

export const GainFrontier: React.FC<GainFrontierProps> = ({
  report,
  selectedTick: controlledSelectedTick,
  onSelectTick,
}) => {
  const [internalSelectedTick, setInternalSelectedTick] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Sync default selection when report changes
  useEffect(() => {
    if (report?.solver) {
      const defaultTick =
        report.solver.gBestTick ?? report.solver.gTargetTick ?? 0;
      setInternalSelectedTick(defaultTick);
    }
  }, [report]);

  const activeTick = controlledSelectedTick ?? internalSelectedTick ?? 0;

  const handleTickChange = useCallback(
    (tick: number) => {
      const clamped = Math.max(-240, Math.min(240, Math.round(tick)));
      setInternalSelectedTick(clamped);
      if (onSelectTick) {
        onSelectTick(clamped);
      }
    },
    [onSelectTick],
  );

  // SVG Geometry Constants
  const SVG_WIDTH = 1000;
  const SVG_HEIGHT = 270;
  const MARGIN_LEFT = 58;
  const MARGIN_RIGHT = 24;
  const MARGIN_TOP = 40;
  const MARGIN_BOTTOM = 46;
  const CHART_WIDTH = SVG_WIDTH - MARGIN_LEFT - MARGIN_RIGHT; // 918
  const CHART_HEIGHT = SVG_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM; // 184

  // Map gain tick (-240..+240) to SVG X coordinate
  const tickToX = useCallback(
    (tick: number) => {
      const ratio = (tick - -240) / 480;
      return MARGIN_LEFT + ratio * CHART_WIDTH;
    },
    [MARGIN_LEFT, CHART_WIDTH],
  );

  // Map SVG X coordinate to gain tick
  const xToTick = useCallback(
    (clientX: number) => {
      if (!svgRef.current) return 0;
      const rect = svgRef.current.getBoundingClientRect();
      const scale = SVG_WIDTH / rect.width;
      const svgX = (clientX - rect.left) * scale;
      const ratio = (svgX - MARGIN_LEFT) / CHART_WIDTH;
      const clampedRatio = Math.max(0, Math.min(1, ratio));
      return Math.round(-240 + clampedRatio * 480);
    },
    [MARGIN_LEFT, CHART_WIDTH, SVG_WIDTH],
  );

  // SVG pointer event handlers for interactive dragging
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    setIsDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const tick = xToTick(e.clientX);
    handleTickChange(tick);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isDragging && e.buttons !== 1) return;
    const tick = xToTick(e.clientX);
    handleTickChange(tick);
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    setIsDragging(false);
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  if (!report) {
    return (
      <div className="gain-frontier-container" role="region" aria-label="增益前沿与双目标游标">
        <div className="frontier-placeholder" role="status">
          <span>正在等待 Worker 分析数据...（发布版严格禁止临时假数据）</span>
        </div>
      </div>
    );
  }

  const { solver, constraints } = report;
  const { points, status, gBestTick, gTargetTick, minimumGridDeviationLu, peakBoundaryDb, witness } = solver;
  const toleranceLu = constraints.toleranceLu;
  const targetLufs = constraints.targetLufs;

  // Tri-state point count aggregation
  let feasibleCount = 0;
  let peakLimitedCount = 0;
  let outOfRangeCount = 0;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const info = classifyGainPointState(pt, toleranceLu);
    if (info.state === 'FEASIBLE') feasibleCount++;
    else if (info.state === 'PEAK_LIMITED') peakLimitedCount++;
    else outOfRangeCount++;
  }

  // Calculate dynamic LUFS Y-axis bounds
  const validLufsList = points
    .map((p) => p.integratedLufs)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  let minLufs = -48;
  let maxLufs = -8;
  if (validLufsList.length > 0) {
    const minPointLufs = Math.min(...validLufsList);
    const maxPointLufs = Math.max(...validLufsList);
    minLufs = Math.floor(Math.min(minPointLufs, targetLufs - 3) - 1);
    maxLufs = Math.ceil(Math.max(maxPointLufs, targetLufs + 3) + 1);
    if (maxLufs - minLufs < 14) {
      minLufs -= 4;
      maxLufs += 4;
    }
  }

  const lufsToY = (lufs: number) => {
    const clamped = Math.max(minLufs, Math.min(maxLufs, lufs));
    const ratio = (maxLufs - clamped) / (maxLufs - minLufs);
    return MARGIN_TOP + ratio * CHART_HEIGHT;
  };

  // Target and tolerance band coordinates
  const targetY = lufsToY(targetLufs);
  const toleranceTopY = lufsToY(targetLufs + toleranceLu);
  const toleranceBottomY = lufsToY(targetLufs - toleranceLu);
  const toleranceBandHeight = Math.max(2, toleranceBottomY - toleranceTopY);

  // Active inspected point
  const activePoint =
    points.find((p) => p.tick === activeTick) ??
    points[Math.max(0, Math.min(points.length - 1, activeTick + 240))];
  const activeInfo = activePoint
    ? classifyGainPointState(activePoint, toleranceLu)
    : null;

  // Cursors
  const hasGBestCursor = status !== 'NO_PROGRAM' && gBestTick !== null;
  const hasGTargetCursor = gTargetTick !== null;
  const isGBestGTargetCoincident =
    hasGBestCursor && hasGTargetCursor && gBestTick === gTargetTick;

  const statusInfo = formatStatusInfo(status);

  // Y-axis ticks
  const yTicks: number[] = [];
  const yStep = (maxLufs - minLufs) > 30 ? 10 : 5;
  const firstTick = Math.ceil(minLufs / yStep) * yStep;
  for (let t = firstTick; t <= maxLufs; t += yStep) {
    yTicks.push(t);
  }

  // X-axis ticks: -24, -18, -12, -6, 0, +6, +12, +18, +24 dB
  const xMajorTicks = [-240, -180, -120, -60, 0, 60, 120, 180, 240];

  return (
    <div
      className="gain-frontier-container"
      role="region"
      aria-label="481点增益前沿与双目标游标分析视图"
    >
      <style>{`
        .gain-frontier-container {
          display: flex;
          flex-direction: column;
          gap: 16px;
          background-color: var(--bg-card, #20242e);
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 8px;
          padding: 16px;
          font-family: var(--font-sans, sans-serif);
          color: var(--text-main, #f8fafc);
        }
        .frontier-header-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          border-bottom: 1px solid var(--border-color, #2f3644);
          padding-bottom: 12px;
        }
        .frontier-status-block {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
        }
        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 5px;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.2px;
        }
        .status-badge.badge-feasible {
          background-color: rgba(45, 212, 191, 0.16);
          color: #2dd4bf;
          border: 1px solid #14b8a6;
        }
        .status-badge.badge-blocked {
          background-color: rgba(248, 113, 113, 0.16);
          color: #f87171;
          border: 1px solid #ef4444;
        }
        .status-badge.badge-warning {
          background-color: rgba(251, 191, 36, 0.16);
          color: #fbbf24;
          border: 1px solid #f59e0b;
        }
        .frontier-stats-summary {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          font-size: 12px;
        }
        .stat-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 8px;
          border-radius: 4px;
          background-color: rgba(15, 17, 21, 0.6);
          border: 1px solid var(--border-color, #2f3644);
        }
        .stat-feasible { color: #2dd4bf; border-color: rgba(45, 212, 191, 0.3); }
        .stat-limited { color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
        .stat-out { color: #fbbf24; border-color: rgba(251, 191, 36, 0.3); }

        /* SVG Chart Area */
        .frontier-svg-wrapper {
          position: relative;
          background-color: #0f1115;
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 6px;
          overflow: hidden;
          touch-action: none;
          cursor: crosshair;
        }
        .frontier-svg {
          display: block;
          width: 100%;
          height: auto;
          user-select: none;
        }

        /* Scrubber Slider */
        .frontier-slider-row {
          display: flex;
          flex-direction: column;
          gap: 6px;
          background-color: rgba(15, 17, 21, 0.4);
          padding: 8px 12px;
          border-radius: 6px;
          border: 1px solid var(--border-color, #2f3644);
        }
        .frontier-slider-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: var(--text-dim, #94a3b8);
        }
        .slider-gain-readout {
          font-family: monospace;
          font-weight: 600;
          color: #38bdf8;
        }
        .frontier-range-input {
          width: 100%;
          cursor: pointer;
          accent-color: #38bdf8;
        }

        /* Candidate Inspector */
        .frontier-inspector-card {
          background-color: #181b22;
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 6px;
          padding: 12px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .inspector-title-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 13px;
          font-weight: 600;
        }
        .inspector-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        .inspector-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px;
          font-size: 12px;
        }
        .inspector-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
          background-color: rgba(15, 17, 21, 0.5);
          padding: 6px 10px;
          border-radius: 4px;
          border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .inspector-label {
          color: var(--text-dim, #94a3b8);
          font-size: 11px;
        }
        .inspector-val {
          font-family: monospace;
          font-weight: 600;
          font-size: 13px;
        }

        /* Legend */
        .frontier-legend-row {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          padding: 8px 12px;
          background-color: rgba(15, 17, 21, 0.3);
          border-radius: 6px;
          border: 1px solid var(--border-color, #2f3644);
          font-size: 12px;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .legend-box {
          width: 12px;
          height: 12px;
          border-radius: 2px;
          display: inline-block;
        }

        /* Text-First Conclusion Panel */
        .frontier-conclusion-panel {
          background-color: rgba(15, 17, 21, 0.6);
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 6px;
          padding: 12px 16px;
        }
        .conclusion-heading {
          margin: 0 0 10px 0;
          font-size: 14px;
          font-weight: 600;
          color: #38bdf8;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .conclusion-list {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 8px 24px;
          margin: 0;
          padding: 0;
        }
        .conclusion-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          padding: 4px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          font-size: 12px;
        }
        .conclusion-row dt {
          color: var(--text-dim, #94a3b8);
        }
        .conclusion-row dd {
          margin: 0;
          font-family: monospace;
          font-weight: 600;
          text-align: right;
        }

        @media (prefers-reduced-motion: reduce) {
          * {
            animation-duration: 0.01ms !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>

      {/* Top Header & Solver State */}
      <div className="frontier-header-row">
        <div className="frontier-status-block">
          <span
            className={`status-badge ${statusInfo.badgeClass}`}
            id="frontier-status-badge"
            role="status"
          >
            {statusInfo.isFeasible ? '✓' : '×'} {statusInfo.title}
          </span>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>
            {statusInfo.desc}
          </span>
        </div>

        <div className="frontier-stats-summary" aria-label="网格三态统计">
          <span className="stat-pill stat-feasible">
            ✓ 可行: <strong>{feasibleCount}</strong> 格
          </span>
          <span className="stat-pill stat-limited">
            × 峰值受限: <strong>{peakLimitedCount}</strong> 格
          </span>
          <span className="stat-pill stat-out">
            ~ 范围外: <strong>{outOfRangeCount}</strong> 格
          </span>
        </div>
      </div>

      {/* SVG 481-Point Bar Frontier Chart */}
      <div
        className="frontier-svg-wrapper"
        aria-label="481点增益前沿图交互区"
      >
        <svg
          ref={svgRef}
          className="frontier-svg"
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          role="img"
          aria-label="481点增益前沿图（-24.0 dB ~ +24.0 dB，纵轴集成响度 LUFS）"
        >
          <defs>
            <clipPath id="chart-area-clip">
              <rect
                x={MARGIN_LEFT}
                y={MARGIN_TOP}
                width={CHART_WIDTH}
                height={CHART_HEIGHT}
              />
            </clipPath>
          </defs>

          {/* Grid lines & Y-axis labels */}
          {yTicks.map((yVal) => {
            const yPos = lufsToY(yVal);
            return (
              <g key={`y-${yVal}`}>
                <line
                  x1={MARGIN_LEFT}
                  y1={yPos}
                  x2={MARGIN_LEFT + CHART_WIDTH}
                  y2={yPos}
                  stroke="#262c37"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                />
                <text
                  x={MARGIN_LEFT - 8}
                  y={yPos + 4}
                  fill="#64748b"
                  fontSize="10"
                  textAnchor="end"
                  fontFamily="monospace"
                >
                  {yVal} LUFS
                </text>
              </g>
            );
          })}

          {/* X-axis major lines and tick labels */}
          {xMajorTicks.map((tickVal) => {
            const xPos = tickToX(tickVal);
            const dbVal = (tickVal * 0.1).toFixed(0);
            return (
              <g key={`x-${tickVal}`}>
                <line
                  x1={xPos}
                  y1={MARGIN_TOP}
                  x2={xPos}
                  y2={MARGIN_TOP + CHART_HEIGHT}
                  stroke="#262c37"
                  strokeWidth="1"
                />
                <text
                  x={xPos}
                  y={MARGIN_TOP + CHART_HEIGHT + 16}
                  fill="#64748b"
                  fontSize="10"
                  textAnchor="middle"
                  fontFamily="monospace"
                >
                  {tickVal > 0 ? `+${dbVal}` : dbVal} dB
                </text>
              </g>
            );
          })}

          {/* Target LUFS Corridor Band & Line */}
          <rect
            x={MARGIN_LEFT}
            y={toleranceTopY}
            width={CHART_WIDTH}
            height={toleranceBandHeight}
            fill="rgba(45, 212, 191, 0.08)"
            stroke="rgba(45, 212, 191, 0.3)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <line
            x1={MARGIN_LEFT}
            y1={targetY}
            x2={MARGIN_LEFT + CHART_WIDTH}
            y2={targetY}
            stroke="#2dd4bf"
            strokeWidth="1.2"
            strokeDasharray="4 2"
          />
          <text
            x={MARGIN_LEFT + CHART_WIDTH - 6}
            y={targetY - 4}
            fill="#2dd4bf"
            fontSize="10"
            textAnchor="end"
            fontFamily="monospace"
          >
            目标 T: {targetLufs.toFixed(1)} LUFS (±{toleranceLu.toFixed(2)})
          </text>

          {/* 481 Bars Rendering */}
          <g clipPath="url(#chart-area-clip)" className="frontier-bars-group">
            {points.map((pt) => {
              const xPos = tickToX(pt.tick);
              const info = classifyGainPointState(pt, toleranceLu);
              const barWidth = Math.max(1.4, CHART_WIDTH / 481);

              let barY = MARGIN_TOP + CHART_HEIGHT - 2;
              let barHeight = 2;

              if (pt.integratedLufs !== null && Number.isFinite(pt.integratedLufs)) {
                barY = lufsToY(pt.integratedLufs);
                barHeight = Math.max(2, MARGIN_TOP + CHART_HEIGHT - barY);
              }

              return (
                <rect
                  key={`point-${pt.tick}`}
                  x={xPos}
                  y={barY}
                  width={barWidth}
                  height={barHeight}
                  fill={info.color}
                  opacity={0.88}
                >
                  <title>{`增益: ${(pt.tick * 0.1).toFixed(1)} dB (tick ${pt.tick}) | L(g): ${
                    pt.integratedLufs !== null ? pt.integratedLufs.toFixed(2) + ' LUFS' : '无有效响度'
                  } | TP(g): ${
                    pt.estimatedTpDb !== null ? pt.estimatedTpDb.toFixed(2) + ' dBTP' : 'N/A'
                  } | 状态: ${info.label}`}</title>
                </rect>
              );
            })}
          </g>

          {/* gTarget Cursor (Unconstrained Best Candidate) */}
          {hasGTargetCursor && !isGBestGTargetCoincident && (
            <g className="cursor-gtarget">
              <line
                x1={tickToX(gTargetTick!)}
                y1={MARGIN_TOP - 16}
                x2={tickToX(gTargetTick!)}
                y2={MARGIN_TOP + CHART_HEIGHT}
                stroke="#a78bfa"
                strokeWidth="1.8"
                strokeDasharray="4 3"
              />
              <rect
                x={tickToX(gTargetTick!) - 42}
                y={MARGIN_TOP - 32}
                width={84}
                height={16}
                fill="#1e1b4b"
                stroke="#a78bfa"
                strokeWidth="1"
                rx={3}
              />
              <text
                x={tickToX(gTargetTick!)}
                y={MARGIN_TOP - 20}
                fill="#c4b5fd"
                fontSize="10"
                fontWeight="bold"
                textAnchor="middle"
                fontFamily="monospace"
              >
                gTarget: {(gTargetTick! * 0.1).toFixed(1)}dB
              </text>
            </g>
          )}

          {/* gBest Cursor (Recommended Optimal Feasible Gain) */}
          {hasGBestCursor && !isGBestGTargetCoincident && (
            <g className="cursor-gbest">
              <line
                x1={tickToX(gBestTick!)}
                y1={MARGIN_TOP - 16}
                x2={tickToX(gBestTick!)}
                y2={MARGIN_TOP + CHART_HEIGHT}
                stroke="#2dd4bf"
                strokeWidth="2.5"
              />
              <rect
                x={tickToX(gBestTick!) - 38}
                y={MARGIN_TOP - 32}
                width={76}
                height={16}
                fill="#134e4a"
                stroke="#2dd4bf"
                strokeWidth="1.2"
                rx={3}
              />
              <text
                x={tickToX(gBestTick!)}
                y={MARGIN_TOP - 20}
                fill="#2dd4bf"
                fontSize="10"
                fontWeight="bold"
                textAnchor="middle"
                fontFamily="monospace"
              >
                gBest: {(gBestTick! * 0.1).toFixed(1)}dB
              </text>
            </g>
          )}

          {/* Coincident gBest / gTarget Cursor (e.g. GF-B) */}
          {isGBestGTargetCoincident && (
            <g className="cursor-gbest-gtarget-coincident">
              <line
                x1={tickToX(gBestTick!)}
                y1={MARGIN_TOP - 16}
                x2={tickToX(gBestTick!)}
                y2={MARGIN_TOP + CHART_HEIGHT}
                stroke="#2dd4bf"
                strokeWidth="2.5"
              />
              <rect
                x={tickToX(gBestTick!) - 62}
                y={MARGIN_TOP - 32}
                width={124}
                height={16}
                fill="#134e4a"
                stroke="#2dd4bf"
                strokeWidth="1.2"
                rx={3}
              />
              <text
                x={tickToX(gBestTick!)}
                y={MARGIN_TOP - 20}
                fill="#2dd4bf"
                fontSize="10"
                fontWeight="bold"
                textAnchor="middle"
                fontFamily="monospace"
              >
                gBest & gTarget: {(gBestTick! * 0.1).toFixed(1)}dB
              </text>
            </g>
          )}

          {/* Active Candidate Inspected Cursor (Scrubbing position) */}
          <g className="cursor-inspected-candidate">
            <line
              x1={tickToX(activeTick)}
              y1={MARGIN_TOP}
              x2={tickToX(activeTick)}
              y2={MARGIN_TOP + CHART_HEIGHT}
              stroke="#38bdf8"
              strokeWidth="1.5"
              strokeDasharray="2 2"
            />
            {/* Diamond marker at cursor bottom */}
            <polygon
              points={`${tickToX(activeTick)},${MARGIN_TOP + CHART_HEIGHT + 2} ${tickToX(activeTick) - 4},${MARGIN_TOP + CHART_HEIGHT + 8} ${tickToX(activeTick) + 4},${MARGIN_TOP + CHART_HEIGHT + 8}`}
              fill="#38bdf8"
            />
          </g>

          {/* Chart Border */}
          <rect
            x={MARGIN_LEFT}
            y={MARGIN_TOP}
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            fill="none"
            stroke="#2f3644"
            strokeWidth="1"
          />
        </svg>
      </div>

      {/* Accessible Interactive Range Slider for Dragging/Keyboard Scrubbing */}
      <div className="frontier-slider-row">
        <div className="frontier-slider-meta">
          <span>拖动游标或点击网格选择候选增益 (Scrub Candidate Gain):</span>
          <span className="slider-gain-readout">
            {(activeTick * 0.1).toFixed(1)} dB (tick {activeTick})
          </span>
        </div>
        <input
          type="range"
          id="gain-scrubber"
          className="frontier-range-input"
          min={-240}
          max={240}
          step={1}
          value={activeTick}
          onChange={(e) => handleTickChange(Number(e.target.value))}
          aria-label="拖动或选择候选增益 (-24.0 dB ~ +24.0 dB)"
        />
      </div>

      {/* Candidate Inspector: strictly taken from points, no recalculation */}
      {activePoint && activeInfo && (
        <div
          className="frontier-inspector-card"
          role="region"
          aria-label="当前候选增益检测卡"
        >
          <div className="inspector-title-row">
            <span>
              候选增益详情 (Candidate Inspector):{' '}
              <strong style={{ color: '#38bdf8' }}>
                {(activeTick * 0.1).toFixed(1)} dB (格点 tick: {activeTick})
              </strong>
            </span>
            <span
              className="inspector-badge"
              style={{
                backgroundColor: activeInfo.bgColor,
                color: activeInfo.color,
                border: `1px solid ${activeInfo.borderColor}`,
              }}
            >
              {activeInfo.symbol} {activeInfo.badge}
            </span>
          </div>

          <div className="inspector-grid">
            <div className="inspector-item">
              <span className="inspector-label">对应集成响度 L(g):</span>
              <span className="inspector-val">
                {activePoint.integratedLufs !== null
                  ? `${activePoint.integratedLufs.toFixed(2)} LUFS`
                  : '无有效响度 (未达门限)'}
              </span>
            </div>

            <div className="inspector-item">
              <span className="inspector-label">对应真实峰值 TP(g):</span>
              <span className="inspector-val">
                {activePoint.estimatedTpDb !== null
                  ? `${activePoint.estimatedTpDb.toFixed(2)} dBTP`
                  : 'N/A'}
              </span>
            </div>

            <div className="inspector-item">
              <span className="inspector-label">真实峰值安全判定:</span>
              <span
                className="inspector-val"
                style={{ color: activePoint.peakEligible ? '#2dd4bf' : '#f87171' }}
              >
                {activePoint.peakEligible
                  ? '合格 (≤ 上限 - 0.3dB)'
                  : '超标 (TP > 上限 - 0.3dB)'}
              </span>
            </div>

            <div className="inspector-item">
              <span className="inspector-label">目标响度偏差 (L - T):</span>
              <span className="inspector-val">
                {activePoint.levelErrorLu !== null
                  ? `${activePoint.levelErrorLu > 0 ? '+' : ''}${activePoint.levelErrorLu.toFixed(2)} LU`
                  : 'N/A'}
              </span>
            </div>
          </div>

          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
            判定语义：{activeInfo.description}（全部数值取自求解器预存 points，拖动不改动求解结果）
          </div>
        </div>
      )}

      {/* Legend with Color-Text Semantic Consistency */}
      <div className="frontier-legend-row" role="region" aria-label="三态图例说明">
        <div className="legend-item">
          <span className="legend-box" style={{ backgroundColor: '#2dd4bf' }} />
          <span>
            <strong>✓ 可行 (FEASIBLE):</strong> 真实峰值安全 (TP ≤ C - 0.3 dB) 且偏差满足容差 (|L-T| ≤ 0.25 LU)
          </span>
        </div>
        <div className="legend-item">
          <span className="legend-box" style={{ backgroundColor: '#fbbf24' }} />
          <span>
            <strong>~ 范围外 (OUT_OF_RANGE):</strong> 真实峰值合格，但响度偏差超容差或未达门限
          </span>
        </div>
        <div className="legend-item">
          <span className="legend-box" style={{ backgroundColor: '#f87171' }} />
          <span>
            <strong>× 峰值受限 (PEAK_LIMITED):</strong> 真实峰值超出安全上限 (TP &gt; C - 0.3 dB)
          </span>
        </div>
      </div>

      {/* Text-First Authoritative Conclusion Panel */}
      <div
        className="frontier-conclusion-panel"
        role="region"
        aria-label="声限求解权威文本结论"
      >
        <h4 className="conclusion-heading">
          声限求解权威文本结论 (Text-First Conclusion)
        </h4>

        <dl className="conclusion-list">
          <div className="conclusion-row">
            <dt>求解状态代码 (Status):</dt>
            <dd style={{ color: statusInfo.color }}>{status}</dd>
          </div>

          <div className="conclusion-row">
            <dt>状态中文解读 (Interpretation):</dt>
            <dd>{statusInfo.title}</dd>
          </div>

          <div className="conclusion-row">
            <dt>推荐最优增益 (gBest):</dt>
            <dd style={{ color: '#2dd4bf' }}>
              {status !== 'NO_PROGRAM' && gBestTick !== null
                ? `${(gBestTick * 0.1).toFixed(1)} dB (tick ${gBestTick})`
                : '无推荐增益 (不提供 gBest)'}
            </dd>
          </div>

          <div className="conclusion-row">
            <dt>目标理论增益 (gTarget):</dt>
            <dd style={{ color: '#c4b5fd' }}>
              {gTargetTick !== null
                ? `${(gTargetTick * 0.1).toFixed(1)} dB (tick ${gTargetTick})`
                : '无有效目标增益'}
            </dd>
          </div>

          <div className="conclusion-row">
            <dt>最小网格偏差 (Min Grid Deviation):</dt>
            <dd>
              {minimumGridDeviationLu !== null
                ? `${minimumGridDeviationLu.toFixed(4)} LU`
                : 'N/A'}
            </dd>
          </div>

          <div className="conclusion-row">
            <dt>峰值安全增益上限 (Peak Boundary):</dt>
            <dd>
              {peakBoundaryDb !== null
                ? `${peakBoundaryDb.toFixed(2)} dB`
                : 'N/A'}
            </dd>
          </div>

          <div className="conclusion-row">
            <dt>481 格搜索统计 (-24dB ~ +24dB):</dt>
            <dd>
              可行: {feasibleCount} 格 · 峰值受限: {peakLimitedCount} 格 · 范围外: {outOfRangeCount} 格
            </dd>
          </div>

          <div className="conclusion-row">
            <dt>求解器见证判定 (Witness):</dt>
            <dd style={{ maxWidth: '480px', textAlign: 'right', whiteSpace: 'normal' }}>
              {witness.reasons.length > 0 ? witness.reasons.join('；') : '无额外见证说明'}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
};
