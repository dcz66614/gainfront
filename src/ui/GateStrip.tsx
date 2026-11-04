import React, { useState } from 'react';
import type { AnalysisReport } from '../core/types.js';

export type GateTriState = 'PASSED' | 'RELATIVE_OUT' | 'ABSOLUTE_OUT';

export interface GateStateInfo {
  state: GateTriState;
  label: string;
  badge: string;
  symbol: string;
  description: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

export function classifyGateState(isAbsPassed: boolean, isRelPassed: boolean): GateStateInfo {
  if (!isAbsPassed) {
    return {
      state: 'ABSOLUTE_OUT',
      label: '绝对门外',
      badge: '门外 (< -70)',
      symbol: '×',
      description: '未达到 -70 LUFS 绝对门限（静音或极低能量段，不计入平均响度）',
      color: '#f87171',
      bgColor: 'rgba(248, 113, 113, 0.22)',
      borderColor: '#ef4444',
    };
  }
  if (!isRelPassed) {
    return {
      state: 'RELATIVE_OUT',
      label: '相对门外',
      badge: '门外 (< Γ_r)',
      symbol: '~',
      description: '高于绝对门限，但低于相对门限 Γ_r = max(-70, L_A - 10)（不计入最终集成）',
      color: '#fbbf24',
      bgColor: 'rgba(251, 191, 36, 0.22)',
      borderColor: '#f59e0b',
    };
  }
  return {
    state: 'PASSED',
    label: '通过',
    badge: '双门通过',
    symbol: '✓',
    description: '通过绝对与相对双阶段门限（计入最终集成响度计算）',
    color: '#2dd4bf',
    bgColor: 'rgba(45, 212, 191, 0.22)',
    borderColor: '#14b8a6',
  };
}

export interface GateStripProps {
  report: AnalysisReport | null;
}

export const GateStrip: React.FC<GateStripProps> = ({ report }) => {
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number | null>(null);

  if (!report) {
    return (
      <div className="gate-strip-container" role="region" aria-label="400ms 门限灯带">
        <div className="gate-strip-placeholder" role="status">
          <span>正在等待 Worker 分析数据...（发布版严格禁止临时假数据）</span>
        </div>
      </div>
    );
  }

  const { measurement, source } = report;
  const { blockPowers, absoluteGate, relativeGate } = measurement;
  const totalBlocks = blockPowers.length;

  let passedCount = 0;
  let relOutCount = 0;
  let absOutCount = 0;

  const blocksMeta: Array<{ index: number; startSec: number; endSec: number; info: GateStateInfo }> = [];

  for (let i = 0; i < totalBlocks; i++) {
    const isAbs = absoluteGate[i] ?? false;
    const isRel = relativeGate[i] ?? false;
    const info = classifyGateState(isAbs, isRel);

    if (info.state === 'PASSED') passedCount++;
    else if (info.state === 'RELATIVE_OUT') relOutCount++;
    else absOutCount++;

    const startSec = i * 0.1;
    const endSec = startSec + 0.4;
    blocksMeta.push({ index: i, startSec, endSec, info });
  }

  // Active block to display in inspector card (default to selected or first or last)
  const activeBlock =
    selectedBlockIndex !== null && selectedBlockIndex >= 0 && selectedBlockIndex < totalBlocks
      ? blocksMeta[selectedBlockIndex]
      : null;

  const isPresetGFF = source.kind === 'preset' && source.presetId === 'GF-F';

  return (
    <div className="gate-strip-container" role="region" aria-label="400ms 门限灯带">
      <style>{`
        .gate-strip-container {
          display: flex;
          flex-direction: column;
          gap: 12px;
          background-color: var(--bg-card, #20242e);
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 8px;
          padding: 14px 16px;
          font-family: var(--font-sans, sans-serif);
          color: var(--text-main, #f8fafc);
        }
        .gate-summary-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 13px;
        }
        .gate-stats-group {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
        }
        .gate-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          border: 1px solid transparent;
        }
        .gate-badge-passed {
          background-color: rgba(45, 212, 191, 0.15);
          color: #2dd4bf;
          border-color: rgba(45, 212, 191, 0.4);
        }
        .gate-badge-rel-out {
          background-color: rgba(251, 191, 36, 0.15);
          color: #fbbf24;
          border-color: rgba(251, 191, 36, 0.4);
        }
        .gate-badge-abs-out {
          background-color: rgba(248, 113, 113, 0.15);
          color: #f87171;
          border-color: rgba(248, 113, 113, 0.4);
        }
        .gate-special-alert {
          background-color: rgba(248, 113, 113, 0.12);
          border: 1px dashed #ef4444;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 12px;
          color: #fca5a5;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .gate-lamps-wrapper {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .gate-ruler {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: var(--text-dim, #64748b);
          padding: 0 2px;
          user-select: none;
        }
        .gate-lamps-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(11px, 1fr));
          gap: 2px;
          background-color: rgba(15, 17, 21, 0.5);
          padding: 6px;
          border-radius: 6px;
          border: 1px solid var(--border-color, #2f3644);
        }
        .gate-lamp {
          height: 32px;
          min-width: 9px;
          border-radius: 3px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform 0.1s ease, box-shadow 0.1s ease;
          border: 1px solid transparent;
          font-size: 10px;
          font-weight: 700;
          user-select: none;
        }
        .gate-lamp:hover, .gate-lamp:focus-visible {
          transform: translateY(-2px);
          box-shadow: 0 0 6px currentColor;
          outline: 2px solid #38bdf8;
          outline-offset: 1px;
          z-index: 2;
        }
        .gate-lamp-active {
          outline: 2px solid #ffffff !important;
          outline-offset: 1px;
          transform: translateY(-2px);
        }
        .gate-lamp-symbol {
          line-height: 1;
        }
        .gate-inspector {
          background-color: var(--bg-surface, #181b22);
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .gate-inspector-title {
          font-weight: 600;
          color: var(--text-main, #f8fafc);
        }
        .gate-inspector-desc {
          color: var(--text-muted, #94a3b8);
        }
      `}</style>

      {/* Header and stats */}
      <div className="gate-summary-row">
        <div>
          <strong>400ms 双阶段门限灯带</strong>
          <span style={{ marginLeft: '8px', color: 'var(--text-muted, #94a3b8)' }}>
            总计 {totalBlocks} 块 (0.4s 窗长，0.1s 步进)
          </span>
        </div>
        <div className="gate-stats-group" role="group" aria-label="门限通过三态统计">
          <span className="gate-badge gate-badge-passed" title="双阶段门限全部通过">
            <span>✓</span> 通过: {passedCount} 块
          </span>
          <span className="gate-badge gate-badge-rel-out" title="高于绝对门限但低于相对门限">
            <span>~</span> 相对门外: {relOutCount} 块
          </span>
          <span className="gate-badge gate-badge-abs-out" title="低于绝对门限 (-70 LUFS)">
            <span>×</span> 绝对门外: {absOutCount} 块
          </span>
        </div>
      </div>

      {/* Special callout for GF-F silence prefix */}
      {isPresetGFF && (
        <div className="gate-special-alert" role="status" aria-live="polite">
          <strong>GF-F 静音见证：</strong> 前 2.0 秒（前 17 块完全落入静音区）样本全为零，全部显示为
          <span style={{ color: '#f87171', fontWeight: 600, margin: '0 4px' }}>绝对门外 (未通过)</span>
          ；后 6 秒恢复有效正弦波。
        </div>
      )}

      {/* 77-Block Lamp Grid */}
      <div className="gate-lamps-wrapper">
        <div className="gate-ruler" aria-hidden="true">
          <span>0.0s (块 #1)</span>
          <span>2.0s (块 #17)</span>
          <span>4.0s (块 #37)</span>
          <span>6.0s (块 #57)</span>
          <span>8.0s (块 #77)</span>
        </div>

        <div
          className="gate-lamps-grid"
          role="list"
          aria-label="77 块门限灯带（三态可视化）"
        >
          {blocksMeta.map((b) => {
            const isSelected = selectedBlockIndex === b.index;
            return (
              <button
                type="button"
                key={b.index}
                className={`gate-lamp ${isSelected ? 'gate-lamp-active' : ''}`}
                style={{
                  backgroundColor: b.info.bgColor,
                  color: b.info.color,
                  borderColor: b.info.borderColor,
                }}
                role="listitem"
                tabIndex={0}
                aria-label={`块 #${b.index + 1} (${b.startSec.toFixed(1)}s - ${b.endSec.toFixed(1)}s): ${b.info.label} (${b.info.description})`}
                title={`块 #${b.index + 1} (${b.startSec.toFixed(1)}s - ${b.endSec.toFixed(1)}s)\n状态: ${b.info.label}\n说明: ${b.info.description}`}
                onClick={() => setSelectedBlockIndex(b.index)}
                onFocus={() => setSelectedBlockIndex(b.index)}
                data-block-index={b.index}
                data-gate-state={b.info.state}
              >
                <span className="gate-lamp-symbol" aria-hidden="true">
                  {b.info.symbol}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Block Inspector */}
      <div className="gate-inspector" aria-live="polite">
        {activeBlock ? (
          <>
            <div>
              <span className="gate-inspector-title">
                块 #{activeBlock.index + 1} ({activeBlock.startSec.toFixed(1)}s -{' '}
                {activeBlock.endSec.toFixed(1)}s)
              </span>
              <span
                style={{
                  display: 'inline-block',
                  marginLeft: '8px',
                  padding: '2px 6px',
                  borderRadius: '3px',
                  fontSize: '11px',
                  fontWeight: 600,
                  backgroundColor: activeBlock.info.bgColor,
                  color: activeBlock.info.color,
                  border: `1px solid ${activeBlock.info.borderColor}`,
                }}
              >
                {activeBlock.info.label} ({activeBlock.info.badge})
              </span>
            </div>
            <div className="gate-inspector-desc">{activeBlock.info.description}</div>
          </>
        ) : (
          <div className="gate-inspector-desc">
            点击或聚焦任意门限块可查看具体时间窗与双门限判定细节（颜色与文本严格一致）
          </div>
        )}
      </div>
    </div>
  );
};
