import React, { useState, useRef } from 'react';
import type { AnalysisReport, PCM, Session } from '../core/types.js';
import {
  computeSha256Sync,
  createSessionFromAnalysis,
  exportSession,
  parseSession,
  rebindExternalWav,
  rebindSession,
  type RebindResult,
} from '../core/session.js';
import { decodePcm16Wav } from '../core/wav.js';
import { validateWavByteLength } from '../core/validate.js';
import { GainFrontError } from '../core/errors.js';

export interface ImportExportProps {
  report: AnalysisReport | null;
  onApplyReport?: (report: AnalysisReport, extraPcm?: PCM | null) => void;
  onClearReport?: () => void;
  onStartExternalAnalysis?: (
    pcm: PCM,
    meta: { sha256Hex: string; fileName?: string; byteLength?: number },
    constraints?: { targetLufs: number; peakCeilingDbTp: number },
  ) => void;
}

export interface ImportParseResult {
  session: Session;
  presetReport?: AnalysisReport;
  requiresWavRebind: boolean;
}

export const IMPORT_EXPORT_DISCLAIMER_TEXT =
  '【常驻免责声明】本工具测量指标基于 BS.1770 K 加权滤波与 4× 窗函数 sinc 插值近似估计，0.30 dB 裕量为保守安全设计，非广播认证硬件仪表，测量与建议仅供参考。';

export const IMPORT_EXPORT_PRIVACY_TEXT =
  '【纯本地离线与隐私声明】本工具为 100% 纯前端离线架构，无任何远程网络请求或数据上传。外部 WAV 音频仅在本地浏览器内存中计算与核对 SHA-256 哈希。导出的 gainfront.session/1 会话 JSON 仅包含参数与哈希指纹，绝不包含原始声音波形。';

/**
 * Pure export helper: creates and serializes session JSON using T009 exportSession.
 */
export function handleExportSession(report: AnalysisReport): string {
  if (!report) {
    throw new Error('当前无有效分析报告，无法导出会话');
  }

  const session = createSessionFromAnalysis(report, {
    view: {
      selectedGainTick: report.solver.gBestTick ?? 0,
      showBlockGates: true,
    },
    // FIX-R2-01: export the real WAV byteLength carried on the report,
    // so a later rebind of the same file matches instead of guessing.
    ...(report.source.kind === 'externalWav' && report.source.byteLength !== undefined
      ? { byteLength: report.source.byteLength }
      : {}),
  });

  return exportSession(session, { pretty: true });
}

/**
 * Pure import helper: parses session JSON and initiates deterministic rebind.
 * If external WAV, signals that rebinding is required and does NOT trust old report.
 */
export function handleImportSessionJson(jsonText: string): ImportParseResult {
  const session = parseSession(jsonText);

  if (session.source.kind === 'preset') {
    const rebindResult = rebindSession(session);
    return {
      session,
      presetReport: rebindResult.report,
      requiresWavRebind: false,
    };
  }

  if (session.source.kind === 'externalWav') {
    return {
      session,
      requiresWavRebind: true,
    };
  }

  throw new Error('未知的会话音频源类型');
}

/**
 * Pure WAV rebind helper: verifies WAV bytes and SHA-256 hash.
 */
export function handleRebindWav(
  session: Session,
  wavBytes: ArrayBuffer,
  fileName?: string,
): RebindResult {
  return rebindExternalWav(session, wavBytes, {
    fileName,
    expectedSha256Hex: session.source.kind === 'externalWav' ? session.source.sha256Hex : undefined,
  });
}

/**
 * Verifies external WAV bytes against session metadata without running full DSP on main thread.
 * Returns decoded PCM and computed SHA-256 for dispatching to Dedicated Worker.
 */
