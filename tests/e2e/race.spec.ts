import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test.describe('P010-T015 Fast Drag & Rapid Request Race Spec', () => {
  test('rapid preset switching: guarantees latest-request-wins and zero stale residue', async ({
    page,
  }) => {
    await page.goto('/');

    // Wait for initial analysis
    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // Rapidly click preset pills in fast succession without waiting
    const pillB = page.locator('button.preset-pill:has-text("GF-B")');
    const pillC = page.locator('button.preset-pill:has-text("GF-C")');
    const pillA = page.locator('button.preset-pill:has-text("GF-A")');
    const pillD = page.locator('button.preset-pill:has-text("GF-D")');

    await pillB.click();
    await pillC.click();
    await pillA.click();
    await pillD.click();

    // Wait for worker computation to settle into SUCCESS
    await expect(page.locator('.status-banner-card.status-success')).toBeVisible({
      timeout: 15000,
    });
    await expect(evidenceReport).toBeVisible();

    // Verify final state matches the last request (GF-D)
    const presetSelect = page.locator('#preset-select');
    await expect(presetSelect).toHaveValue('GF-D');

    // In GF-D (12kHz intersample peak), true peak is markedly higher than sample peak:
    // estimatedTruePeak (~ +1.86 dBTP) - samplePeak (~ -0.92 dBFS) >= 2.0 dB
    const samplePeakText = await page.locator('[data-testid="evidence-sample-peak"]').innerText();
    const estimatedTpText = await page.locator('[data-testid="evidence-estimated-tp"]').innerText();

    const samplePeak = parseFloat(samplePeakText);
    const estimatedTp = parseFloat(estimatedTpText);
    expect(Number.isNaN(samplePeak)).toBe(false);
    expect(Number.isNaN(estimatedTp)).toBe(false);
    expect(estimatedTp - samplePeak).toBeGreaterThanOrEqual(2.0);

    const screenshot1Path = resolve('evidence/validation-logs/T015-race-01-preset-race.png');
    await page.screenshot({ path: screenshot1Path, fullPage: true });
  });

  test('rapid target slider dragging: guarantees latest slider target wins with clean final state', async ({
    page,
  }) => {
    await page.goto('/');

    const evidenceReport = page.locator('[data-testid="evidence-report"]');
    await expect(evidenceReport).toBeVisible({ timeout: 15000 });

    // Select GF-B first for a clean baseline
    await page.locator('button.preset-pill:has-text("GF-B")').click();
    await expect(page.locator('[data-testid="evidence-status-badge"]')).toContainText(
      'GAIN_FEASIBLE',
    );

    // Simulate fast slider dragging across multiple discrete steps
    const slider = page.locator('#target-lufs-slider');
    const steps = ['-17.0', '-18.0', '-19.0', '-20.0', '-21.0', '-22.0'];

    for (const val of steps) {
      await slider.evaluate((el: HTMLInputElement, v: string) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, val);
    }

    // Wait for the final request to complete
    await expect(page.locator('.status-banner-card.status-success')).toBeVisible({
      timeout: 15000,
    });
    await expect(evidenceReport).toBeVisible();

    // Assert that the final UI reflects the last value (-22.0 LUFS)
    const targetInput = page.locator('#target-lufs-input');
    await expect(targetInput).toHaveValue('-22');

    const constraintsList = page.locator('[data-testid="witness-constraints-list"]');
    await expect(constraintsList).toContainText('目标集成响度 T: -22.0 LUFS');

    const screenshot2Path = resolve('evidence/validation-logs/T015-race-02-slider-race.png');
    await page.screenshot({ path: screenshot2Path, fullPage: true });
  });
});
