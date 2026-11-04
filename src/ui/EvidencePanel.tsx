import React from 'react';
import type { AnalysisReport, Status } from '../core/types.js';

export interface EvidencePanelProps {
  report: AnalysisReport | null;
}

export interface FormattedEvidence {
  status: Status;
  statusLabel: string;
  isFeasible: boolean;
  gBestText: string;
  gBestNum: number | null;
  gTargetText: string;
  gTargetNum: number | null;
  deviationText: string;
  deviationNum: number | null;
  peakBoundaryText: string;
  peakBoundaryNum: number | null;
  samplePeakFrameText: string;
  samplePeakFrameNum: number | null;
  samplePeakDbFsText: string;
  estimatedTruePeakText: string;
  estimatedPeakPositionText: string;
  witnessReasons: readonly string[];
  targetLufsText: string;
  peakCeilingText: string;
  toleranceText: string;
  marginText: string;
  effectiveCeilingText: string;
  blockCount: number;
  absGatePassedCount: number;
  relGatePassedCount: number;
}

export const EVIDENCE_DISCLAIMER_TEXT =
  '【常驻免责声明】本工具采用 4× 窗函数 sinc 插值近似估计真峰值（非 ITU-R BS.1770 Annex 2 认证硬件仪表），0.30 dB 裕量为工程保守估计，测量与推荐增益仅供参考，不作为法定广播合规证书或平台审核通过凭据。全部数值均基于 Float64 真实计算，无编造数据。';

/**
 * Format evidence metrics from real AnalysisReport.
 * Never invents, mocks, or hardcodes values.
 */
export function formatEvidenceMetrics(report: AnalysisReport): FormattedEvidence {
  const solver = report.solver;
  const meas = report.measurement;
  const cons = report.constraints;

  const isFeasible = solver.status === 'GAIN_FEASIBLE';

  let statusLabel: string;
  switch (solver.status) {
    case 'GAIN_FEASIBLE':
      statusLabel = '可行 (GAIN_FEASIBLE)';
      break;
    case 'GAIN_BLOCKED_PEAK_OR_RANGE':
      statusLabel = '受阻：峰值或范围限制 (GAIN_BLOCKED_PEAK_OR_RANGE)';
      break;
    case 'NO_PROGRAM':
      statusLabel = '无节目内容 (NO_PROGRAM)';
      break;
    case 'NO_SAFE_GAIN_IN_GRID':
      statusLabel = '网格内无安全增益 (NO_SAFE_GAIN_IN_GRID)';
      break;
    case 'UNSUPPORTED_WAV':
      statusLabel = '不支持的 WAV (UNSUPPORTED_WAV)';
      break;
    case 'OUT_OF_SCOPE':
      statusLabel = '超出范围 (OUT_OF_SCOPE)';
      break;
    default:
      statusLabel = solver.status;
  }

  const gBestNum = solver.gBestTick !== null ? solver.gBestTick * 0.1 : null;
  const gTargetNum = solver.gTargetTick !== null ? solver.gTargetTick * 0.1 : null;
  const deviationNum = solver.minimumGridDeviationLu;
  const peakBoundaryNum = solver.peakBoundaryDb;

  const gBestText =
    gBestNum !== null ? `${gBestNum >= 0 ? '+' : ''}${gBestNum.toFixed(1)} dB` : '无推荐增益';
  const gTargetText =
    gTargetNum !== null ? `${gTargetNum >= 0 ? '+' : ''}${gTargetNum.toFixed(1)} dB` : '无';
  const deviationText =
    deviationNum !== null ? `${deviationNum.toFixed(4)} LU` : '无偏差';
  const peakBoundaryText =
    peakBoundaryNum !== null ? `${peakBoundaryNum.toFixed(2)} dB` : '无边界';

  const samplePeakFrameNum = meas.samplePeakFrame;
  const samplePeakFrameText =
    samplePeakFrameNum !== null ? `帧 ${samplePeakFrameNum}` : 'N/A';

  const samplePeakDbFsText =
    meas.samplePeakDbFs !== null ? `${meas.samplePeakDbFs.toFixed(2)} dBFS` : 'N/A';
  const estimatedTruePeakText =
    meas.estimatedTruePeakDbTp !== null
      ? `${meas.estimatedTruePeakDbTp.toFixed(2)} dBTP`
      : 'N/A';

  const estimatedPeakPositionText = meas.estimatedPeakPosition
    ? `帧 ${meas.estimatedPeakPosition.frame} (1/4点: ${meas.estimatedPeakPosition.quarter}, 声道: ${meas.estimatedPeakPosition.channel})`
    : 'N/A';

  const blockCount = meas.blockPowers.length;
  const absGatePassedCount = meas.absoluteGate.filter(Boolean).length;
  const relGatePassedCount = meas.relativeGate.filter(Boolean).length;

  return {
    status: solver.status,
    statusLabel,
    isFeasible,
    gBestText,
    gBestNum,
    gTargetText,
    gTargetNum,
    deviationText,
    deviationNum,
    peakBoundaryText,
    peakBoundaryNum,
    samplePeakFrameText,
    samplePeakFrameNum,
    samplePeakDbFsText,
    estimatedTruePeakText,
    estimatedPeakPositionText,
    witnessReasons: solver.witness.reasons,
    targetLufsText: `${cons.targetLufs.toFixed(1)} LUFS`,
    peakCeilingText: `${cons.peakCeilingDbTp.toFixed(1)} dBTP`,
    toleranceText: `±${cons.toleranceLu.toFixed(2)} LU`,
    marginText: `${cons.marginDb.toFixed(2)} dB`,
    effectiveCeilingText: `${(cons.peakCeilingDbTp - cons.marginDb).toFixed(2)} dBTP`,
    blockCount,
    absGatePassedCount,
    relGatePassedCount,
  };
}