export function verifyExternalWavForRebind(
  session: Session,
  wavBytes: ArrayBuffer,
  fileName?: string,
): { pcm: PCM; sha256Hex: string; byteLength: number } {
  if (session.source.kind !== 'externalWav') {
    throw new GainFrontError(
      'INVALID_SOURCE_REF',
      `verifyExternalWavForRebind requires externalWav session, received ${session.source.kind}`,
    );
  }

  if (!(wavBytes instanceof ArrayBuffer)) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'wavBytes must be an ArrayBuffer');
  }

  validateWavByteLength(wavBytes.byteLength);

  // File name check
  if (session.source.fileName && fileName && session.source.fileName !== fileName) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `File name mismatch: session recorded "${session.source.fileName}", but provided "${fileName}". Renamed file rejected.`,
      { recorded: session.source.fileName, provided: fileName },
    );
  }

  if (
    session.inputSummary?.fileName &&
    fileName &&
    session.inputSummary.fileName !== fileName
  ) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `File name mismatch: inputSummary recorded "${session.inputSummary.fileName}", but provided "${fileName}". Renamed file rejected.`,
      { recorded: session.inputSummary.fileName, provided: fileName },
    );
  }

  const pcm = decodePcm16Wav(wavBytes);

  if (session.inputSummary) {
    if (session.inputSummary.sampleRate !== pcm.sampleRate) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Sample rate mismatch: session expected ${session.inputSummary.sampleRate} Hz, decoded ${pcm.sampleRate} Hz`,
      );
    }
    if (session.inputSummary.channels !== pcm.channels) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Channel count mismatch: session expected ${session.inputSummary.channels}, decoded ${pcm.channels}`,
      );
    }
    if (session.inputSummary.frames !== pcm.frames) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `Frame count mismatch: session expected ${session.inputSummary.frames}, decoded ${pcm.frames}`,
      );
    }
    if (session.inputSummary.byteLength !== wavBytes.byteLength) {
      throw new GainFrontError(
        'INVALID_SESSION',
        `File byteLength mismatch: session expected ${session.inputSummary.byteLength}, received ${wavBytes.byteLength}`,
      );
    }
  }

  const computedSha256 = computeSha256Sync(wavBytes).toLowerCase();
  const targetSha256 = session.source.sha256Hex.toLowerCase();

  if (computedSha256 !== targetSha256) {
    throw new GainFrontError(
      'INVALID_SESSION',
      `SHA-256 hash mismatch: expected "${targetSha256}", computed "${computedSha256}". Refusing to load modified or replaced audio file.`,
      { expected: targetSha256, computed: computedSha256 },
    );
  }

  return { pcm, sha256Hex: computedSha256, byteLength: wavBytes.byteLength };
}

/**
 * Decodes and validates WAV bytes for direct import without requiring a prior session JSON.
 */
export function validateAndDecodeDirectWav(
  wavBytes: ArrayBuffer,
  _fileName?: string,
): { pcm: PCM; sha256Hex: string; byteLength: number } {
  if (!(wavBytes instanceof ArrayBuffer)) {
    throw new GainFrontError('UNSUPPORTED_WAV', 'Expected ArrayBuffer for WAV');
  }

  validateWavByteLength(wavBytes.byteLength);
  const pcm = decodePcm16Wav(wavBytes);
  const sha256Hex = computeSha256Sync(wavBytes).toLowerCase();

  return { pcm, sha256Hex, byteLength: wavBytes.byteLength };
}

