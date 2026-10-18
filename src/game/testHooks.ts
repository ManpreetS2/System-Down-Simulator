/**
 * Dev/test-only hooks for deterministic Playwright runs.
 *
 * Gated on `import.meta.env.MODE === 'test'` so Vite tree-shakes the URL
 * parsing and overrides out of `build` / `build:pages` bundles.
 *
 * URL params (only when mode is `test`):
 * - e2eQueue: comma-separated incident ids (fixed shift order)
 * - e2eTimerSec: override per-incident countdown (seconds)
 * - e2eSeed: seeded RNG for action success rolls
 * - e2eStartHealth / e2eStartTrust / e2eStartBudget: starting metric overrides
 */
export interface TestHooks {
  queue: string[] | null;
  timerSec: number | null;
  seed: number | null;
  startHealth: number | null;
  startTrust: number | null;
  startBudget: number | null;
}

const EMPTY: TestHooks = {
  queue: null,
  timerSec: null,
  seed: null,
  startHealth: null,
  startTrust: null,
  startBudget: null,
};

function parseNumber(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseFromSearch(search: string): TestHooks {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const queueRaw = params.get('e2eQueue');
  const queue =
    queueRaw && queueRaw.trim().length > 0
      ? queueRaw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : null;

  return {
    queue,
    timerSec: parseNumber(params.get('e2eTimerSec')),
    seed: parseNumber(params.get('e2eSeed')),
    startHealth: parseNumber(params.get('e2eStartHealth')),
    startTrust: parseNumber(params.get('e2eStartTrust')),
    startBudget: parseNumber(params.get('e2eStartBudget')),
  };
}

/** True only under `vite --mode test` / `vite build --mode test`. */
export function isViteTestMode(): boolean {
  // Guard for Node (tsx smoke tests) where `import.meta.env` is undefined.
  // Vite replaces `import.meta.env.MODE` at build time for DCE.
  return typeof import.meta.env !== 'undefined' && import.meta.env.MODE === 'test';
}

/** Returns null outside Vite `test` mode (production / pages / default). */
export function readTestHooks(): TestHooks | null {
  if (!isViteTestMode()) return null;
  if (typeof window === 'undefined') return EMPTY;
  return parseFromSearch(window.location.search);
}

/** Mulberry32 — tiny deterministic PRNG for e2e rolls. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
