import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test.describe('P010-T016 Accessibility & Responsive Viewport Spec', () => {
  test('keyboard navigation: Tab navigation across all interactive controls with visible focus and Enter/Space trigger', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // Focus on document body to start clean
    await page.locator('body').click({ position: { x: 0, y: 0 } });

    // Press Tab to enter the interactive controls in sequence
    // 1. Preset Native Select
    await page.keyboard.press('Tab');
    const activeId1 = await page.evaluate(() => document.activeElement?.id);
    expect(activeId1).toBe('preset-select');

    // Verify focus outline visibility
    const isFocusVisible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    });
    expect(isFocusVisible).toBe(true);

    // 2. Preset Pill Buttons (GF-A to GF-F)
    const presetPillIds = ['GF-A', 'GF-B', 'GF-C', 'GF-D', 'GF-E', 'GF-F'];
    for (const id of presetPillIds) {
      await page.keyboard.press('Tab');
      const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim());
      expect(activeText).toBe(id);
    }

    // Currently focused on GF-F pill. Test Enter / Space key trigger on GF-B.
    // Shift-Tab back to GF-B pill
    for (let i = 0; i < 4; i++) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
    }
    const currentFocusedPill = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(currentFocusedPill).toBe('GF-B');

    // Trigger GF-B switch via keyboard Enter
    await page.keyboard.press('Enter');

    // Verify that GF-B is now active
    const gfbPill = page.locator('button.preset-pill:has-text("GF-B")');
    await expect(gfbPill).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="evidence-status-badge"]')).toContainText(
      'GAIN_FEASIBLE',
    );

    // Continue Tab navigation to Target LUFS input and slider
    await page.keyboard.press('Tab'); // GF-C
    await page.keyboard.press('Tab'); // GF-D
    await page.keyboard.press('Tab'); // GF-E
    await page.keyboard.press('Tab'); // GF-F
    await page.keyboard.press('Tab'); // target-lufs-input
    const targetInputId = await page.evaluate(() => document.activeElement?.id);
    expect(targetInputId).toBe('target-lufs-input');

    await page.keyboard.press('Tab'); // target-lufs-slider
    const targetSliderId = await page.evaluate(() => document.activeElement?.id);
    expect(targetSliderId).toBe('target-lufs-slider');

    // Continue Tab navigation to Peak Ceiling input and slider
    await page.keyboard.press('Tab'); // peak-ceiling-input
    const peakInputId = await page.evaluate(() => document.activeElement?.id);
    expect(peakInputId).toBe('peak-ceiling-input');

    await page.keyboard.press('Tab'); // peak-ceiling-slider
    const peakSliderId = await page.evaluate(() => document.activeElement?.id);
    expect(peakSliderId).toBe('peak-ceiling-slider');

    // Continue Tab navigation to Reset button
    await page.keyboard.press('Tab'); // reset-button
    const resetBtnId = await page.evaluate(() => document.activeElement?.id);
    expect(resetBtnId).toBe('reset-button');

    // Trigger reset button via Space key
    await page.keyboard.press('Space');

    // Continue Tab navigation into GateStrip lamps
    await page.keyboard.press('Tab');
    const isGateLampFocused = await page.evaluate(() =>
      document.activeElement?.classList.contains('gate-lamp'),
    );
    expect(isGateLampFocused).toBe(true);

    // Verify keyboard interaction with Export Session button
    const exportBtn = page.locator('[data-testid="btn-export-session"]');
    await exportBtn.focus();
    const exportFocusVisible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="btn-export-session"]') as HTMLElement;
      return el === document.activeElement;
    });
    expect(exportFocusVisible).toBe(true);

    // Tab from export button to import button
    await page.keyboard.press('Tab');
    const importBtnTestId = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'),
    );
    expect(importBtnTestId).toBe('btn-import-session');

    // Capture screenshot of keyboard focused interactive state
    await page.screenshot({
      path: resolve('evidence/screenshots/a11y-keyboard-focus.png'),
      fullPage: true,
    });
  });

  test('narrow screen 360px: layout does not clip or overflow critical conclusions', async ({
    page,
  }) => {
    // Set viewport explicitly to 360px mobile width
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // Verify key conclusions remain fully visible and legible on 360px screen
    const statusBadge = page.locator('[data-testid="evidence-status-badge"]');
    await expect(statusBadge).toBeVisible();
    await expect(statusBadge).toContainText('GAIN_BLOCKED_PEAK_OR_RANGE');

    const gBest = page.locator('[data-testid="evidence-g-best"]');
    await expect(gBest).toBeVisible();
    await expect(gBest).toHaveText('+0.6 dB');

    const deviation = page.locator('[data-testid="evidence-deviation"]');
    await expect(deviation).toBeVisible();
    await expect(deviation).toContainText('6.4005 LU');

    const peakBoundary = page.locator('[data-testid="evidence-peak-boundary"]');
    await expect(peakBoundary).toBeVisible();
    await expect(peakBoundary).toHaveText('0.60 dB');

    // Verify witness reasons and constraints list are visible
    await expect(page.locator('[data-testid="witness-reasons-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="witness-constraints-list"]')).toBeVisible();

    // Verify slots are rendered in single-column responsive order
    const slotsGrid = page.locator('.slots-grid');
    const gridColumns = await slotsGrid.evaluate((el) => {
      return window.getComputedStyle(el).gridTemplateColumns;
    });
    // On narrow screens (<= 1200px), slots-grid collapses to single column
    expect(gridColumns.split(' ').length).toBe(1);

    // Verify no breaking horizontal overflow on root container
    const isHorizontalContained = await page.evaluate(() => {
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      // Allow minor sub-pixel rendering variation (<= 2px)
      return scrollWidth <= clientWidth + 2;
    });
    expect(isHorizontalContained).toBe(true);

    // Capture screenshot on 360px narrow viewport
    await page.screenshot({
      path: resolve('evidence/screenshots/a11y-narrow-360px.png'),
      fullPage: true,
    });
  });

  test('visual charts text correspondence: all 4 charts have explicit textual/numerical counterparts', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // 1. Chart 1: WaveCompare
    const waveSlot = page.locator('[data-testid="slot-wave-compare"]');
    await expect(waveSlot).toBeVisible();
    const waveSvg = waveSlot.locator('svg.wave-svg');
    await expect(waveSvg).toBeVisible();
    await expect(waveSvg).toHaveAttribute('role', 'img');
    await expect(waveSvg).toHaveAttribute(
      'aria-label',
      '前/后增益波形叠放图，包含时间轴与峰值帧定位标记',
    );

    // Verify accompanying text metrics
    await expect(waveSlot.locator('dt:has-text("原始采样峰值")')).toBeVisible();
    await expect(waveSlot.locator('dt:has-text("4× 插值真实峰值")')).toBeVisible();
    await expect(waveSlot.locator('dt:has-text("插值微坐标")')).toBeVisible();
    await expect(waveSlot.locator('dt:has-text("音频时长与规格")')).toBeVisible();

    // 2. Chart 2: GateStrip
    const gateSlot = page.locator('[data-testid="slot-gate-strip"]');
    await expect(gateSlot).toBeVisible();
    const gateRegion = gateSlot.locator('.gate-strip-container');
    await expect(gateRegion).toHaveAttribute('role', 'region');
    await expect(gateRegion).toHaveAttribute('aria-label', '400ms 门限灯带');

    // Verify accompanying text gate metrics and badges
    await expect(gateSlot.locator('dt:has-text("400ms 重叠能量块总数")')).toBeVisible();
    await expect(gateSlot.locator('dt:has-text("绝对门限通过数")')).toBeVisible();
    const relDt = gateSlot.locator('dt:has-text("相对门限通过数")');
    await expect(relDt).toBeVisible();
    await expect(relDt).toContainText('> L_A - 10 dB');
    await expect(gateSlot.locator('dt:has-text("原始集成响度")')).toBeVisible();

    await expect(gateSlot.locator('.gate-badge-passed')).toContainText('通过:');
    await expect(gateSlot.locator('.gate-badge-rel-out')).toContainText('相对门外:');

    // 3. Chart 3: GainFrontier
    const frontierSlot = page.locator('[data-testid="slot-gain-frontier"]');
    await expect(frontierSlot).toBeVisible();
    const frontierSvgWrapper = frontierSlot.locator('.frontier-svg-wrapper');
    await expect(frontierSvgWrapper).toHaveAttribute('aria-label', '481点增益前沿图交互区');

    // Verify textual conclusion
    const frontierConclusion = frontierSlot.locator('.frontier-conclusion-panel');
    await expect(frontierConclusion).toBeVisible();
    await expect(frontierConclusion).toContainText('GAIN_BLOCKED_PEAK_OR_RANGE');
    await expect(frontierConclusion).toContainText('求解状态代码');

    // 4. Chart 4: EvidencePanel
    const evidenceSlot = page.locator('[data-testid="slot-evidence-panel"]');
    await expect(evidenceSlot).toBeVisible();
    await expect(page.locator('[data-testid="evidence-status-badge"]')).toBeVisible();
    await expect(page.locator('[data-testid="evidence-g-best"]')).toBeVisible();
    await expect(page.locator('[data-testid="evidence-g-target"]')).toBeVisible();
    await expect(page.locator('[data-testid="evidence-deviation"]')).toBeVisible();
    await expect(page.locator('[data-testid="evidence-peak-boundary"]')).toBeVisible();
    await expect(page.locator('[data-testid="witness-reasons-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="witness-constraints-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="evidence-permanent-disclaimer"]')).toBeVisible();

    // Capture screenshot showing chart textual correspondence
    await page.screenshot({
      path: resolve('evidence/screenshots/a11y-chart-text-counterparts.png'),
      fullPage: true,
    });
  });
});
