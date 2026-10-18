import { DIFFICULTIES, MAX_SCORE_PER_INCIDENT } from '../data/difficulty';
import type { DecisionRecord, GameState } from '../types';
import { formatClock, formatMoney } from '../utils/format';
import { formatScore, sanitizeMarkdownFragment } from '../utils/markdown';

/** Shift finished all planned incidents without an early collapse. */
export function isShiftFinished(state: Pick<GameState, 'gameOverReason'>): boolean {
  return state.gameOverReason === null;
}

/** Filename status tag — prefers early-end when a reason exists. */
export function postmortemStatusTag(state: Pick<GameState, 'gameOverReason' | 'phase'>): string {
  if (state.gameOverReason !== null) return 'ended-early';
  if (state.phase === 'over') return 'complete';
  return 'shift';
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

const RANKS = [
  'Intern',
  'Junior Engineer',
  'Engineer',
  'Senior Engineer',
  'Staff Engineer',
  'Principal Engineer',
] as const;

export type Rank = (typeof RANKS)[number];

function scoreRatio(score: number, incidentsPlayed: number): number {
  if (incidentsPlayed === 0) return 0;
  return Math.max(0, score) / (incidentsPlayed * MAX_SCORE_PER_INCIDENT);
}

export function gradeFor(score: number, incidentsPlanned: number, finishedShift: boolean): Grade {
  const ratio = scoreRatio(score, incidentsPlanned);
  if (!finishedShift) return ratio >= 0.4 ? 'D' : 'F';
  if (ratio >= 0.85) return 'S';
  if (ratio >= 0.7) return 'A';
  if (ratio >= 0.55) return 'B';
  if (ratio >= 0.4) return 'C';
  if (ratio >= 0.22) return 'D';
  return 'F';
}

export function rankFor(score: number, incidentsPlayed: number): Rank {
  const ratio = scoreRatio(score, Math.max(1, incidentsPlayed));
  if (ratio >= 0.85) return RANKS[5];
  if (ratio >= 0.7) return RANKS[4];
  if (ratio >= 0.55) return RANKS[3];
  if (ratio >= 0.4) return RANKS[2];
  if (ratio >= 0.22) return RANKS[1];
  return RANKS[0];
}

export interface ShiftStats {
  resolved: number;
  successes: number;
  partials: number;
  failures: number;
  timeouts: number;
  riskyTaken: number;
  accuracyPct: number;
  avgResponseSec: number;
  strongest: DecisionRecord | null;
  mostDamaging: DecisionRecord | null;
}

export function computeStats(records: DecisionRecord[]): ShiftStats {
  const resolved = records.length;
  const successes = records.filter((r) => r.quality === 'success').length;
  const partials = records.filter((r) => r.quality === 'partial').length;
  const failures = records.filter((r) => r.quality === 'failure').length;
  const timeouts = records.filter((r) => r.timedOut).length;
  const riskyTaken = records.filter((r) => r.risk === 'high').length;
  const responded = records.filter((r) => !r.timedOut);
  const avgResponseSec =
    responded.length > 0
      ? responded.reduce((sum, r) => sum + r.responseSec, 0) / responded.length
      : 0;

  let strongest: DecisionRecord | null = null;
  let mostDamaging: DecisionRecord | null = null;
  for (const r of records) {
    if (!strongest || r.score > strongest.score) strongest = r;
    if (!mostDamaging || r.score < mostDamaging.score) mostDamaging = r;
  }

  return {
    resolved,
    successes,
    partials,
    failures,
    timeouts,
    riskyTaken,
    accuracyPct: resolved > 0 ? Math.round((successes / resolved) * 100) : 0,
    avgResponseSec,
    strongest,
    mostDamaging,
  };
}

/** Three personalized, rule-based improvement recommendations. */
export function buildRecommendations(state: GameState, stats: ShiftStats): string[] {
  const recs: string[] = [];

  if (stats.timeouts > 0) {
    recs.push(
      `You let ${stats.timeouts === 1 ? 'an incident' : `${stats.timeouts} incidents`} time out with no response. In an incident, a reasonable action taken now beats a perfect action taken too late — pick a mitigation and commit.`,
    );
  }
  if (stats.riskyTaken >= Math.max(2, Math.ceil(stats.resolved / 3))) {
    recs.push(
      'You reached for high-risk plays often. Fast-but-risky moves are sometimes right, but make them a deliberate exception: check whether a rollback or containment step gets 90% of the value at 10% of the risk.',
    );
  }
  if (stats.failures >= 2) {
    recs.push(
      'Several decisions backfired. Before acting, spend ten seconds confirming the failure mode — most of the traps this shift punished treating symptoms (restarts, deletes, redeploys) instead of causes.',
    );
  }
  if (stats.avgResponseSec > 30 && stats.timeouts === 0) {
    recs.push(
      `Your average response time was ${Math.round(stats.avgResponseSec)}s. Revenue bleeds every second an incident stays open — read the symptoms once, decide, and act.`,
    );
  }
  if (state.metrics.spend > 30000) {
    recs.push(
      'Engineering spend ran high. Capacity and plan upgrades are the expensive way out of most incidents — caching, rollbacks, and targeted fixes usually cost a tenth as much.',
    );
  }
  if (state.minTrust < 50) {
    recs.push(
      'Customer trust dipped dangerously low. Communicate early during customer-facing incidents — a status banner and honest messaging protect trust even while systems are still broken.',
    );
  }
  if (state.minHealth < 40) {
    recs.push(
      'System health fell deep into the red. Prioritize stopping the bleeding (rollback, load shedding, edge filtering) before root-causing — stability first, understanding second.',
    );
  }
  if (recs.length < 3) {
    recs.push(
      'Strong shift overall. To push further, favor the mitigations that also fix the root cause — the highest-scoring plays resolve the incident and prevent the recurrence in one move.',
    );
  }
  if (recs.length < 3) {
    recs.push(
      'Keep your streak discipline: consecutive clean resolutions compound trust and budget, which gives you slack to absorb the one incident that inevitably goes sideways.',
    );
  }
  if (recs.length < 3) {
    recs.push(
      'Try a harder difficulty. Shorter timers force the prioritization instincts that real on-call rotations build.',
    );
  }
  return recs.slice(0, 3);
}

function qualityLabel(record: DecisionRecord): string {
  if (record.timedOut) return 'Timed out';
  if (record.quality === 'success') return 'Resolved';
  if (record.quality === 'partial') return 'Partial';
  return 'Backfired';
}

function scoreLine(score: number): string {
  return `${score >= 0 ? '+' : ''}${score}`;
}

/** Stable filename for the downloaded Markdown postmortem. */
export function postmortemFilename(state: GameState, when = new Date()): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  const tag = postmortemStatusTag(state);
  return `incident-postmortem-${y}-${m}-${d}-${state.difficulty}-${tag}.md`;
}

