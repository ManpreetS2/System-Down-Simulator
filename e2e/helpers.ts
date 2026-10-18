import { expect, type Page } from '@playwright/test';

/** Build a test-mode URL with deterministic e2e hooks. */
export function e2eUrl(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `/?${qs}` : '/';
}

export async function startJuniorShift(page: Page): Promise<void> {
  await page.getByRole('radio', { name: /Junior/i }).click();
  await page.getByRole('button', { name: /Start Shift/i }).click();
  await expect(page.getByRole('heading', { name: /Incident Postmortem/i })).toHaveCount(0);
}

/** Click the first available remediation action on the current incident. */
export async function chooseFirstAction(page: Page): Promise<void> {
  const action = page.locator('.action-list .action-btn').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  await action.click();
}

export async function continueFromResult(page: Page): Promise<void> {
  const continueBtn = page.getByRole('button', {
    name: /Continue to next incident|View shift postmortem/i,
  });
  await expect(continueBtn).toBeVisible({ timeout: 20_000 });
  await continueBtn.click();
}

/** Play through incidents until the Postmortem screen appears. */
export async function playThroughToPostmortem(
  page: Page,
  opts: { maxIncidents?: number } = {},
): Promise<void> {
  const max = opts.maxIncidents ?? 12;
  for (let i = 0; i < max; i += 1) {
    if (await page.getByRole('heading', { name: 'Incident Postmortem' }).isVisible()) {
      return;
    }
    // Prefer choosing an action when unlocked; otherwise wait briefly for timeout path.
    const action = page.locator('.action-list .action-btn').first();
    if (await action.isVisible().catch(() => false)) {
      await action.click();
      await continueFromResult(page);
      continue;
    }
    // Wait for either actions, a result panel, or postmortem.
    await Promise.race([
      action.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => null),
      page
        .getByRole('button', { name: /Continue to next incident|View shift postmortem/i })
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => null),
      page
        .getByRole('heading', { name: 'Incident Postmortem' })
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => null),
    ]);
    if (await page.getByRole('heading', { name: 'Incident Postmortem' }).isVisible()) {
      return;
    }
    if (
      await page
        .getByRole('button', { name: /Continue to next incident|View shift postmortem/i })
        .isVisible()
        .catch(() => false)
    ) {
      await continueFromResult(page);
    } else if (await action.isVisible().catch(() => false)) {
      await action.click();
      await continueFromResult(page);
    }
  }
  await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toBeVisible();
}

/** Let the active incident timer expire into a result, then continue. */
export async function waitForTimeoutResult(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: /Continue to next incident|View shift postmortem/i }),
  ).toBeVisible({ timeout: 60_000 });
}

export async function readPostmortemScore(page: Page): Promise<string> {
  const score = page.locator('.pm-score-value');
  await expect(score).toBeVisible();
  return (await score.innerText()).trim();
}

export async function readPostmortemGrade(page: Page): Promise<string> {
  const grade = page.locator('.pm-head .grade');
  await expect(grade).toBeVisible();
  return (await grade.innerText()).trim();
}

export async function readPostmortemRank(page: Page): Promise<string> {
  const rank = page.locator('.pm-rank strong');
  await expect(rank).toBeVisible();
  return (await rank.innerText()).trim();
}

export async function readTimelineTitles(page: Page): Promise<string[]> {
  const titles = page.locator('.timeline-title');
  const count = await titles.count();
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // Badge text sits inside the title; strip severity badges by reading full text.
    out.push((await titles.nth(i).innerText()).replace(/\s+/g, ' ').trim());
  }
  return out;
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(
    overflow.scrollWidth,
    `horizontal overflow: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}
