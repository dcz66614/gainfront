import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { PresetId, AnalysisReport, Constraints, PCM } from '../core/types.js';
import { makePreset } from '../core/presets.js';
import {
  TARGET_LUFS_MIN,
  TARGET_LUFS_MAX,
  PEAK_CEILING_MIN,
  PEAK_CEILING_MAX,
  FIXED_TOLERANCE_LU,
  FIXED_MARGIN_DB,
} from '../core/validate.js';
import type { WorkerProgressPayload, WorkerResponse } from '../worker/protocol.js';
import { ControlPanel } from './ControlPanel.js';
import { StatusBanner } from './StatusBanner.js';
import { WaveCompare } from './WaveCompare.js';
import { GateStrip } from './GateStrip.js';
import { GainFrontier } from './GainFrontier.js';
import { EvidencePanel } from './EvidencePanel.js';
import { ImportExport } from './ImportExport.js';

export type CurrentAudioSource =
  | {
      kind: 'preset';
      presetId: PresetId;
    }
  | {
      kind: 'externalWav';
      pcm: PCM;
      sha256Hex: string;
      fileName?: string;
      byteLength?: number;
    };

export const App: React.FC = () => {
  const [presetId, setPresetId] = useState<PresetId>('GF-A');
  const [currentSource, setCurrentSource] = useState<CurrentAudioSource>({
    kind: 'preset',
    presetId: 'GF-A',
  });
  const [presetPcm, setPresetPcm] = useState<PCM | null>(() => makePreset('GF-A'));
  const [targetLufs, setTargetLufs] = useState<number>(-16.0);
  const [peakCeilingDbTp, setPeakCeilingDbTp] = useState<number>(-1.0);
  const [workerStatus, setWorkerStatus] = useState<'IDLE' | 'ANALYZING' | 'SUCCESS' | 'ERROR'>('ANALYZING');
  const [progress, setProgress] = useState<WorkerProgressPayload | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const currentRequestId = useRef<number>(0);
  const currentSourceRef = useRef<CurrentAudioSource>(currentSource);
  currentSourceRef.current = currentSource;

  const pendingPcmRef = useRef<PCM | null>(null);
  const pendingPcmPromiseRef = useRef<Promise<PCM> | null>(null);

  const currentPcm = currentSource.kind === 'preset' ? presetPcm : currentSource.pcm;

  // Validate T and C strictly per contract
  const validateParams = (t: number, c: number): string | null => {
    if (typeof t !== 'number' || Number.isNaN(t) || t < TARGET_LUFS_MIN || t > TARGET_LUFS_MAX) {
      return `目标响度 T (${Number.isNaN(t) ? '空值' : t}) 超出允许范围 [${TARGET_LUFS_MIN.toFixed(1)}, ${TARGET_LUFS_MAX.toFixed(1)}] LUFS`;
    }
    const tRemainder = Math.abs(Math.round(t * 10) % 5);
    if (tRemainder !== 0) {
      return `目标响度 T (${t}) 步进必须为 0.5 LU`;
    }
    if (typeof c !== 'number' || Number.isNaN(c) || c < PEAK_CEILING_MIN || c > PEAK_CEILING_MAX) {
      return `峰值上限 C (${Number.isNaN(c) ? '空值' : c}) 超出允许范围 [${PEAK_CEILING_MIN.toFixed(1)}, ${PEAK_CEILING_MAX.toFixed(1)}] dBTP`;
    }
    const cRemainder = Math.abs(Math.round(c * 10) % 5);
    if (cRemainder !== 0) {
      return `峰值上限 C (${c}) 步进必须为 0.5 dB`;
    }
    return null;
  };

  // Dispatch analysis request to Dedicated Worker
  const triggerAnalysis = useCallback(
    (source: CurrentAudioSource, t: number, c: number) => {
      const err = validateParams(t, c);
      if (err) {
        setValidationError(err);
        return;
      }
      setValidationError(null);

      if (!workerRef.current) return;

      const reqId = ++currentRequestId.current;
      setWorkerStatus('ANALYZING');
      setProgress({ phase: 'INITIALIZING', percent: 0 });
      setErrorMessage(null);

      const constraints: Constraints = {
        targetLufs: t,
        peakCeilingDbTp: c,
        toleranceLu: FIXED_TOLERANCE_LU,
        marginDb: FIXED_MARGIN_DB,
      };

      if (source.kind === 'preset') {
        workerRef.current.postMessage({
          type: 'ANALYZE',
          requestId: reqId,
          presetId: source.presetId,
          source: { kind: 'preset', presetId: source.presetId },
          constraints,
        });
      } else {
        workerRef.current.postMessage({
          type: 'ANALYZE',
          requestId: reqId,
          source: {
            kind: 'externalWav',
            pcm: source.pcm,
            sha256Hex: source.sha256Hex,
            fileName: source.fileName,
            ...(source.byteLength !== undefined ? { byteLength: source.byteLength } : {}),
          },
          constraints,
        });
      }
    },
    [],
  );

  const handleClearReport = useCallback(() => {
    const prevReqId = currentRequestId.current;
    // Increment requestId to ensure any in-flight RESULT will be discarded
    currentRequestId.current += 1;

    // Send CANCEL to dedicated worker
    if (workerRef.current && prevReqId > 0) {
      workerRef.current.postMessage({
        type: 'CANCEL',
        requestId: prevReqId,
      });
    }

    setReport(null);
    setWorkerStatus('IDLE');
    setProgress(null);
    setErrorMessage(null);
    setValidationError(null);

    // Initial state: reset to default GF-A preset per P010-FIX-R1-01 specification
    setPresetId('GF-A');
    setPresetPcm(makePreset('GF-A'));
    setCurrentSource({ kind: 'preset', presetId: 'GF-A' });
    pendingPcmRef.current = null;
    pendingPcmPromiseRef.current = null;
  }, []);

  const handleStartExternalAnalysis = useCallback(
    (
      pcm: PCM,
      meta: { sha256Hex: string; fileName?: string; byteLength?: number },
      constraints?: { targetLufs?: number; peakCeilingDbTp?: number },
    ) => {
      const nextSource: CurrentAudioSource = {
        kind: 'externalWav',
        pcm,
        sha256Hex: meta.sha256Hex,
        fileName: meta.fileName,
        ...(meta.byteLength !== undefined ? { byteLength: meta.byteLength } : {}),
      };
      setCurrentSource(nextSource);
      setPresetPcm(null);
      pendingPcmRef.current = pcm;

      const t = constraints?.targetLufs ?? targetLufs;
      const c = constraints?.peakCeilingDbTp ?? peakCeilingDbTp;
      if (constraints?.targetLufs !== undefined) {
        setTargetLufs(constraints.targetLufs);
      }
      if (constraints?.peakCeilingDbTp !== undefined) {
        setPeakCeilingDbTp(constraints.peakCeilingDbTp);
      }

      triggerAnalysis(nextSource, t, c);
    },
    [targetLufs, peakCeilingDbTp, triggerAnalysis],
  );

  // Initialize Dedicated Worker once
  useEffect(() => {
    const worker = new Worker(
      new URL('../worker/gainfront.worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      // Discard responses from stale request IDs
      if (msg.requestId !== currentRequestId.current) {
        return;
      }

      if (msg.type === 'PROGRESS') {
        setProgress(msg.payload);
      } else if (msg.type === 'RESULT') {
        setReport(msg.payload);
        setWorkerStatus('SUCCESS');
        setProgress(null);
        setErrorMessage(null);
      } else if (msg.type === 'ERROR') {
        setErrorMessage(msg.payload.message || msg.payload.code);
        setWorkerStatus('ERROR');
        setProgress(null);
      }
    };

    worker.onerror = (err) => {
      setErrorMessage(err.message || 'Worker 运行时发生不可恢复异常');
      setWorkerStatus('ERROR');
      setProgress(null);
    };

    workerRef.current = worker;

    // Initial analysis for default GF-A, T=-16, C=-1
    triggerAnalysis({ kind: 'preset', presetId: 'GF-A' }, -16.0, -1.0);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [triggerAnalysis]);

  const handlePresetChange = (newPreset: PresetId) => {
    const nextSource: CurrentAudioSource = { kind: 'preset', presetId: newPreset };
    setPresetId(newPreset);
    setCurrentSource(nextSource);
    const pcm = makePreset(newPreset);
    setPresetPcm(pcm);
    pendingPcmRef.current = null;
    pendingPcmPromiseRef.current = null;
    triggerAnalysis(nextSource, targetLufs, peakCeilingDbTp);
  };

  const handleTargetChange = (newTarget: number) => {
    setTargetLufs(newTarget);
    triggerAnalysis(currentSourceRef.current, newTarget, peakCeilingDbTp);
  };

  const handlePeakCeilingChange = (newCeiling: number) => {
    setPeakCeilingDbTp(newCeiling);
    triggerAnalysis(currentSourceRef.current, targetLufs, newCeiling);
  };

  const handleResetDefaults = () => {
    const defaultT = -16.0;
    const defaultC = -1.0;
    setTargetLufs(defaultT);
    setPeakCeilingDbTp(defaultC);
    setValidationError(null);
    triggerAnalysis(currentSourceRef.current, defaultT, defaultC);
  };

  return (
    <div className="app-container" data-testid="app-root">
      {/* Top Banner and System Status */}
      <StatusBanner
        status={workerStatus}
        activePreset={presetId}
        progress={progress}
        errorMessage={errorMessage}
        solverStatus={report?.solver?.status ?? null}
      />

      <div className="main-layout">
        {/* Left / Sidebar Control Panel */}
        <aside className="sidebar-area" aria-label="参数控制侧边栏" data-testid="sidebar-area">
          <ControlPanel
            presetId={presetId}
            onPresetChange={handlePresetChange}
            targetLufs={targetLufs}
            onTargetChange={handleTargetChange}
            peakCeilingDbTp={peakCeilingDbTp}
            onPeakCeilingChange={handlePeakCeilingChange}
            disabled={false}
            onResetDefaults={handleResetDefaults}
            validationError={validationError}
          />
        </aside>

        {/* Center & Right Chart Slot Area */}
        <main className="content-area" aria-label="声学分析结果与图表插槽区" data-testid="content-area">
          <div className="slots-grid">
            {/* Slot 1: WaveCompare (T012 接入) */}
            <section
              id="slot-wave-compare"
              className="slot-card"
              aria-labelledby="heading-wave-compare"
              data-testid="slot-wave-compare"
            >
              <div className="slot-header">
                <h3 id="heading-wave-compare" className="slot-title">
                  波形对比插槽 (WaveCompare)
                </h3>
                <span className="slot-badge">前后增益叠放 · 峰值定位</span>
              </div>
              <div className="slot-body">
                <WaveCompare report={report} pcm={currentPcm} />
                {report ? (
                  <dl className="metrics-list" style={{ marginTop: '12px' }}>
                    <div className="metric-row">
                      <dt>原始采样峰值 (Sample Peak):</dt>
                      <dd>
                        {report.measurement.samplePeakDbFs !== null
                          ? `${report.measurement.samplePeakDbFs.toFixed(2)} dBFS`
                          : 'N/A'}
                      </dd>
                    </div>
                    <div className="metric-row">
                      <dt>峰值所在帧 (Sample Peak Frame):</dt>
                      <dd>
                        {report.measurement.samplePeakFrame !== null
                          ? `帧 ${report.measurement.samplePeakFrame}`
                          : 'N/A'}
                      </dd>
                    </div>
                    <div className="metric-row">
                      <dt>4× 插值真实峰值 (Estimated True Peak):</dt>
                      <dd className="highlight-metric">
                        {report.measurement.estimatedTruePeakDbTp !== null
                          ? `${report.measurement.estimatedTruePeakDbTp.toFixed(2)} dBTP`
                          : 'N/A'}
                      </dd>
                    </div>
                    <div className="metric-row">
                      <dt>插值微坐标 (Sub-sample Coordinate):</dt>
                      <dd>
                        {report.measurement.estimatedPeakPosition
                          ? `帧 ${report.measurement.estimatedPeakPosition.frame}，1/4点: ${report.measurement.estimatedPeakPosition.quarter}，声道: ${report.measurement.estimatedPeakPosition.channel}`
                          : 'N/A'}
                      </dd>
                    </div>
                    <div className="metric-row">
                      <dt>音频时长与规格 (Provenance):</dt>
                      <dd>
                        {report.provenance
                          ? `${report.provenance.durationSeconds.toFixed(1)} 秒 (${report.waveformSummary?.channels ?? 1} 声道, ${report.provenance.frames} 采样点)`
                          : '8.0 秒 (48000 Hz)'}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <div className="slot-placeholder">
                    <span>正在等待 Worker 分析数据...（发布版严格禁止临时假数据）</span>
                  </div>
                )}
              </div>
            </section>

            {/* Slot 2: GateStrip (T012 接入) */}
            <section
              id="slot-gate-strip"
              className="slot-card"
              aria-labelledby="heading-gate-strip"
              data-testid="slot-gate-strip"
            >
              <div className="slot-header">
                <h3 id="heading-gate-strip" className="slot-title">
                  400ms 门限块插槽 (GateStrip)
                </h3>
                <span className="slot-badge">BS.1770 双门限状态</span>
              </div>
              <div className="slot-body">
                <GateStrip report={report} />
                {report ? (
                  <dl className="metrics-list" style={{ marginTop: '12px' }}>
                    <div className="metric-row">
                      <dt>400ms 重叠能量块总数 (Total Blocks):</dt>
                      <dd>{report.measurement.blockPowers.length} 块 (0.1s 步进)</dd>
                    </div>
                    <div className="metric-row">
                      <dt>绝对门限通过数 (&gt; -70 LUFS):</dt>
                      <dd>
                        {report.measurement.absoluteGate.filter(Boolean).length} /{' '}
                        {report.measurement.blockPowers.length} 块
                      </dd>
                    </div>
                    <div className="metric-row">
                      <dt>相对门限通过数 (&gt; L_A - 10 dB):</dt>
                      <dd>
                        {report.measurement.relativeGate.filter(Boolean).length} /{' '}
                        {report.measurement.blockPowers.length} 块
                      </dd>
                    </div>
                    <div className="metric-row">
                      <dt>原始集成响度 (Integrated Loudness):</dt>
                      <dd className="highlight-metric">
                        {report.measurement.integratedLufs !== null
                          ? `${report.measurement.integratedLufs.toFixed(2)} LUFS`
                          : '无节目内容 (低于绝对门限)'}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <div className="slot-placeholder">
                    <span>正在等待 Worker 分析数据...（发布版严格禁止临时假数据）</span>
                  </div>
                )}
              </div>
            </section>

            {/* Slot 3: GainFrontier (T013 接入) */}
            <section
              id="slot-gain-frontier"
              className="slot-card"
              aria-labelledby="heading-gain-frontier"
              data-testid="slot-gain-frontier"
            >
              <div className="slot-header">
                <h3 id="heading-gain-frontier" className="slot-title">
                  增益前沿与双游标插槽 (GainFrontier)
                </h3>
                <span className="slot-badge">481 点求解结论</span>
              </div>
              <div className="slot-body">
                <GainFrontier report={report} />
              </div>
            </section>

            {/* Slot 4: EvidencePanel (T014 接入) */}
            <section
              id="slot-evidence-panel"
              className="slot-card"
              aria-labelledby="heading-evidence-panel"
              data-testid="slot-evidence-panel"
            >
              <div className="slot-header">
                <h3 id="heading-evidence-panel" className="slot-title">
                  计算见证与约束插槽 (EvidencePanel)
                </h3>
                <span className="slot-badge">可解释见证 · 真实数值</span>
              </div>
              <div className="slot-body">
                <EvidencePanel report={report} />
              </div>
            </section>
          </div>

          {/* Slot 5: ImportExport (T014 接入) */}
          <section
            id="slot-import-export"
            className="slot-card"
            aria-labelledby="heading-import-export"
            data-testid="slot-import-export"
            onChangeCapture={(e) => {
              const target = e.target as HTMLInputElement;
              if (!target) return;
              if (target.getAttribute('data-testid') === 'input-json-file') {
                // Clear old report when selecting a new session file per contract
                handleClearReport();
              }
            }}
          >
            <div className="slot-header">
              <h3 id="heading-import-export" className="slot-title">
                会话导入导出与重绑 (ImportExport)
              </h3>
              <span className="slot-badge">gainfront.session/1 · 本地 SHA-256</span>
            </div>
            <div className="slot-body">
              <ImportExport
                report={report}
                onApplyReport={(newReport: AnalysisReport, extraPcm?: PCM | null) => {
                  setReport(newReport);
                  setTargetLufs(newReport.constraints.targetLufs);
                  setPeakCeilingDbTp(newReport.constraints.peakCeilingDbTp);
                  if (newReport.source.kind === 'preset') {
                    const pid = newReport.source.presetId;
                    setPresetId(pid);
                    const pcm = makePreset(pid);
                    setPresetPcm(pcm);
                    setCurrentSource({ kind: 'preset', presetId: pid });
                    pendingPcmRef.current = null;
                    pendingPcmPromiseRef.current = null;
                  } else {
                    const src = newReport.source;
                    const applyExternal = (pcm: PCM) => {
                      const nextSource: CurrentAudioSource = {
                        kind: 'externalWav',
                        pcm,
                        sha256Hex: src.sha256Hex,
                        fileName: src.fileName,
                        // FIX-R2-01 (independent-review follow-up): keep
                        // byteLength, or the next analysis loses it and
                        // the following export falls back to the guess.
                        ...(src.kind === 'externalWav' && src.byteLength !== undefined
                          ? { byteLength: src.byteLength }
                          : {}),
                      };
                      setCurrentSource(nextSource);
                      setPresetPcm(null);
                    };

                    if (extraPcm) {
                      pendingPcmRef.current = extraPcm;
                      applyExternal(extraPcm);
                    } else if (pendingPcmRef.current) {
                      applyExternal(pendingPcmRef.current);
                    } else if (pendingPcmPromiseRef.current) {
                      pendingPcmPromiseRef.current.then((pcm) => {
                        applyExternal(pcm);
                      });
                    }
                  }
                  setWorkerStatus('SUCCESS');
                  setProgress(null);
                  setErrorMessage(null);
                }}
                onClearReport={handleClearReport}
                onStartExternalAnalysis={handleStartExternalAnalysis}
              />
            </div>
          </section>
        </main>
      </div>

      {/* Footer */}
      <footer className="app-footer" role="contentinfo">
        <div className="footer-content">
          <span>P010 声限图 GainFront · 工程验证构建</span>
          <span>纯静态 Dedicated Worker 架构 · 零第三方数学黑盒</span>
        </div>
      </footer>
    </div>
  );
};