export const ImportExport: React.FC<ImportExportProps> = ({
  report,
  onApplyReport,
  onClearReport,
  onStartExternalAnalysis,
}) => {
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const [pendingExternalSession, setPendingExternalSession] = useState<Session | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);

  const jsonFileInputRef = useRef<HTMLInputElement | null>(null);
  const wavFileInputRef = useRef<HTMLInputElement | null>(null);
  const directWavInputRef = useRef<HTMLInputElement | null>(null);

  // Trigger export of current session JSON
  const onExportClick = () => {
    setExportError(null);
    setExportSuccess(null);

    if (!report) {
      setExportError('当前无有效分析报告，无法导出会话 JSON');
      return;
    }

    try {
      const jsonText = handleExportSession(report);

      // Trigger browser download
      const blob = new Blob([jsonText], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const sourceName =
        report.source.kind === 'preset'
          ? report.source.presetId
          : (report.source.fileName?.replace(/\.[^/.]+$/, '') ?? 'external');
      a.href = url;
      a.download = `gainfront-session-${sourceName}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportSuccess(`已成功导出会话 JSON (源: ${report.source.kind === 'preset' ? report.source.presetId : '外部 WAV'})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(`下载失败：${msg}`);
    }
  };

  // Trigger JSON file input click
  const onSelectJsonClick = () => {
    setImportError(null);
    setImportSuccess(null);
    jsonFileInputRef.current?.click();
  };

  // Handle JSON file selection and parsing
  const onJsonFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportError(null);
    setImportSuccess(null);
    setRebindError(null);

    try {
      const text = await file.text();
      const parsed = handleImportSessionJson(text);

      if (!parsed.requiresWavRebind && parsed.presetReport) {
        // Preset session: rebind successful immediately
        setPendingExternalSession(null);
        setImportSuccess(`成功载入预设会话 [${parsed.session.source.kind === 'preset' ? parsed.session.source.presetId : ''}]，已重新计算最新报告！`);
        onApplyReport?.(parsed.presetReport);
      } else {
        // External WAV session: MUST rebind and clear old report per contract!
        onClearReport?.();
        setPendingExternalSession(parsed.session);
        setImportSuccess(
          `已读取外部 WAV 会话配置。注意：旧分析报告已清空，必须在下方选择原音频文件完成 SHA-256 重绑后方可生成报告。`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setImportError(`导入失败：${msg}`);
      // Reset input value to allow re-selection
      event.target.value = '';
    }
  };

  // Handle WAV file selection for rebinding
  const onWavFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !pendingExternalSession) return;

    setRebindError(null);

    try {
      const wavBytes = await file.arrayBuffer();
      // Verify metadata & SHA-256 on main thread WITHOUT running analyzeSource
      const { pcm, sha256Hex, byteLength } = verifyExternalWavForRebind(
        pendingExternalSession,
        wavBytes,
        file.name,
      );

      const savedConstraints = pendingExternalSession.constraints;
      setPendingExternalSession(null);
      setImportSuccess(
        `外部 WAV 文件 [${file.name}] SHA-256 比对完全一致！已由 Dedicated Worker 执行异步完整分析。`,
      );

      if (onStartExternalAnalysis) {
        onStartExternalAnalysis(
          pcm,
          { sha256Hex, fileName: file.name, byteLength },
          savedConstraints,
        );
      } else {
        const result = handleRebindWav(pendingExternalSession, wavBytes, file.name);
        onApplyReport?.(result.report, pcm);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRebindError(`重绑核验失败：${msg}`);
      // Old report remains cleared
      onClearReport?.();
      event.target.value = '';
    }
  };

  // Handle direct WAV file selection (without session JSON)
  const onDirectWavFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // FIX-R2-02: clear the old report AT IMPORT START, before any decode
    // or worker dispatch, so the old source is never shown mixed with the
    // new one. onClearReport also increments the App request id and sends
    // CANCEL to the worker, invalidating any in-flight old request.
    // Also clear any rebind-pending box left by a prior session import,
    // so no stale pending UI survives a new direct import (review item).
    setPendingExternalSession(null);
    onClearReport?.();

    setImportError(null);
    setImportSuccess(null);
    setRebindError(null);
    setExportError(null);
    setExportSuccess(null);

    try {
      const wavBytes = await file.arrayBuffer();
      const { pcm, sha256Hex, byteLength } = validateAndDecodeDirectWav(wavBytes, file.name);

      setPendingExternalSession(null);
      setImportSuccess(
        `成功直接导入外部 WAV [${file.name}] (SHA-256: ${sha256Hex.slice(0, 16)}...)，已派发至 Dedicated Worker 完整分析！`,
      );

      onStartExternalAnalysis?.(pcm, {
        sha256Hex,
        fileName: file.name,
        byteLength,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let friendlyError = `直接导入 WAV 失败：${msg}`;
      if (msg.includes('exceeds 8MiB limit') || msg.includes('8MiB')) {
        friendlyError = `直接导入 WAV 失败：文件大小超出限制（必须 ≤ 8 MiB）`;
      } else if (msg.includes('Unsupported sample rate') || msg.includes('48000')) {
        friendlyError = `直接导入 WAV 失败：不支持的采样率（必须为 48000 Hz）`;
      } else if (msg.includes('only 16-bit PCM') || msg.includes('bits per sample')) {
        friendlyError = `直接导入 WAV 失败：不支持的量化精度（必须为 16-bit PCM）`;
      } else if (msg.includes('Audio duration') || msg.includes('out of scope')) {
        friendlyError = `直接导入 WAV 失败：音频时长超出支持范围（必须在 1.0 秒至 30.0 秒之间）`;
      } else if (
        msg.includes('Missing RIFF') ||
        msg.includes('Corrupted') ||
        msg.includes('Truncated') ||
        msg.includes('Buffer too small')
      ) {
        friendlyError = `直接导入 WAV 失败：WAV 文件损坏或不是有效的 RIFF WAVE 格式`;
      }
      setImportError(friendlyError);
      // FIX-R2-02: a failed direct import must not resurrect the old report.
      onClearReport?.();
      event.target.value = '';
    }
  };

  return (
    <div className="import-export-container" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Action Buttons Area */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onExportClick}
          disabled={!report}
          data-testid="btn-export-session"
          style={{ flex: 1, minWidth: '180px' }}
        >
          导出证据 JSON (gainfront.session/1)
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={onSelectJsonClick}
          data-testid="btn-import-session"
          style={{ flex: 1, minWidth: '180px' }}
        >
          导入会话 JSON
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setImportError(null);
            setImportSuccess(null);
            directWavInputRef.current?.click();
          }}
          data-testid="btn-import-wav"
          style={{ flex: 1, minWidth: '180px' }}
        >
          直接导入外部 WAV
        </button>

        {/* Hidden JSON file input */}
        <input
          type="file"
          ref={jsonFileInputRef}
          accept=".json,application/json"
          onChange={onJsonFileChange}
          data-testid="input-json-file"
          style={{ display: 'none' }}
        />

        {/* Hidden direct WAV file input */}
        <input
          type="file"
          ref={directWavInputRef}
          accept=".wav,audio/wav,audio/x-wav"
          onChange={onDirectWavFileChange}
          data-testid="input-direct-wav"
          style={{ display: 'none' }}
        />
      </div>

      {/* Export Feedback Messages */}
      {exportError && (
        <div className="validation-error-box" data-testid="export-error-box">
          <span>{exportError}</span>
        </div>
      )}
      {exportSuccess && (
        <div
          data-testid="export-success-box"
          style={{
            backgroundColor: 'rgba(20, 184, 166, 0.1)',
            border: '1px solid #14b8a6',
            color: '#2dd4bf',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '0.8rem',
          }}
        >
          <span>{exportSuccess}</span>
        </div>
      )}

      {/* Import Feedback Messages */}
      {importError && (
        <div className="validation-error-box" data-testid="import-error-box">
          <span>{importError}</span>
        </div>
      )}
      {importSuccess && (
        <div
          data-testid="import-success-box"
          style={{
            backgroundColor: 'rgba(56, 189, 248, 0.1)',
            border: '1px solid #38bdf8',
            color: '#38bdf8',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '0.8rem',
          }}
        >
          <span>{importSuccess}</span>
        </div>
      )}

      {/* External WAV Rebinding Area (Active when an externalWav session is loaded) */}
      {pendingExternalSession && (
        <div
          className="rebind-pending-box"
          data-testid="rebind-pending-box"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid #ef4444',
            borderRadius: '6px',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ color: '#f87171', fontWeight: 600, fontSize: '0.85rem' }}>
            必须重新绑定外部 WAV 音频文件 (Local SHA-256 Rebind Required)
          </div>
          <div style={{ fontSize: '0.78rem', color: '#cbd5e1', lineHeight: 1.4 }}>
            <div>
              <strong>预期文件名：</strong>{' '}
              {pendingExternalSession.source.kind === 'externalWav'
                ? pendingExternalSession.source.fileName ?? '未指定'
                : 'N/A'}
            </div>
            <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', marginTop: '4px' }}>
              <strong>预期 SHA-256：</strong>{' '}
              {pendingExternalSession.source.kind === 'externalWav'
                ? pendingExternalSession.source.sha256Hex
                : 'N/A'}
            </div>
            <div style={{ marginTop: '6px', color: '#fca5a5' }}>
              安全契约：未复绑前不显示旧报告。请选择匹配的原 WAV 文件进行本地校验与重算。
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="file"
              ref={wavFileInputRef}
              accept=".wav,audio/wav,audio/x-wav"
              onChange={onWavFileChange}
              data-testid="input-rebind-wav"
              style={{
                fontSize: '0.8rem',
                color: '#e2e8f0',
                backgroundColor: 'rgba(0, 0, 0, 0.25)',
                padding: '6px 8px',
                borderRadius: '4px',
                border: '1px solid #64748b',
                width: '100%',
              }}
            />
          </div>

          {rebindError && (
            <div className="validation-error-box" data-testid="rebind-error-box">
              <span>{rebindError}</span>
            </div>
          )}
        </div>
      )}

      {/* 常驻免责与隐私声明：不得折叠隐藏或随面板关闭而消失 */}
      <div
        className="import-export-disclaimers"
        data-testid="import-export-disclaimers"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          backgroundColor: 'rgba(30, 41, 59, 0.6)',
          border: '1px solid rgba(148, 163, 184, 0.2)',
          borderRadius: '4px',
          padding: '10px 12px',
          fontSize: '0.73rem',
          color: '#94a3b8',
          lineHeight: 1.45,
        }}
      >
        <div data-testid="permanent-privacy-notice" style={{ color: '#38bdf8' }}>
          {IMPORT_EXPORT_PRIVACY_TEXT}
        </div>
        <div data-testid="permanent-disclaimer-notice" style={{ color: '#fbbf24' }}>
          {IMPORT_EXPORT_DISCLAIMER_TEXT}
        </div>
      </div>
    </div>
  );
};
