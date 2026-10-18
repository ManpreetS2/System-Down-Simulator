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

export async function startSeniorOpenShift(page: Page): Promise<void> {
  await page.getByRole('radio', { name: /Senior/i }).click();
  await page.getByRole('checkbox', { name: /Open Response/i }).check();
  await page.getByRole('button', { name: /Start Shift/i }).click();
  await expect(page.getByRole('heading', { name: /Incident Postmortem/i })).toHaveCount(0);
}

/** Tab until an element matching `name` is focused (keyboard-only navigation). */
export async function tabToButton(page: Page, name: string | RegExp, maxTabs = 60): Promise<void> {
  const matcher = typeof name === 'string' ? name : name.source;
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return '';
      return (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    if (
      typeof name === 'string'
        ? focused.includes(name)
        : new RegExp(matcher, 'i').test(focused)
    ) {
      return;
    }
  }
  throw new Error(`tabToButton: could not focus "${String(name)}" within ${maxTabs} tabs`);
}

export async function investigateFirstSource(page: Page): Promise<void> {
  const btn = page.locator('.investigate-btn').first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await btn.click();
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

/** Ensure achievement toasts can fire for this shift (empty unlock list). */
export async function clearStoredAchievements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('system-down:achievements', '[]');
    } catch {
      // ignore
    }
  });
}

/**
 * Assert a control is hit-testable at its center (not covered by toasts/overlays).
 * Uses elementFromPoint — toBeVisible() alone is not enough when fixed UI occludes.
 */
export async function assertHitTestable(
  page: Page,
  name: string | RegExp,
): Promise<void> {
  const button = page.getByRole('button', { name });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();

  const probe = await button.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    const hit = !!top && (top === el || el.contains(top));
    return {
      hit,
      x,
      y,
      topTag: top?.nodeName ?? null,
      topClass:
        top instanceof HTMLElement ? top.className.toString().slice(0, 120) : null,
      topText: (top?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
    };
  });
  expect(probe.hit, `elementFromPoint missed button "${String(name)}": ${JSON.stringify(probe)}`).toBe(
    true,
  );

  // Playwright's trial click also fails when another element intercepts pointer events.
  await button.click({ trial: true });
}

/** Reach postmortem with several achievements unlocked (toasts still visible). */
export async function playAchievementShiftToPostmortem(page: Page): Promise<void> {
  await startJuniorShift(page);
  await playThroughToPostmortem(page, { maxIncidents: 6 });
  await expect(page.getByRole('heading', { name: 'Incident Postmortem' })).toBeVisible();
  // Wait until at least one achievement toast is on screen — do not dismiss or wait for expiry.
  await expect(page.locator('.toast-stack .toast').first()).toBeVisible({ timeout: 10_000 });
  const toastCount = await page.locator('.toast-stack .toast').count();
  expect(toastCount, 'expected achievement toasts while testing footer hit-targets').toBeGreaterThan(0);
}