export const EvidencePanel: React.FC<EvidencePanelProps> = ({ report }) => {
  return (
    <div className="evidence-panel-container" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {!report ? (
        <div className="slot-placeholder" data-testid="evidence-waiting">
          <span>正在等待 Worker 分析数据...（发布版严格禁止临时假数据）</span>
        </div>
      ) : (
        (() => {
          const ev = formatEvidenceMetrics(report);
          return (
            <div className="witness-container" data-testid="evidence-report">
              {/* Section 1: 求解见证与理由 */}
              <div className="witness-block">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h4 style={{ margin: 0 }}>求解见证理由 (Witness Reasons)</h4>
                  <span
                    className="slot-badge"
                    style={{
                      borderColor: ev.isFeasible ? '#14b8a6' : '#ef4444',
                      color: ev.isFeasible ? '#2dd4bf' : '#f87171',
                    }}
                    data-testid="evidence-status-badge"
                  >
                    {ev.statusLabel}
                  </span>
                </div>
                <ul className="witness-reasons-list" data-testid="witness-reasons-list">
                  {ev.witnessReasons.length > 0 ? (
                    ev.witnessReasons.map((reason, idx) => (
                      <li key={idx} data-testid={`witness-reason-${idx}`}>
                        {reason}
                      </li>
                    ))
                  ) : (
                    <li>无见证理由信息</li>
                  )}
                </ul>
              </div>

              {/* Section 2: 关键差距、目标与边界数值 */}
              <div className="witness-block">
                <h4>求解器数值见证与边界 (Solver Evidence & Boundaries)</h4>
                <dl className="metrics-list" style={{ marginTop: '8px' }}>
                  <div className="metric-row">
                    <dt>最佳候选增益 (gBest):</dt>
                    <dd className="highlight-metric" data-testid="evidence-g-best">
                      {ev.gBestText}
                    </dd>
                  </div>
                  <div className="metric-row">
                    <dt>无约束目标增益 (gTarget):</dt>
                    <dd data-testid="evidence-g-target">{ev.gTargetText}</dd>
                  </div>
                  <div className="metric-row">
                    <dt>最小网格偏差 (Minimum Deviation):</dt>
                    <dd data-testid="evidence-deviation">{ev.deviationText}</dd>
                  </div>
                  <div className="metric-row">
                    <dt>安全真峰边界 (Peak Boundary):</dt>
                    <dd data-testid="evidence-peak-boundary">{ev.peakBoundaryText}</dd>
                  </div>
                </dl>
              </div>

              {/* Section 3: 优化约束与门限参数 */}
              <div className="witness-block">
                <h4>优化约束参数 (Optimization Constraints)</h4>
                <ul className="witness-constraints-list" data-testid="witness-constraints-list">
                  <li>目标集成响度 T: {ev.targetLufsText}</li>
                  <li>真峰值上限 C: {ev.peakCeilingText}</li>
                  <li>响度容差范围 (Tolerance): {ev.toleranceText}</li>
                  <li>保守峰值裕量 (Margin): {ev.marginText}</li>
                  <li>有效峰值上限 (C - Margin): {ev.effectiveCeilingText}</li>
                  <li>声源性质: {report.synthetic ? '确定性合成预设 (Deterministic)' : '外部 WAV 本地分析'}</li>
                </ul>
              </div>

              {/* Section 4: 采样峰、估计真峰与门限块定位 */}
              <div className="witness-block">
                <h4>峰值位置与门限状态 (Peak Coordinates & Gates)</h4>
                <dl className="metrics-list" style={{ marginTop: '8px' }}>
                  <div className="metric-row">
                    <dt>原始采样峰值 (Sample Peak):</dt>
                    <dd data-testid="evidence-sample-peak">{ev.samplePeakDbFsText}</dd>
                  </div>
                  <div className="metric-row">
                    <dt>采样峰值所在帧 (Peak Frame):</dt>
                    <dd data-testid="evidence-peak-frame">{ev.samplePeakFrameText}</dd>
                  </div>
                  <div className="metric-row">
                    <dt>4× 插值估计真峰值 (Estimated TP):</dt>
                    <dd className="highlight-metric" data-testid="evidence-estimated-tp">{ev.estimatedTruePeakText}</dd>
                  </div>
                  <div className="metric-row">
                    <dt>插值微坐标 (Estimated Peak Position):</dt>
                    <dd data-testid="evidence-peak-position">{ev.estimatedPeakPositionText}</dd>
                  </div>
                  <div className="metric-row">
                    <dt>400ms 门限块通过数 (Gates):</dt>
                    <dd data-testid="evidence-gate-summary">
                      绝对门限: {ev.absGatePassedCount} / {ev.blockCount} 块 · 相对门限: {ev.relGatePassedCount} / {ev.blockCount} 块
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          );
        })()
      )}

      {/* 免责声明常驻可见：不得折叠隐藏或随面板关闭而消失 */}
      <div
        className="evidence-permanent-disclaimer"
        data-testid="evidence-permanent-disclaimer"
        style={{
          backgroundColor: 'rgba(251, 191, 36, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          borderRadius: '4px',
          padding: '10px 12px',
          fontSize: '0.75rem',
          color: '#fbbf24',
          lineHeight: 1.5,
        }}
      >
        <span style={{ fontWeight: 600, display: 'block', marginBottom: '2px' }}>
          常驻免责与合规声明
        </span>
        {EVIDENCE_DISCLAIMER_TEXT}
      </div>
    </div>
  );
};
