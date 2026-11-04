import React from 'react';
import type { PresetId } from '../core/types.js';
import { PRESET_IDS } from '../core/types.js';
import { PRESET_DEFINITIONS } from '../core/presets.js';
import {
  TARGET_LUFS_MIN,
  TARGET_LUFS_MAX,
  PEAK_CEILING_MIN,
  PEAK_CEILING_MAX,
} from '../core/validate.js';

export interface ControlPanelProps {
  presetId: PresetId;
  onPresetChange: (id: PresetId) => void;
  targetLufs: number;
  onTargetChange: (val: number) => void;
  peakCeilingDbTp: number;
  onPeakCeilingChange: (val: number) => void;
  disabled?: boolean;
  onResetDefaults: () => void;
  validationError?: string | null;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  presetId,
  onPresetChange,
  targetLufs,
  onTargetChange,
  peakCeilingDbTp,
  onPeakCeilingChange,
  disabled = false,
  onResetDefaults,
  validationError,
}) => {
  const handlePresetSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onPresetChange(e.target.value as PresetId);
  };

  const handleTargetInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onTargetChange(val);
  };

  const handlePeakCeilingInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onPeakCeilingChange(val);
  };

  return (
    <section className="control-panel" aria-labelledby="control-panel-heading">
      <h2 id="control-panel-heading" className="panel-heading">
        参数控制面板 (Control Panel)
      </h2>

      {/* Preset Selector */}
      <div className="control-group">
        <label htmlFor="preset-select" className="control-label">
          音频预设选择 (Deterministic Preset):
        </label>
        <select
          id="preset-select"
          className="native-select"
          value={presetId}
          onChange={handlePresetSelect}
          disabled={disabled}
        >
          {PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {id}: {PRESET_DEFINITIONS[id].name} ({PRESET_DEFINITIONS[id].channels === 1 ? '单声道' : '立体声'})
            </option>
          ))}
        </select>

        {/* Quick pill buttons for presets */}
        <div className="preset-pill-group" role="group" aria-label="快捷预设选择按钮">
          {PRESET_IDS.map((id) => {
            const isSelected = presetId === id;
            return (
              <button
                key={id}
                type="button"
                className={`preset-pill ${isSelected ? 'active' : ''}`}
                onClick={() => onPresetChange(id)}
                disabled={disabled}
                aria-pressed={isSelected}
                title={PRESET_DEFINITIONS[id].description}
              >
                {id}
              </button>
            );
          })}
        </div>
        <p className="preset-description">
          <strong>{PRESET_DEFINITIONS[presetId].name}：</strong>
          {PRESET_DEFINITIONS[presetId].description}
        </p>
      </div>

      {/* Target LUFS Control */}
      <div className="control-group">
        <div className="label-row">
          <label htmlFor="target-lufs-input" className="control-label">
            目标集成响度 T (Target LUFS):
          </label>
          <span className="value-badge">{targetLufs.toFixed(1)} LUFS</span>
        </div>
        <div className="input-slider-row">
          <input
            id="target-lufs-input"
            type="number"
            className="native-number-input"
            min={TARGET_LUFS_MIN}
            max={TARGET_LUFS_MAX}
            step="0.5"
            value={Number.isNaN(targetLufs) ? '' : targetLufs}
            onChange={handleTargetInputChange}
            disabled={disabled}
            aria-describedby="target-lufs-hint"
          />
          <input
            id="target-lufs-slider"
            type="range"
            className="native-range-slider"
            min={TARGET_LUFS_MIN}
            max={TARGET_LUFS_MAX}
            step="0.5"
            value={Number.isNaN(targetLufs) ? -16.0 : targetLufs}
            onChange={handleTargetInputChange}
            disabled={disabled}
            aria-label="目标响度 T 滑块控制"
          />
        </div>
        <p id="target-lufs-hint" className="control-hint">
          允许范围：[{TARGET_LUFS_MIN.toFixed(1)}, {TARGET_LUFS_MAX.toFixed(1)}] LUFS，步进 0.5 LU（默认 -16.0）
        </p>
      </div>

      {/* Peak Ceiling Control */}
      <div className="control-group">
        <div className="label-row">
          <label htmlFor="peak-ceiling-input" className="control-label">
            峰值上限 C (Peak Ceiling dBTP):
          </label>
          <span className="value-badge">{peakCeilingDbTp.toFixed(1)} dBTP</span>
        </div>
        <div className="input-slider-row">
          <input
            id="peak-ceiling-input"
            type="number"
            className="native-number-input"
            min={PEAK_CEILING_MIN}
            max={PEAK_CEILING_MAX}
            step="0.5"
            value={Number.isNaN(peakCeilingDbTp) ? '' : peakCeilingDbTp}
            onChange={handlePeakCeilingInputChange}
            disabled={disabled}
            aria-describedby="peak-ceiling-hint"
          />
          <input
            id="peak-ceiling-slider"
            type="range"
            className="native-range-slider"
            min={PEAK_CEILING_MIN}
            max={PEAK_CEILING_MAX}
            step="0.5"
            value={Number.isNaN(peakCeilingDbTp) ? -1.0 : peakCeilingDbTp}
            onChange={handlePeakCeilingInputChange}
            disabled={disabled}
            aria-label="峰值上限 C 滑块控制"
          />
        </div>
        <p id="peak-ceiling-hint" className="control-hint">
          允许范围：[{PEAK_CEILING_MIN.toFixed(1)}, {PEAK_CEILING_MAX.toFixed(1)}] dBTP，步进 0.5 dB（默认 -1.0）
        </p>
      </div>

      {/* Fixed Constraints Notes */}
      <div className="fixed-constraints-info">
        <span className="fixed-item">容差 (Tolerance): ±0.25 LU</span>
        <span className="fixed-item">峰值安全裕量 (Margin): 0.30 dB</span>
      </div>

      {/* Validation Error Feedback */}
      {validationError && (
        <div className="validation-error-box" role="alert" aria-live="assertive">
          <strong>参数校验未通过：</strong>
          <span>{validationError}</span>
        </div>
      )}

      {/* Reset Button */}
      <div className="action-row">
        <button
          type="button"
          id="reset-button"
          className="btn btn-secondary"
          onClick={onResetDefaults}
          disabled={disabled}
        >
          重置默认约束 (T=-16.0, C=-1.0)
        </button>
      </div>
    </section>
  );
};
