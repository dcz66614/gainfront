import React, { useMemo } from 'react';
import type { AnalysisReport, PCM } from '../core/types.js';

export interface WaveCompareProps {
  report: AnalysisReport | null;
  pcm?: PCM | null;
}

export interface WaveformBin {
  x: number;
  minRaw: number;
  maxRaw: number;
  minGained: number;
  maxGained: number;
}

/**
 * Computes display envelope bins for waveform rendering.
 * Does not mutate PCM or calculate DSP results.
 */
export function computeWaveformBins(
  channelData: Float64Array,
  totalFrames: number,
  numBins: number,
  gainMultiplier: number,
): WaveformBin[] {
  const bins: WaveformBin[] = [];
  const framesPerBin = totalFrames / numBins;

  for (let b = 0; b < numBins; b++) {
    const startIdx = Math.floor(b * framesPerBin);
    const endIdx = Math.min(totalFrames, Math.floor((b + 1) * framesPerBin));

    let min = 0.0;
    let max = 0.0;

    for (let i = startIdx; i < endIdx; i++) {
      const val = channelData[i];
      if (val < min) min = val;
      if (val > max) max = val;
    }

    bins.push({
      x: b,
      minRaw: min,
      maxRaw: max,
      minGained: min * gainMultiplier,
      maxGained: max * gainMultiplier,
    });
  }

  return bins;
}

