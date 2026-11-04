import React from 'react';
import type { PresetId, Status } from '../core/types.js';
import type { WorkerProgressPayload } from '../worker/protocol.js';

export interface StatusBannerProps {
  status: 'IDLE' | 'ANALYZING' | 'SUCCESS' | 'ERROR';
  activePreset: PresetId;
  progress: WorkerProgressPayload | null;
  errorMessage: string | null;
  solverStatus?: Status | null;
}

const PHASE_NAMES_ZH: Record<string, string> = {
  INITIALIZING: '正在初始化计算资源...',
  DECODING_WAV: '正在解码 PCM 16-bit WAV 音频...',
  GENERATING_PRESET: '正在生成确定性合成预设信号...',
  FILTERING_K: '正在计算 K 加权双 Biquad 滤波器...',
  COMPUTING_GATES: '正在执行 400ms 重叠块双门限积分...',
  ESTIMATING_TRUE_PEAK: '正在执行 4× windowed sinc 插值估计真实峰值 (True-Peak)...',
  SOLVING_GRID: '正在执行 481 格 (-24dB~+24dB) 恒定增益约束枚举求解...',
  COMPLETE: '分析完成',
};

const STATUS_MAP_ZH: Record<
  Status,
  { label: string; description: string; badgeClass: string }
> = {
  GAIN_FEASIBLE: {
    label: '可行增益 (GAIN_FEASIBLE)',
    description: '在峰值上限约束与网格范围内，已成功求得满足目标响度的最优增益。',
    badgeClass: 'badge-status-success',
  },
  GAIN_BLOCKED_PEAK_OR_RANGE: {
    label: '峰值或范围受阻 (GAIN_BLOCKED_PEAK_OR_RANGE)',
    description: '未能满足目标响度：目标增益导致真实峰值超出上限，或超出 -24dB~+24dB 搜索网格。',
    badgeClass: 'badge-status-danger',
  },
  NO_PROGRAM: {
    label: '无节目内容 (NO_PROGRAM)',
    description: '所有 400ms 块均未超过绝对门限 (-70 LUFS)，无法计算有效集成响度。',
    badgeClass: 'badge-status-warning',
  },
  NO_SAFE_GAIN_IN_GRID: {
    label: '无安全增益 (NO_SAFE_GAIN_IN_GRID)',
    description: '在整个 -24dB 至 +24dB 网格中，所有格点的真实峰值均超出上限。',
    badgeClass: 'badge-status-danger',
  },
  UNSUPPORTED_WAV: {
    label: '不支持的 WAV 格式 (UNSUPPORTED_WAV)',
    description: '音频文件必须为 48000 Hz、16-bit PCM 编码格式。',
    badgeClass: 'badge-status-danger',
  },
  OUT_OF_SCOPE: {
    label: '超出版权或规格范围 (OUT_OF_SCOPE)',
    description: '输入音频时长或格式超出当前版本处理范围。',
    badgeClass: 'badge-status-warning',
  },
};

export const StatusBanner: React.FC<StatusBannerProps> = ({
  status,
  activePreset,
  progress,
  errorMessage,
  solverStatus,
}) => {
  const phaseText = progress?.phase
    ? PHASE_NAMES_ZH[progress.phase] || progress.phase
    : '正在分析...';

  const solverMeta = solverStatus ? STATUS_MAP_ZH[solverStatus] : null;

  return (
    <header className="status-header" role="banner">
      <div className="header-top">
        <div className="brand-group">
          <h1 className="app-title">GainFront / 声限图</h1>
          <span className="app-subtitle">
            EBU R128 / ITU-R BS.1770 恒定增益可行性求解器 (MVP)
          </span>
        </div>

        <div className="system-badges" aria-label="系统运行状态标识">
          <span className="system-badge badge-offline" title="纯客户端执行，不访问任何外部网络">
            ● 离线运行 (Offline)
          </span>
          <span className="system-badge badge-float64" title="核心算法采用 Float64 原生双精度真值">
            Float64 分析 / WAV 未修改
          </span>
          <span className="system-badge badge-preset" title={`当前载入确定性预设 ${activePreset}`}>
            确定性预设: {activePreset}
          </span>
        </div>
      </div>

      {/* Live status banner */}
      <div
        className={`status-banner-card status-${status.toLowerCase()}`}
        aria-live="polite"
        aria-atomic="true"
      >
        {status === 'ANALYZING' && (
          <div className="status-analyzing-content">
            <div className="status-headline">
              <span className="spinner-indicator" aria-hidden="true">⏳</span>
              <span className="status-text font-bold">专用计算 Worker 分析中...</span>
              {progress?.percent !== undefined && (
                <span className="progress-percent">[{progress.percent}%]</span>
              )}
            </div>
            <div className="progress-detail">
              <span className="phase-text">{phaseText}</span>
              {progress?.message && <span className="custom-msg">（{progress.message}）</span>}
            </div>
            {progress?.percent !== undefined && (
              <progress
                className="native-progress-bar"
                value={progress.percent}
                max={100}
                aria-label="Worker 分析计算进度"
              />
            )}
          </div>
        )}

        {status === 'SUCCESS' && solverMeta && (
          <div className="status-success-content">
            <div className="status-headline">
              <span className={`status-badge ${solverMeta.badgeClass}`}>
                {solverMeta.label}
              </span>
              <span className="status-text">{solverMeta.description}</span>
            </div>
          </div>
        )}

        {status === 'ERROR' && (
          <div className="status-error-content" role="alert">
            <div className="status-headline">
              <span className="status-badge badge-status-danger">计算失败 (WORKER_ERROR)</span>
              <span className="status-error-text">
                {errorMessage || '分析计算出现未知异常'}
              </span>
            </div>
          </div>
        )}

        {status === 'IDLE' && (
          <div className="status-idle-content">
            <span className="status-text">系统待机中，准备接收分析指令。</span>
          </div>
        )}
      </div>

      <div className="disclaimer-bar">
        <small className="disclaimer-text">
          免责声明：本项目算法采用 BS.1770 / EBU R128 4×固定 windowed sinc 插值近似估计，供声学调音辅助参考，不作为官方合规认证。
        </small>
      </div>
    </header>
  );
};
