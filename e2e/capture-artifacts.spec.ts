/**
 * Manual-style artifact capture for PR screenshots.
 * Run with: CAPTURE_ARTIFACTS=1 ARTIFACTS_DIR=... npx playwright test
 *
 * ARTIFACTS_DIR defaults to repo-relative `artifacts/screenshots` (gitignored).
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  e2eUrl,
  playThroughToPostmortem,
  startJuniorShift,
  tabToButton,
} from './helpers';

const OUT =
  process.env.ARTIFACTS_DIR?.trim() ||
  path.join(process.cwd(), 'artifacts', 'screenshots');

test('capture postmortem UX artifacts', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  // Desktop finished postmortem
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    e2eUrl({ e2eQueue: 'failed-deploy,memory-leak', e2eTimerSec: 90, e2eSeed: 42 }),
  );
  await startJuniorShift(page);
  await playThroughToPostmortem(page, { maxIncidents: 4 });
  await page.getByRole('button', { name: 'Download Report' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(OUT, 'postmortem_review_desktop_1440.png'),
    fullPage: false,
  });

  // Keyboard focus on Download Report via real Tab (triggers :focus-visible)
  await page.locator('body').click({ position: { x: 8, y: 8 } });
  await tabToButton(page, 'Download Report');
  await expect(page.getByRole('button', { name: 'Download Report' })).toBeFocused();
  await page.screenshot({
    path: path.join(OUT, 'postmortem_review_focus_download.png'),
    fullPage: false,
  });

  // Copy success feedback
  await tabToButton(page, 'Copy Report');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Report copied to clipboard.' })).toBeVisible();
  await page.screenshot({
    path: path.join(OUT, 'postmortem_review_copy_success.png'),
    fullPage: false,
  });

  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Copy Report' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(OUT, 'postmortem_review_mobile_390.png'),
    fullPage: false,
  });

  // Copy failure feedback (reload with clipboard broken)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
        readText: async () => {
          throw new Error('denied');
        },
      },
    });
    const original = document.execCommand.bind(document);
    document.execCommand = (commandId: string, ...rest: unknown[]) => {
      if (commandId === 'copy') return false;
      return original(commandId, ...(rest as [boolean | undefined, string | undefined]));
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    e2eUrl({ e2eQueue: 'failed-deploy', e2eTimerSec: 90, e2eSeed: 7 }),
  );
  await startJuniorShift(page);
  await playThroughToPostmortem(page, { maxIncidents: 3 });
  await page.getByRole('button', { name: 'Copy Report' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Copy failed. Try Download Report instead.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Copy Report' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(OUT, 'postmortem_review_copy_failure.png'),
    fullPage: false,
  });
});