export const WaveCompare: React.FC<WaveCompareProps> = ({ report, pcm }) => {
  if (!report) {
    return (
      <div className="wave-compare-container" role="region" aria-label="波形对比视图">
        <div className="wave-compare-placeholder" role="status">
          <span>正在等待 Worker 分析数据...（发布版严格禁止临时假数据）</span>
        </div>
      </div>
    );
  }

  const { measurement, solver, provenance } = report;
  const samplePeakFrame = measurement.samplePeakFrame;
  const estimatedPeakPosition = measurement.estimatedPeakPosition;
  const samplePeakDbFs = measurement.samplePeakDbFs;
  const estimatedTruePeakDbTp = measurement.estimatedTruePeakDbTp;

  // gBest gain computation strictly per contract:
  // 增益后 = 原始样本 × 10^(gBest/20)，仅用于显示，不得改动分析数据
  const gBestTick = solver.gBestTick;
  const hasGBest = gBestTick !== null;
  const gBestDb = hasGBest ? gBestTick * 0.1 : 0.0;
  const gainMultiplier = hasGBest ? Math.pow(10, gBestDb / 20) : 1.0;

  const totalFrames = pcm?.frames ?? provenance?.frames ?? 384000;
  const durationSec = provenance?.durationSeconds ?? totalFrames / 48000;

  const SVG_WIDTH = 1000;
  const SVG_HEIGHT = 260;
  const Y_CENTER = 130;
  const Y_SCALE = 90; // amplitude 1.0 = 90px

  const clampY = (amp: number) => {
    return Math.max(8, Math.min(SVG_HEIGHT - 8, Y_CENTER - amp * Y_SCALE));
  };

  // Compute waveform downsampling bins if PCM is available
  const bins = useMemo(() => {
    if (!pcm || pcm.planar.length === 0) return null;
    const channelData = pcm.planar[0];
    return computeWaveformBins(channelData, pcm.frames, SVG_WIDTH, gainMultiplier);
  }, [pcm, gainMultiplier]);

  // Construct SVG polygon paths for raw and post-gain envelopes
  const { rawPath, gainedPath } = useMemo(() => {
    if (!bins || bins.length === 0) {
      return { rawPath: '', gainedPath: '' };
    }

    // Raw waveform path: top edge forward, bottom edge backward
    let rawTop = `M 0 ${clampY(bins[0].maxRaw)}`;
    let rawBottom = '';
    for (let i = 1; i < bins.length; i++) {
      rawTop += ` L ${bins[i].x} ${clampY(bins[i].maxRaw)}`;
    }
    for (let i = bins.length - 1; i >= 0; i--) {
      rawBottom += ` L ${bins[i].x} ${clampY(bins[i].minRaw)}`;
    }
    const raw = `${rawTop} ${rawBottom} Z`;

    // Post-gain waveform path
    let gainedTop = `M 0 ${clampY(bins[0].maxGained)}`;
    let gainedBottom = '';
    for (let i = 1; i < bins.length; i++) {
      gainedTop += ` L ${bins[i].x} ${clampY(bins[i].maxGained)}`;
    }
    for (let i = bins.length - 1; i >= 0; i--) {
      gainedBottom += ` L ${bins[i].x} ${clampY(bins[i].minGained)}`;
    }
    const gained = `${gainedTop} ${gainedBottom} Z`;

    return { rawPath: raw, gainedPath: gained };
  }, [bins]);

  // Peak localization coordinates
  const peakX =
    samplePeakFrame !== null && totalFrames > 0
      ? (samplePeakFrame / totalFrames) * SVG_WIDTH
      : null;

  const estPeakX =
    estimatedPeakPosition !== null && totalFrames > 0
      ? ((estimatedPeakPosition.frame + estimatedPeakPosition.quarter * 0.25) / totalFrames) *
        SVG_WIDTH
      : null;

  const peakSec = samplePeakFrame !== null ? samplePeakFrame / 48000 : null;

  return (
    <div className="wave-compare-container" role="region" aria-label="波形对比与峰值定位">
      <style>{`
        .wave-compare-container {
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
        .wave-header-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          font-size: 13px;
        }
        .wave-legend {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
          font-size: 12px;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .legend-swatch {
          width: 14px;
          height: 10px;
          border-radius: 2px;
          border: 1px solid currentColor;
        }
        .wave-chart-wrapper {
          position: relative;
          background-color: #0b0d11;
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 6px;
          overflow: hidden;
        }
        .wave-svg {
          display: block;
          width: 100%;
          height: auto;
          aspect-ratio: 1000 / 260;
        }
        .wave-locator-card {
          background-color: var(--bg-surface, #181b22);
          border: 1px solid var(--border-color, #2f3644);
          border-radius: 6px;
          padding: 10px 14px;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 10px 16px;
          font-size: 12px;
        }
        .locator-col {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .locator-label {
          color: var(--text-dim, #64748b);
          font-size: 11px;
        }
        .locator-val {
          font-family: var(--font-mono, monospace);
          font-weight: 600;
          color: var(--text-main, #f8fafc);
        }
        .locator-val-highlight {
          color: #f87171;
        }
        .locator-val-teal {
          color: #2dd4bf;
        }
        .locator-val-amber {
          color: #fbbf24;
        }
      `}</style>

      {/* Header & Legend */}
      <div className="wave-header-row">
        <div>
          <strong>原始波形与推荐增益波形叠放</strong>
          <span style={{ marginLeft: '8px', color: 'var(--text-muted, #94a3b8)' }}>
            时长 {durationSec.toFixed(1)}s ({totalFrames.toLocaleString()} 帧 @ 48kHz)
          </span>
        </div>
        <div className="wave-legend" role="group" aria-label="波形图例">
          <div className="legend-item" style={{ color: '#38bdf8' }}>
            <span
              className="legend-swatch"
              style={{ backgroundColor: 'rgba(56, 189, 248, 0.4)', borderColor: '#38bdf8' }}
            />
            <span>原始波形 (0.0 dB)</span>
          </div>
          <div className="legend-item" style={{ color: '#2dd4bf' }}>
            <span
              className="legend-swatch"
              style={{
                backgroundColor: 'rgba(45, 212, 191, 0.35)',
                borderColor: '#2dd4bf',
                borderStyle: 'dashed',
              }}
            />
            <span>
              {hasGBest
                ? `增益后波形 (gBest: ${gBestDb >= 0 ? '+' : ''}${gBestDb.toFixed(1)} dB)`
                : '增益后波形 (无可行增益)'}
            </span>
          </div>
          <div className="legend-item" style={{ color: '#f87171' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#f87171',
                display: 'inline-block',
              }}
            />
            <span>采样峰值帧定位</span>
          </div>
        </div>
      </div>

      {/* SVG Waveform Canvas */}
      <div className="wave-chart-wrapper">
        <svg
          className="wave-svg"
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          role="img"
          aria-label="前/后增益波形叠放图，包含时间轴与峰值帧定位标记"
        >
          {/* Background Grid Lines */}
          <g stroke="#1a202c" strokeWidth="1">
            {/* Center Zero Axis */}
            <line x1="0" y1={Y_CENTER} x2={SVG_WIDTH} y2={Y_CENTER} stroke="#334155" />
            {/* +1.0 and -1.0 amplitude rails */}
            <line
              x1="0"
              y1={Y_CENTER - Y_SCALE}
              x2={SVG_WIDTH}
              y2={Y_CENTER - Y_SCALE}
              stroke="#263143"
              strokeDasharray="4 4"
            />
            <line
              x1="0"
              y1={Y_CENTER + Y_SCALE}
              x2={SVG_WIDTH}
              y2={Y_CENTER + Y_SCALE}
              stroke="#263143"
              strokeDasharray="4 4"
            />
            {/* Time grid verticals at 2s intervals */}
            <line x1="250" y1="0" x2="250" y2={SVG_HEIGHT} stroke="#1e2533" />
            <line x1="500" y1="0" x2="500" y2={SVG_HEIGHT} stroke="#1e2533" />
            <line x1="750" y1="0" x2="750" y2={SVG_HEIGHT} stroke="#1e2533" />
          </g>

          {/* Rail Labels */}
          <g fill="#475569" fontSize="9" fontFamily="monospace">
            <text x="6" y={Y_CENTER - Y_SCALE - 3}>
              +1.0 FS
            </text>
            <text x="6" y={Y_CENTER - 3}>
              0.0
            </text>
            <text x="6" y={Y_CENTER + Y_SCALE + 11}>
              -1.0 FS
            </text>
            <text x="245" y={SVG_HEIGHT - 6} textAnchor="end">
              {(0.25 * durationSec).toFixed(1)}s
            </text>
            <text x="495" y={SVG_HEIGHT - 6} textAnchor="end">
              {(0.5 * durationSec).toFixed(1)}s
            </text>
            <text x="745" y={SVG_HEIGHT - 6} textAnchor="end">
              {(0.75 * durationSec).toFixed(1)}s
            </text>
            <text x={SVG_WIDTH - 6} y={SVG_HEIGHT - 6} textAnchor="end">
              {durationSec.toFixed(1)}s
            </text>
          </g>

          {/* Waveforms */}
          {bins ? (
            <>
              {/* Raw waveform envelope */}
              <path
                d={rawPath}
                fill="rgba(56, 189, 248, 0.28)"
                stroke="#38bdf8"
                strokeWidth="1.2"
                data-testid="waveform-raw-path"
              />

              {/* Post-gain waveform envelope (overlaid) */}
              {hasGBest && (
                <path
                  d={gainedPath}
                  fill="rgba(45, 212, 191, 0.22)"
                  stroke="#2dd4bf"
                  strokeWidth="1.2"
                  strokeDasharray="3 1"
                  data-testid="waveform-gained-path"
                />
              )}
            </>
          ) : (
            <text
              x={SVG_WIDTH / 2}
              y={Y_CENTER}
              textAnchor="middle"
              fill="#64748b"
              fontSize="13"
              data-testid="waveform-loading-text"
            >
              波形采样数据加载中...
            </text>
          )}

          {/* Peak Frame Localization Marker (Vertical Line & Pin) */}
          {peakX !== null && (
            <g id="peak-frame-marker" aria-label="采样峰值帧标记">
              {/* Highlight vertical locator line */}
              <line
                x1={peakX}
                y1="12"
                x2={peakX}
                y2={SVG_HEIGHT - 16}
                stroke="#f87171"
                strokeWidth="2"
                strokeDasharray="4 2"
              />

              {/* Peak indicator dot */}
              <circle
                cx={peakX}
                cy={clampY(samplePeakDbFs !== null ? Math.pow(10, samplePeakDbFs / 20) : 0.8)}
                r="5"
                fill="#f87171"
                stroke="#ffffff"
                strokeWidth="1.5"
              />

              {/* Numeric Callout Box pinned at the peak */}
              <g
                transform={`translate(${peakX > SVG_WIDTH - 220 ? peakX - 210 : peakX + 10}, 24)`}
              >
                <rect
                  x="0"
                  y="0"
                  width="200"
                  height="46"
                  rx="4"
                  fill="#181b22"
                  stroke="#f87171"
                  strokeWidth="1.2"
                  opacity="0.95"
                />
                <text x="8" y="16" fill="#f87171" fontSize="10.5" fontWeight="bold">
                  ★ 采样峰值帧: 帧 {samplePeakFrame?.toLocaleString()}
                </text>
                <text x="8" y="30" fill="#f8fafc" fontSize="10" fontFamily="monospace">
                  电平: {samplePeakDbFs?.toFixed(2)} dBFS ({peakSec?.toFixed(3)}s)
                </text>
                <text x="8" y="41" fill="#94a3b8" fontSize="9.5">
                  {report.source.kind === 'preset' && report.source.presetId === 'GF-A'
                    ? 'GF-A 192000 孤立脉冲明确可见'
                    : report.source.kind === 'externalWav'
                      ? (report.source.fileName ?? '外部音频波形')
                      : `预设 ${report.source.presetId} 波形`}
                </text>
              </g>
            </g>
          )}

          {/* 4x Estimated True Peak Position Marker */}
          {estPeakX !== null && estimatedPeakPosition && (
            <g
              id="estimated-peak-marker"
              aria-label="4x sinc 估算真峰标记"
              transform={`translate(${estPeakX}, ${clampY(
                estimatedTruePeakDbTp !== null ? Math.pow(10, estimatedTruePeakDbTp / 20) : 0.8,
              )})`}
            >
              <circle r="3.5" fill="#fbbf24" stroke="#ffffff" strokeWidth="1" />
            </g>
          )}
        </svg>
      </div>

      {/* Numeric Locator Panel */}
      <div className="wave-locator-card" aria-label="峰值帧与增益数值定位">
        <div className="locator-col">
          <span className="locator-label">原始采样峰值帧 (Sample Peak Frame)</span>
          <span className="locator-val locator-val-highlight">
            {samplePeakFrame !== null
              ? `帧 ${samplePeakFrame.toLocaleString()} (${peakSec?.toFixed(3)}s)`
              : 'N/A'}
          </span>
        </div>

        <div className="locator-col">
          <span className="locator-label">采样峰值电平 (Sample Peak Level)</span>
          <span className="locator-val">
            {samplePeakDbFs !== null ? `${samplePeakDbFs.toFixed(2)} dBFS` : 'N/A'}
          </span>
        </div>

        <div className="locator-col">
          <span className="locator-label">4× sinc 真实峰值估计 (Estimated TP)</span>
          <span className="locator-val locator-val-amber">
            {estimatedTruePeakDbTp !== null ? `${estimatedTruePeakDbTp.toFixed(2)} dBTP` : 'N/A'}
          </span>
        </div>

        <div className="locator-col">
          <span className="locator-label">插值微步坐标 (Sub-sample Quarter)</span>
          <span className="locator-val">
            {estimatedPeakPosition
              ? `帧 ${estimatedPeakPosition.frame} + ${estimatedPeakPosition.quarter}/4`
              : 'N/A'}
          </span>
        </div>

        <div className="locator-col">
          <span className="locator-label">推荐增益换算 (gBest Multiplier)</span>
          <span className="locator-val locator-val-teal">
            {hasGBest
              ? `${gBestDb >= 0 ? '+' : ''}${gBestDb.toFixed(1)} dB (×${gainMultiplier.toFixed(4)})`
              : '无安全增益'}
          </span>
        </div>

        <div className="locator-col">
          <span className="locator-label">增益后预估采样峰 (Post-gain Peak)</span>
          <span className="locator-val">
            {samplePeakDbFs !== null && hasGBest
              ? `${(samplePeakDbFs + gBestDb).toFixed(2)} dBFS`
              : 'N/A'}
          </span>
        </div>
      </div>
    </div>
  );
};
