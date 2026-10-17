/**
 * Smoke tests for Markdown postmortem export.
 * Run via: npm run test:engine (chained after engine-smoke).
 */
import { INCIDENTS } from '../src/data/incidents';
import { initialState, reducer } from '../src/game/engine';
import {
  buildPostmortemMarkdown,
  computeStats,
  gradeFor,
  postmortemFilename,
  rankFor,
} from '../src/game/report';
import type { DecisionRecord, GameState } from '../src/types';

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function blankEffects() {
  return { health: 0, trust: 0, revenue: 0, budget: 0 };
}

function makeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    incidentId: 'failed-deploy',
    incidentTitle: 'Failed Deploy',
    severity: 'SEV2',
    category: 'deploy',
    actionLabel: 'Rollback',
    risk: 'low',
    focus: 'safety',
    quality: 'success',
    timedOut: false,
    score: 80,
    responseSec: 12,
    atShiftSec: 45,
    totalRevenueDelta: 1000,
    effects: blankEffects(),
    explanation: 'Rollback restored service.',
    responseMode: 'choice',
    investigationsUsed: 0,
    ...overrides,
  };
}

function baseOverState(overrides: Partial<GameState> = {}): GameState {
  const base = initialState('junior');
  return {
    ...base,
    phase: 'over',
    difficulty: 'junior',
    queue: ['failed-deploy', 'memory-leak', 'db-overload'],
    index: 2,
    score: 200,
    bestStreak: 2,
    shiftElapsedSec: 180,
    records: [],
    gameOverReason: null,
    metrics: {
      ...base.metrics,
      health: 72,
      trust: 68,
      budget: 50_000,
      revenueSaved: 12_000,
      revenueLost: 4_000,
      spend: 8_000,
    },
    ...overrides,
  };
}

console.log('Report: completed shift markdown');
{
  const state = baseOverState({
    records: [
      makeRecord({ score: 90, quality: 'success', atShiftSec: 40 }),
      makeRecord({
        incidentId: 'memory-leak',
        incidentTitle: 'Memory Leak',
        score: 40,
        quality: 'partial',
        risk: 'medium',
        atShiftSec: 100,
        actionLabel: 'Restart pod',
        explanation: 'Bought time but leak remains.',
      }),
      makeRecord({
        incidentId: 'db-overload',
        incidentTitle: 'DB Overload',
        score: 70,
        quality: 'success',
        atShiftSec: 160,
      }),
    ],
    score: 200,
  });
  const md = buildPostmortemMarkdown(state);
  assert(md.startsWith('# Incident Postmortem'), 'report has Markdown title');
  assert(md.includes('**Status:** Shift complete'), 'completed shift status');
  assert(md.includes('**Difficulty:** Junior'), 'difficulty label present');
  const grade = gradeFor(state.score, state.queue.length, true);
  const rank = rankFor(state.score, state.records.length);
  assert(md.includes(`- **Grade:** ${grade}`), `grade matches helper (${grade})`);
  assert(md.includes(`- **Rank:** ${rank}`), `rank matches helper (${rank})`);
  assert(md.includes('**Final score:** 200'), 'final score present');
  assert(md.includes('## Key metrics'), 'key metrics section');
  assert(md.includes('## Incident timeline'), 'timeline section');
  assert(md.includes('Failed Deploy'), 'timeline includes first incident');
  assert(md.includes('Memory Leak'), 'timeline includes second incident');
  assert(md.includes('## Recommendations'), 'recommendations section');
  assert(md.includes('## Notable decisions'), 'notable decisions when records exist');
  assert(md.includes('## Final company state'), 'final company state section');
  assert(!md.includes('## Early termination'), 'no early-termination section when finished');
  const name = postmortemFilename(state, new Date('2026-10-17T12:00:00Z'));
  assert(name.endsWith('.md'), 'filename ends with .md');
  assert(name.includes('junior'), 'filename includes difficulty');
  assert(name.includes('complete'), 'filename marks completed shift');
}