/**
 * Build a Markdown incident postmortem from tracked shift data.
 * Derived recommendations come from `buildRecommendations`; no invented metrics.
 */
export function buildPostmortemMarkdown(state: GameState): string {
  const config = DIFFICULTIES[state.difficulty];
  const stats = computeStats(state.records);
  const finished = isShiftFinished(state);
  const grade = gradeFor(state.score, state.queue.length, finished);
  const rank = rankFor(state.score, Math.max(1, state.records.length));
  const recommendations = buildRecommendations(state, stats);
  const lines: string[] = [];

  lines.push('# Incident Postmortem');
  lines.push('');
  lines.push(`- **Status:** ${finished ? 'Shift complete' : 'Shift ended early'}`);
  lines.push(`- **Difficulty:** ${config.label}`);
  lines.push(`- **Grade:** ${grade}`);
  lines.push(`- **Rank:** ${rank}`);
  lines.push(`- **Final score:** ${formatScore(state.score)}`);
  lines.push(`- **Shift duration:** ${formatClock(state.shiftElapsedSec)}`);
  lines.push('');

  if (!finished && state.gameOverReason) {
    lines.push('## Early termination');
    lines.push('');
    lines.push(sanitizeMarkdownFragment(state.gameOverReason));
    lines.push('');
  }

  lines.push('## Key metrics');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Incidents resolved | ${stats.resolved}/${state.queue.length || 0} |`);
  lines.push(`| Decision accuracy | ${stats.accuracyPct}% |`);
  lines.push(
    `| Avg response time | ${stats.avgResponseSec > 0 ? `${Math.round(stats.avgResponseSec)}s` : '—'} |`,
  );
  lines.push(`| Successes / partials / failures | ${stats.successes} / ${stats.partials} / ${stats.failures} |`);
  lines.push(`| Timed out | ${stats.timeouts} |`);
  lines.push(`| Risky calls | ${stats.riskyTaken} |`);
  lines.push(`| Best streak | ${state.bestStreak} |`);
  lines.push(`| Revenue saved | ${formatMoney(state.metrics.revenueSaved)} |`);
  lines.push(`| Revenue lost | ${formatMoney(state.metrics.revenueLost)} |`);
  lines.push(`| Engineering spend | ${formatMoney(state.metrics.spend)} |`);
  lines.push('');

  if (stats.strongest || stats.mostDamaging) {
    lines.push('## Notable decisions');
    lines.push('');
    if (stats.strongest) {
      const label = stats.strongest.actionLabel
        ? sanitizeMarkdownFragment(stats.strongest.actionLabel)
        : 'No action taken';
      lines.push(
        `- **Strongest call** (${scoreLine(stats.strongest.score)} pts): ${sanitizeMarkdownFragment(stats.strongest.incidentTitle)} — ${label}`,
      );
    }
    if (stats.mostDamaging) {
      const label = stats.mostDamaging.actionLabel
        ? sanitizeMarkdownFragment(stats.mostDamaging.actionLabel)
        : 'No response before the timer expired';
      lines.push(
        `- **Most damaging** (${scoreLine(stats.mostDamaging.score)} pts): ${sanitizeMarkdownFragment(stats.mostDamaging.incidentTitle)} — ${label}`,
      );
    }
    lines.push('');
  }

  lines.push('## Final company state');
  lines.push('');
  lines.push(`- System health: ${Math.round(state.metrics.health)}%`);
  lines.push(`- Customer trust: ${Math.round(state.metrics.trust)}%`);
  lines.push(`- Budget remaining: ${formatMoney(state.metrics.budget)}`);
  lines.push('');

  lines.push('## Incident timeline');
  lines.push('');
  if (state.records.length === 0) {
    lines.push('_The shift ended before any incident was handled._');
    lines.push('');
  } else {
    for (const [i, record] of state.records.entries()) {
      const action = record.timedOut
        ? 'No response before the countdown expired.'
        : sanitizeMarkdownFragment(record.actionLabel ?? 'Unknown action');
      const responseBit = record.timedOut
        ? ''
        : ` · responded in ${Math.round(record.responseSec)}s`;
      lines.push(
        `${i + 1}. **T+${formatClock(record.atShiftSec)}** · ${record.severity} · ${sanitizeMarkdownFragment(record.incidentTitle)}`,
      );
      lines.push(`   - Action: ${action}`);
      lines.push(
        `   - Outcome: ${qualityLabel(record)} · ${scoreLine(record.score)} pts${responseBit}`,
      );
      if (record.explanation) {
        lines.push(`   - Notes: ${sanitizeMarkdownFragment(record.explanation)}`);
      }
      lines.push('');
    }
  }

  lines.push('## Recommendations');
  lines.push('');
  if (recommendations.length === 0) {
    lines.push('_No recommendations generated for this shift._');
  } else {
    recommendations.forEach((rec, i) => {
      lines.push(`${i + 1}. ${sanitizeMarkdownFragment(rec)}`);
    });
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Generated locally by System Down — Incident Response Simulator._');
  lines.push('');

  return lines.join('\n');
}
