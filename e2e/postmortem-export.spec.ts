import { expect, test, type Page } from '@playwright/test';
import {
  assertNoHorizontalOverflow,
  continueFromResult,
  e2eUrl,
  investigateFirstSource,
  playThroughToPostmortem,
  readPostmortemGrade,
  readPostmortemRank,
  readPostmortemScore,
  readTimelineTitles,
  startJuniorShift,
  startSeniorOpenShift,
  tabToButton,
  waitForTimeoutResult,
} from './helpers';

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
}

test.describe('Export Incident Postmortem', () => {
  test('completed shift: download + copy match on-screen report values', async ({ page }) => {
    await grantClipboard(page);
    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy,memory-leak',
        e2eTimerSec: 90,
        e2eSeed: 42,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 4 });

    await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toBeVisible();
    await expect(page.getByText('Shift complete')).toBeVisible();

    const score = await readPostmortemScore(page);
    const grade = await readPostmortemGrade(page);
    const rank = await readPostmortemRank(page);
    const titles = await readTimelineTitles(page);
    expect(titles.length).toBeGreaterThan(0);

    // Download Report → real .md file
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Report' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    expect(download.suggestedFilename()).toContain('junior');
    expect(download.suggestedFilename()).toContain('complete');

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const fs = await import('node:fs/promises');
    const md = await fs.readFile(downloadPath!, 'utf8');

    expect(md).toContain('# Incident Postmortem');
    expect(md).toContain('**Status:** Shift complete');
    expect(md).toContain('**Difficulty:** Junior');
    expect(md).toContain(`**Final score:** ${score}`);
    expect(md).toContain(`**Grade:** ${grade}`);
    expect(md).toContain(`**Rank:** ${rank}`);
    for (const title of titles) {
      // Timeline title includes severity badge text; match the incident name portion.
      const name = title.replace(/^SEV[123]\s+/i, '').trim();
      expect(md).toContain(name);
    }

    // Copy Report → clipboard matches downloaded file
    await page.getByRole('button', { name: 'Copy Report' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Report copied to clipboard.' })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(md);
  });

  test('clipboard failure shows live-region error feedback', async ({ page }) => {
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

    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 90,
        e2eSeed: 7,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 3 });

    await page.getByRole('button', { name: 'Copy Report' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Copy failed. Try Download Report instead.' }),
    ).toBeVisible();
  });

  test('Restart Shift and Return Home still work', async ({ page }) => {
    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 90,
        e2eSeed: 3,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 3 });

    await page.getByRole('button', { name: 'Restart Shift' }).click();
    await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toHaveCount(0);
    // After restart we should be mid-shift again (incident or result), not home.
    await expect(page.locator('.game-header, .incident-panel, .result-panel').first()).toBeVisible();

    // Finish again to return to postmortem, then go home.
    await playThroughToPostmortem(page, { maxIncidents: 4 });
    await page.getByRole('button', { name: 'Return Home' }).click();
    await expect(page.getByRole('button', { name: /Start Shift/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toHaveCount(0);
  });

  test('early termination produces ended-early report', async ({ page }) => {
    await page.goto(
      e2eUrl({
        e2eQueue: 'memory-leak,failed-deploy',
        e2eTimerSec: 2,
        e2eStartHealth: 1,
        e2eSeed: 1,
      }),
    );
    await startJuniorShift(page);
    // Let the short timer expire; low starting health should end the shift early.
    await waitForTimeoutResult(page);
    await page.getByRole('button', { name: /Continue to next incident|View shift postmortem/i }).click();

    // May need a second incident if health didn't hit zero yet.
    for (let i = 0; i < 4; i += 1) {
      if (await page.getByRole('heading', { name: 'Incident Postmortem' }).isVisible()) break;
      if (
        await page
          .getByRole('button', { name: /Continue to next incident|View shift postmortem/i })
          .isVisible()
          .catch(() => false)
      ) {
        await page
          .getByRole('button', { name: /Continue to next incident|View shift postmortem/i })
          .click();
        continue;
      }
      await waitForTimeoutResult(page);
      await page.getByRole('button', { name: /Continue to next incident|View shift postmortem/i }).click();
    }

    await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toBeVisible();
    await expect(page.getByText('Shift ended early')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Report' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('ended-early');
    const fs = await import('node:fs/promises');
    const md = await fs.readFile((await download.path())!, 'utf8');
    expect(md).toContain('**Status:** Shift ended early');
    expect(md).toContain('## Early termination');
  });

  test('timeouts appear in timeline and report', async ({ page }) => {
    await page.goto(
      e2eUrl({
        e2eQueue: 'ssl-expired',
        e2eTimerSec: 2,
        e2eSeed: 9,
      }),
    );
    await startJuniorShift(page);
    await waitForTimeoutResult(page);
    await page.getByRole('button', { name: /View shift postmortem|Continue to next incident/i }).click();
    await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toBeVisible();

    await expect(page.locator('.timeline-item').filter({ hasText: /Timed out/i }).first()).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Report' }).click();
    const download = await downloadPromise;
    const fs = await import('node:fs/promises');
    const md = await fs.readFile((await download.path())!, 'utf8');
    expect(md).toContain('Outcome: Timed out');
    expect(md).toContain('No response before the countdown expired.');
    expect(md).toMatch(/You let (an|\d+) incident/);
  });

  test('desktop 1440px layout: export buttons visible, no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 90,
        e2eSeed: 11,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 3 });

    await expect(page.getByRole('button', { name: 'Download Report' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeVisible();
    await page.getByRole('button', { name: 'Download Report' }).scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(page);
  });

  test('mobile 390px layout: export buttons usable, no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 90,
        e2eSeed: 13,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 3 });

    const download = page.getByRole('button', { name: 'Download Report' });
    const copy = page.getByRole('button', { name: 'Copy Report' });
    await download.scrollIntoViewIfNeeded();
    await expect(download).toBeVisible();
    await expect(copy).toBeVisible();
    const box = await download.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThan(100);
    await assertNoHorizontalOverflow(page);
  });

  test('keyboard: Tab to export buttons, Enter activates, focus restored after copy', async ({
    page,
  }) => {
    await grantClipboard(page);
    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 90,
        e2eSeed: 21,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 3 });

    // Reset focus to document body so Tab order starts cleanly.
    await page.locator('body').click({ position: { x: 4, y: 4 } });

    const downloadPromise = page.waitForEvent('download');
    await tabToButton(page, 'Download Report');
    await expect(page.getByRole('button', { name: 'Download Report' })).toBeFocused();
    await page.keyboard.press('Enter');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    await expect(page.getByRole('status').filter({ hasText: 'Report download started.' })).toBeVisible();

    await tabToButton(page, 'Copy Report');
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Report copied to clipboard.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeFocused();

    // Live-region re-announce: second copy bumps data-feedback-nonce and shows feedback again.
    const nonce1 = await page.locator('[data-feedback-nonce]').getAttribute('data-feedback-nonce');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Report copied to clipboard.' })).toBeVisible();
    const nonce2 = await page.locator('[data-feedback-nonce]').getAttribute('data-feedback-nonce');
    expect(Number(nonce2)).toBeGreaterThan(Number(nonce1));
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeFocused();
  });

  test('clipboard API reject falls back to real execCommand copy', async ({ page }) => {
    await grantClipboard(page);
    // Only break writeText; leave readText and do NOT stub execCommand.
    await page.addInitScript(() => {
      const clip = navigator.clipboard;
      if (!clip?.writeText || !clip.readText) return;
      const readText = clip.readText.bind(clip);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('denied');
          },
          readText,
        },
      });
    });

    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 90,
        e2eSeed: 23,
      }),
    );
    await startJuniorShift(page);
    await playThroughToPostmortem(page, { maxIncidents: 3 });

    await page.getByRole('button', { name: 'Copy Report' }).focus();
    await page.getByRole('button', { name: 'Copy Report' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Report copied to clipboard.' })).toBeVisible();
    // Focus must be restored to Copy after the execCommand textarea path.
    await expect(page.getByRole('button', { name: 'Copy Report' })).toBeFocused();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('# Incident Postmortem');
    expect(clipboard).toContain('**Difficulty:** Junior');
  });

  test('senior open response with hostile Markdown stays single-line in report', async ({ page }) => {
    await page.goto(
      e2eUrl({
        e2eQueue: 'failed-deploy',
        e2eTimerSec: 120,
        e2eSeed: 29,
      }),
    );
    await startSeniorOpenShift(page);
    await investigateFirstSource(page);

    // "Restart everything" grades as non-success for failed-deploy, so the
    // engine keeps `Open response: ${rawText.slice(0, 72)}`. Put hostile tokens
    // early so they survive the 72-char truncation into actionLabel.
    const hostile =
      'Restart.\n`code` #|<img src=x onerror=alert(1)>[link](javascript:alert(1))\nkeep going somehow.';

    const input = page.locator('#open-response-input');
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill(hostile);
    await page.getByRole('button', { name: /Submit response/i }).click();
    await continueFromResult(page);
    await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Report' }).click();
    const download = await downloadPromise;
    const fs = await import('node:fs/promises');
    const md = await fs.readFile((await download.path())!, 'utf8');

    const h2Count = (md.match(/^## /gm) ?? []).length;
    expect(h2Count).toBeGreaterThanOrEqual(4);
    // Structural headings must not be multiplied by injected content.
    expect((md.match(/^## Early termination$/gm) ?? []).length).toBeLessThanOrEqual(1);
    expect((md.match(/^## Key metrics$/gm) ?? []).length).toBe(1);
    expect((md.match(/^## Incident timeline$/gm) ?? []).length).toBe(1);
    expect((md.match(/^\| Metric \| Value \|$/gm) ?? []).length).toBe(1);
    expect((md.match(/^\| --- \| --- \|$/gm) ?? []).length).toBe(1);

    expect(md).toContain('&lt;img');
    expect(md).not.toContain('<img src=x');
    expect(md).toContain('\\[link\\]');
    expect(md).toContain('\\`code\\`');
    expect(md).toContain('\\|');
    // User payload must not appear as its own top-level heading line.
    expect(md).not.toMatch(/^#\|/m);

    // Action line containing the open response should be a single physical line.
    const actionLine = md.split('\n').find((l) => l.includes('Action: Open response:'));
    expect(actionLine).toBeTruthy();
    expect(actionLine!.includes('\n')).toBe(false);
    expect(actionLine).toContain('&lt;img');
    expect(actionLine).not.toContain('<img');
    // Flattened user fragments appear without raw HTML tags (attribute text may remain escaped).
    const timelineBlob = md.slice(md.indexOf('## Incident timeline'));
    expect(timelineBlob).not.toContain('<img');
    expect(timelineBlob).toContain('&lt;img');
  });
});