console.log('Report: early failure markdown');
{
  const state = baseOverState({
    gameOverReason:
      'System health hit zero. The platform went completely dark and leadership called the shift.',
    records: [
      makeRecord({
        quality: 'failure',
        score: -40,
        risk: 'high',
        actionLabel: 'Delete the database',
        explanation: 'Catastrophic.',
      }),
      makeRecord({
        incidentId: 'memory-leak',
        incidentTitle: 'Memory Leak',
        quality: 'failure',
        score: -30,
        risk: 'high',
        timedOut: false,
      }),
    ],
    score: -70,
    metrics: {
      ...baseOverState().metrics,
      health: 0,
      trust: 40,
      budget: 10_000,
      spend: 40_000,
    },
    minHealth: 0,
  });
  const md = buildPostmortemMarkdown(state);
  assert(md.includes('**Status:** Shift ended early'), 'early-failure status');
  assert(md.includes('## Early termination'), 'early termination heading');
  assert(md.includes('System health hit zero'), 'includes game-over reason');
  assert(md.includes('ended-early') || postmortemFilename(state).includes('ended-early'), 'filename tags early end');
  assert(md.includes('Backfired') || md.includes('failure') || md.includes('-40'), 'failure outcomes reflected');
}

console.log('Report: timed-out incidents markdown');
{
  const state = baseOverState({
    records: [
      makeRecord({
        timedOut: true,
        quality: 'failure',
        score: -50,
        actionLabel: null,
        risk: null,
        focus: null,
        responseMode: 'timeout',
        responseSec: 90,
        explanation: 'Timer expired with no action.',
      }),
      makeRecord({
        incidentId: 'memory-leak',
        incidentTitle: 'Memory Leak',
        timedOut: true,
        quality: 'failure',
        score: -45,
        actionLabel: null,
        responseMode: 'timeout',
        explanation: 'No response.',
      }),
    ],
    score: -95,
  });
  const stats = computeStats(state.records);
  assert(stats.timeouts === 2, 'stats count timeouts');
  const md = buildPostmortemMarkdown(state);
  assert(md.includes('Timed out'), 'timeline labels timeouts');
  assert(md.includes('No response before the countdown expired.'), 'timeout action wording');
  assert(md.includes('| Timed out | 2 |'), 'metrics table shows timeout count');
  assert(
    md.toLowerCase().includes('time out') || md.toLowerCase().includes('timer'),
    'recommendations mention timeouts',
  );
}

console.log('Report: empty incident history');
{
  const state = baseOverState({
    records: [],
    score: 0,
    queue: ['failed-deploy'],
    gameOverReason: 'Customer trust hit zero. Churn spiked past the point of recovery and the shift was called.',
    metrics: {
      ...baseOverState().metrics,
      health: 50,
      trust: 0,
      budget: 20_000,
    },
  });
  const md = buildPostmortemMarkdown(state);
  assert(md.includes('_The shift ended before any incident was handled._'), 'empty timeline message');
  assert(!md.includes('## Notable decisions'), 'no notable decisions without records');
  assert(md.includes('| Incidents resolved | 0/1 |'), 'zero resolved in metrics');
  assert(md.includes('| Avg response time | — |'), 'dash for empty avg response');
  assert(md.includes('## Recommendations'), 'still emits recommendations');
  assert(computeStats([]).accuracyPct === 0, 'empty stats accuracy is 0');
}

console.log('Report: engine-produced completed junior shift');
{
  const allIds = INCIDENTS.map((i) => i.id);
  let now = 9_000_000;
  let s: GameState = reducer(initialState('junior'), {
    type: 'START',
    difficulty: 'junior',
    queue: allIds.slice(0, 3),
    now,
  });
  let guard = 0;
  while (s.phase !== 'over' && guard < 30) {
    guard += 1;
    if (s.phase === 'incident') {
      now += 2000;
      s = reducer(s, { type: 'TICK', now });
      const incident = INCIDENTS.find((i) => i.id === s.queue[s.index])!;
      const safest = incident.actions.find((a) => a.risk === 'low') ?? incident.actions[0];
      s = reducer(s, { type: 'CHOOSE', actionId: safest.id, roll: 0.01, now });
    } else if (s.phase === 'result') {
      now += 1000;
      s = reducer(s, { type: 'CONTINUE', now });
    }
  }
  assert(s.phase === 'over', 'short junior shift reaches over');
  const md = buildPostmortemMarkdown(s);
  assert(md.includes('# Incident Postmortem'), 'engine shift yields a report');
  assert(s.records.every((r) => md.includes(r.incidentTitle)), 'every record title appears');
  assert(md.includes(`**Final score:** ${s.score.toLocaleString()}`), 'score matches engine state');
}

console.log(failures === 0 ? '\nALL REPORT CHECKS PASSED' : `\n${failures} REPORT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
