import { DIFFICULTIES } from '../data/difficulty';
import { getIncidentBrief } from '../data/investigations';
import { getIncident } from '../data/incidents';
import type { GradeResult } from './grader';
import { isViteTestMode, readTestHooks } from './testHooks';
import type {
  DecisionRecord,
  DelayedQueued,
  DifficultyId,
  Effects,
  GameState,
  Incident,
  IncidentAction,
  InfraState,
  Metrics,
  Outcome,
  RevealedEvidence,
  ScenarioPhase,
} from '../types';

export const INFRA_BASELINE: InfraState = {
  cpu: 34,
  memory: 47,
  dbLatency: 88,
  errorRate: 0.4,
  requestVolume: 100,
  uptimePct: 100,
};

/**
 * Maximum simulated seconds applied to drains in a single TICK.
 * Wall-clock display and absolute deadlines still use the real timestamp, so
 * a suspended tab can time out correctly without dumping minutes of drain
 * into one catch-up frame.
 */
export const MAX_DRAIN_DT_SEC = 0.5;

export type GameAction =
  | {
      type: 'START';
      difficulty: DifficultyId;
      queue: string[];
      now: number;
      openResponsePreferred?: boolean;
    }
  | { type: 'TICK'; now: number }
  | { type: 'INVESTIGATE'; sourceId: string; now: number }
  | { type: 'CHOOSE'; actionId: string; roll: number; now: number }
  | { type: 'SUBMIT_OPEN'; grade: GradeResult; now: number }
  | { type: 'CLEAR_OPEN_PENDING' }
  | { type: 'SET_OPEN_PREFERRED'; value: boolean }
  | { type: 'CONTINUE'; now: number }
  | { type: 'RESET' };

export function initialState(difficulty: DifficultyId): GameState {
  const config = DIFFICULTIES[difficulty];
  return {
    phase: 'idle',
    difficulty,
    queue: [],
    index: 0,
    metrics: {
      health: config.startHealth,
      trust: config.startTrust,
      budget: config.startBudget,
      revenue: 0,
      revenueLost: 0,
      revenueSaved: 0,
      spend: 0,
    },
    infra: { ...INFRA_BASELINE },
    score: 0,
    streak: 0,
    bestStreak: 0,
    minHealth: config.startHealth,
    minTrust: config.startTrust,
    shiftStartedAt: 0,
    shiftElapsedSec: 0,
    downtimeSec: 0,
    incidentStartedAt: null,
    incidentDeadline: null,
    lastResult: null,
    pendingDelayed: [],
    records: [],
    gameOverReason: null,
    healthHistory: [config.startHealth],
    trustHistory: [config.startTrust],
    investigatedSources: [],
    revealedEvidence: [],
    scenarioPhase: 'triage',
    openResponsePreferred: config.allowOpenResponse,
    pendingOpenResponse: null,
  };
}

function initialEvidenceFor(incidentId: string): RevealedEvidence[] {
  const brief = getIncidentBrief(incidentId);
  return brief.initialEvidence.map((e) => ({
    id: e.id,
    kind: e.kind,
    text: e.text,
    glossary: e.glossary,
    sourceLabel: 'Initial alert',
  }));
}

function scenarioPhaseFor(state: Pick<GameState, 'investigatedSources' | 'difficulty'>): ScenarioPhase {
  const min = DIFFICULTIES[state.difficulty].minInvestigationsBeforeActions;
  if (state.investigatedSources.length === 0) return 'triage';
  if (state.investigatedSources.length < min) return 'investigating';
  return 'ready';
}

function beginIncident(state: GameState, now: number): GameState {
  const incidentId = state.queue[state.index];
  const config = DIFFICULTIES[state.difficulty];
  let timerSec = config.timerSec;
  // Test-mode only — Vite replaces MODE at build time and DCE's this branch.
  if (isViteTestMode()) {
    const hooks = readTestHooks();
    if (hooks?.timerSec != null && hooks.timerSec > 0) {
      timerSec = hooks.timerSec;
    }
  }
  return {
    ...state,
    phase: 'incident',
    investigatedSources: [],
    revealedEvidence: incidentId ? initialEvidenceFor(incidentId) : [],
    scenarioPhase: config.minInvestigationsBeforeActions > 0 ? 'triage' : 'ready',
    pendingOpenResponse: null,
    incidentStartedAt: now,
    incidentDeadline: now + timerSec * 1000,
    lastResult: null,
  };
}
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** Negative consequences scale with difficulty; positive ones do not. */
function scaleEffects(effects: Effects, mult: number): Effects {
  const scale = (v: number): number => (v < 0 ? Math.round(v * mult) : v);
  return {
    health: scale(effects.health),
    trust: scale(effects.trust),
    revenue: scale(effects.revenue),
    budget: scale(effects.budget),
  };
}

function applyEffects(metrics: Metrics, effects: Effects): Metrics {
  return {
    ...metrics,
    health: clamp(metrics.health + effects.health, 0, 100),
    trust: clamp(metrics.trust + effects.trust, 0, 100),
    budget: metrics.budget + effects.budget,
    revenue: metrics.revenue + effects.revenue,
    spend: metrics.spend + Math.max(0, -effects.budget),
    revenueSaved: metrics.revenueSaved + Math.max(0, effects.revenue),
    revenueLost: metrics.revenueLost + Math.max(0, -effects.revenue),
  };
}

function gameOverReasonFor(metrics: Metrics): string | null {
  if (metrics.health <= 0)
    return 'System health hit zero. The platform went completely dark and leadership called the shift.';
  if (metrics.trust <= 0)
    return 'Customer trust hit zero. Churn spiked past the point of recovery and the shift was called.';
  if (metrics.budget <= 0)
    return 'The engineering budget ran dry. The company is insolvent and the shift was called.';
  return null;
}

function currentIncident(state: GameState): Incident | null {
  const id = state.queue[state.index];
  return id ? getIncident(id) : null;
}

function moveToward(current: number, target: number, rate: number, jitter: number): number {
  const next = current + (target - current) * rate + (Math.random() - 0.5) * jitter;
  return Math.max(0, next);
}

function stepInfra(infra: InfraState, incident: Incident | null, uptimePct: number): InfraState {
  const impact = incident?.impact ?? {};
  return {
    cpu: clamp(moveToward(infra.cpu, INFRA_BASELINE.cpu + (impact.cpu ?? 0), 0.12, 2.4), 1, 100),
    memory: clamp(
      moveToward(infra.memory, INFRA_BASELINE.memory + (impact.memory ?? 0), 0.12, 1.6),
      1,
      100,
    ),
    dbLatency: moveToward(
      infra.dbLatency,
      INFRA_BASELINE.dbLatency + (impact.dbLatency ?? 0),
      0.12,
      7,
    ),
    errorRate: Math.max(
      0,
      moveToward(infra.errorRate, INFRA_BASELINE.errorRate + (impact.errorRate ?? 0), 0.12, 0.3),
    ),
    requestVolume: Math.max(
      4,
      moveToward(
        infra.requestVolume,
        INFRA_BASELINE.requestVolume + (impact.requestVolume ?? 0),
        0.12,
        4,
      ),
    ),
    uptimePct,
  };
}

interface ResolveArgs {
  state: GameState;
  incident: Incident;
  action: IncidentAction | null;
  outcome: Outcome;
  timedOut: boolean;
  now: number;
  responseMode: DecisionRecord['responseMode'];
  actionLabelOverride?: string | null;
  riskOverride?: IncidentAction['risk'] | null;
  focusOverride?: IncidentAction['focus'] | null;
  /** Extra remediation minutes for open responses without a mapped action. */
  openTimeCostMin?: number;
}

function resolveIncident({
  state,
  incident,
  action,
  outcome,
  timedOut,
  now,
  responseMode,
  actionLabelOverride,
  riskOverride,
  focusOverride,
  openTimeCostMin = 5,
}: ResolveArgs): GameState {
  const config = DIFFICULTIES[state.difficulty];
  const scaled = scaleEffects(outcome.effects, config.consequenceMult);

  const remediationMin = action ? action.timeCostMin : responseMode === 'open' ? openTimeCostMin : 0;
  const timeLossRevenue = Math.round(
    remediationMin * incident.revenueLossPerMin * config.consequenceMult,
  );

  let metrics = applyEffects(state.metrics, scaled);
  metrics = {
    ...metrics,
    revenue: metrics.revenue - timeLossRevenue,
    revenueLost: metrics.revenueLost + timeLossRevenue,
  };

  const delayedLanded: DelayedQueued[] = [];
  let delayedScore = 0;
  for (const pending of state.pendingDelayed) {
    const scaledDelayed = scaleEffects(pending.effects, config.consequenceMult);
    metrics = applyEffects(metrics, scaledDelayed);
    delayedScore += pending.score;
    delayedLanded.push({ ...pending, effects: scaledDelayed });
  }

  const pendingDelayed: DelayedQueued[] = outcome.delayed
    ? [{ ...outcome.delayed, sourceIncident: incident.title }]
    : [];

  const responseSec = state.incidentStartedAt ? (now - state.incidentStartedAt) / 1000 : 0;
  const failed = timedOut || outcome.quality === 'failure';
  const streak = failed ? 0 : state.streak + 1;

  const record: DecisionRecord = {
    incidentId: incident.id,
    incidentTitle: incident.title,
    severity: incident.severity,
    category: incident.category,
    actionLabel: actionLabelOverride ?? action?.label ?? null,
    risk: riskOverride ?? action?.risk ?? null,
    focus: focusOverride ?? action?.focus ?? null,
    quality: outcome.quality,
    timedOut,
    score: outcome.score,
    responseSec,
    atShiftSec: (now - state.shiftStartedAt) / 1000,
    totalRevenueDelta: scaled.revenue - timeLossRevenue,
    effects: scaled,
    explanation: outcome.explanation,
    responseMode,
    investigationsUsed: state.investigatedSources.length,
  };

  const gameOverReason = gameOverReasonFor(metrics);

  return {
    ...state,
    phase: 'result',
    metrics,
    score: state.score + outcome.score + delayedScore,
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
    minHealth: Math.min(state.minHealth, metrics.health),
    minTrust: Math.min(state.minTrust, metrics.trust),
    incidentStartedAt: null,
    incidentDeadline: null,
    pendingOpenResponse: null,
    lastResult: {
      record,
      outcome,
      incident,
      action,
      timeLossRevenue,
      delayedLanded,
      delayedQueuedMessage: outcome.delayed
        ? 'This decision has a delayed consequence. It will surface later in the shift.'
        : null,
    },
    pendingDelayed,
    records: [...state.records, record],
    gameOverReason,
    healthHistory: [...state.healthHistory, metrics.health],
    trustHistory: [...state.trustHistory, metrics.trust],
  };
}

export function reducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'START': {
      const fresh = initialState(action.difficulty);
      let metrics = fresh.metrics;
      let minHealth = fresh.minHealth;
      let minTrust = fresh.minTrust;
      // Test-mode only — starting metric overrides for early-failure e2e scenarios.
      if (isViteTestMode()) {
        const hooks = readTestHooks();
        if (hooks) {
          if (hooks.startHealth != null) {
            metrics = { ...metrics, health: hooks.startHealth };
            minHealth = hooks.startHealth;
          }
          if (hooks.startTrust != null) {
            metrics = { ...metrics, trust: hooks.startTrust };
            minTrust = hooks.startTrust;
          }
          if (hooks.startBudget != null) {
            metrics = { ...metrics, budget: hooks.startBudget };
          }
        }
      }
      const started: GameState = {
        ...fresh,
        metrics,
        minHealth,
        minTrust,
        queue: action.queue,
        shiftStartedAt: action.now,
        openResponsePreferred:
          action.openResponsePreferred ?? DIFFICULTIES[action.difficulty].allowOpenResponse,
      };
      return beginIncident(started, action.now);
    }

    case 'SET_OPEN_PREFERRED':
      return { ...state, openResponsePreferred: action.value };

    case 'CLEAR_OPEN_PENDING':
      return { ...state, pendingOpenResponse: null };

    case 'INVESTIGATE': {
      if (state.phase !== 'incident') return state;
      if (state.investigatedSources.includes(action.sourceId)) return state;
      const incident = currentIncident(state);
      if (!incident || state.incidentDeadline === null) return state;
      const brief = getIncidentBrief(incident.id);
      const source = brief.investigations.find((s) => s.id === action.sourceId);
      if (!source) return state;

      const revealed: RevealedEvidence[] = [
        ...state.revealedEvidence,
        ...source.findings.map((f) => ({
          id: f.id,
          kind: f.kind,
          text: f.text,
          glossary: f.glossary,
          sourceLabel: source.label,
        })),
      ];
      const investigatedSources = [...state.investigatedSources, source.id];
      const nextDeadline = state.incidentDeadline - source.timeCostSec * 1000;

      // Apply a small slice of unresolved drain for the investigation time spent.
      const config = DIFFICULTIES[state.difficulty];
      const dt = source.timeCostSec;
      const mult = config.consequenceMult;
      const revenueBleed = (incident.revenueLossPerMin / 60) * dt * mult;
      const metrics: Metrics = {
        ...state.metrics,
        health: clamp(state.metrics.health - incident.healthDrainPerSec * dt * mult, 0, 100),
        trust: clamp(state.metrics.trust - incident.trustDrainPerSec * dt * mult, 0, 100),
        revenue: state.metrics.revenue - revenueBleed,
        revenueLost: state.metrics.revenueLost + revenueBleed,
      };

      let infra = state.infra;
      if (source.indicatorHints) {
        infra = {
          ...infra,
          cpu: clamp(infra.cpu + (source.indicatorHints.cpu ?? 0), 1, 100),
          memory: clamp(infra.memory + (source.indicatorHints.memory ?? 0), 1, 100),
          dbLatency: Math.max(0, infra.dbLatency + (source.indicatorHints.dbLatency ?? 0)),
          errorRate: Math.max(0, infra.errorRate + (source.indicatorHints.errorRate ?? 0)),
          requestVolume: Math.max(4, infra.requestVolume + (source.indicatorHints.requestVolume ?? 0)),
        };
      }

      const next: GameState = {
        ...state,
        investigatedSources,
        revealedEvidence: revealed,
        scenarioPhase: scenarioPhaseFor({
          investigatedSources,
          difficulty: state.difficulty,
        }),
        incidentDeadline: nextDeadline,
        metrics,
        minHealth: Math.min(state.minHealth, metrics.health),
        minTrust: Math.min(state.minTrust, metrics.trust),
        infra,
        pendingOpenResponse: null,
      };

      // Investigation can itself exhaust the timer.
      if (nextDeadline <= action.now || metrics.health <= 0 || metrics.trust <= 0) {
        return resolveIncident({
          state: next,
          incident,
          action: null,
          outcome: incident.timeout,
          timedOut: true,
          now: action.now,
          responseMode: 'timeout',
        });
      }
      return next;
    }

    case 'TICK': {
      if (state.phase !== 'incident' && state.phase !== 'result') return state;
      const config = DIFFICULTIES[state.difficulty];
      const incident = state.phase === 'incident' ? currentIncident(state) : null;
      const shiftElapsedSec = Math.max(0, (action.now - state.shiftStartedAt) / 1000);
      const rawDt = Math.max(0, shiftElapsedSec - state.shiftElapsedSec);
      const dt = Math.min(rawDt, MAX_DRAIN_DT_SEC);

      let downtimeSec = state.downtimeSec;
      let metrics = state.metrics;

      if (incident && dt > 0) {
        const mult = config.consequenceMult;
        const revenueBleed = (incident.revenueLossPerMin / 60) * dt * mult;
        metrics = {
          ...metrics,
          health: clamp(metrics.health - incident.healthDrainPerSec * dt * mult, 0, 100),
          trust: clamp(metrics.trust - incident.trustDrainPerSec * dt * mult, 0, 100),
          revenue: metrics.revenue - revenueBleed,
          revenueLost: metrics.revenueLost + revenueBleed,
        };
        if (incident.severity === 'SEV1') downtimeSec += dt;
      }

      // Uptime is measured against at least a 10-minute window so a few
      // seconds of SEV1 at the start of a shift doesn't read as 0%.
      const uptimePct = clamp(100 * (1 - downtimeSec / Math.max(shiftElapsedSec, 600)), 0, 100);

      // Sample health/trust for the trend sparklines every ~2 seconds.
      const sample = Math.floor(shiftElapsedSec / 2) > Math.floor(state.shiftElapsedSec / 2);
      const healthHistory = sample
        ? [...state.healthHistory, metrics.health].slice(-200)
        : state.healthHistory;
      const trustHistory = sample
        ? [...state.trustHistory, metrics.trust].slice(-200)
        : state.trustHistory;

      const next: GameState = {
        ...state,
        shiftElapsedSec,
        downtimeSec,
        metrics,
        minHealth: Math.min(state.minHealth, metrics.health),
        minTrust: Math.min(state.minTrust, metrics.trust),
        infra: stepInfra(state.infra, incident, uptimePct),
        healthHistory,
        trustHistory,
      };

      if (!incident) return next;

      // Drains collapsed a core metric — the incident overwhelms the shift.
      if (metrics.health <= 0 || metrics.trust <= 0) {
        return resolveIncident({
          state: next,
          incident,
          action: null,
          outcome: incident.timeout,
          timedOut: true,
          now: action.now,
          responseMode: 'timeout',
        });
      }

      // Countdown expired — the timeout consequence applies automatically.
      if (state.incidentDeadline !== null && action.now >= state.incidentDeadline) {
        return resolveIncident({
          state: next,
          incident,
          action: null,
          outcome: incident.timeout,
          timedOut: true,
          now: action.now,
          responseMode: 'timeout',
        });
      }

      return next;
    }

    case 'CHOOSE': {
      if (state.phase !== 'incident') return state;
      const incident = currentIncident(state);
      if (!incident) return state;
      const config = DIFFICULTIES[state.difficulty];
      if (state.investigatedSources.length < config.minInvestigationsBeforeActions) return state;
      const chosen = incident.actions.find((a) => a.id === action.actionId);
      if (!chosen) return state;
      const outcome =
        action.roll <= chosen.successChance || !chosen.failure ? chosen.success : chosen.failure;
      return resolveIncident({
        state,
        incident,
        action: chosen,
        outcome,
        timedOut: false,
        now: action.now,
        responseMode: 'choice',
      });
    }

    case 'SUBMIT_OPEN': {
      if (state.phase !== 'incident') return state;
      const incident = currentIncident(state);
      if (!incident) return state;
      const config = DIFFICULTIES[state.difficulty];
      if (!config.allowOpenResponse) return state;

      const grade = action.grade;
      if (grade.needsClarification) {
        return {
          ...state,
          pendingOpenResponse: {
            rawText: grade.rawText,
            interpreted: grade.interpreted,
            explanation: grade.explanation,
            confidence: grade.confidence,
            suggestedActionIds: grade.suggestedActionIds,
            clarificationPrompt: grade.clarificationPrompt,
          },
        };
      }

      // Prefer mapping to a known action outcome when confidence is strong and a
      // preferred action exists; otherwise use the rubric-produced effects.
      let mapped: IncidentAction | null = null;
      if (grade.suggestedActionIds[0] && grade.confidence >= 0.6 && grade.quality === 'success') {
        mapped = incident.actions.find((a) => a.id === grade.suggestedActionIds[0]) ?? null;
      }

      const outcome: Outcome = mapped
        ? mapped.success
        : {
            quality: grade.quality,
            score: grade.score,
            effects: grade.effects,
            explanation: `${grade.interpreted} ${grade.explanation}`,
          };

      return resolveIncident({
        state: { ...state, pendingOpenResponse: null },
        incident,
        action: mapped,
        outcome,
        timedOut: false,
        now: action.now,
        responseMode: 'open',
        actionLabelOverride: mapped?.label ?? `Open response: ${grade.rawText.slice(0, 72)}`,
        riskOverride: grade.risk,
        focusOverride: grade.focus,
        openTimeCostMin: mapped?.timeCostMin ?? 6,
      });
    }

    case 'CONTINUE': {
      if (state.phase !== 'result') return state;
      const config = DIFFICULTIES[state.difficulty];

      if (state.gameOverReason !== null || state.index + 1 >= state.queue.length) {
        return { ...state, phase: 'over', shiftElapsedSec: (action.now - state.shiftStartedAt) / 1000 };
      }

      const metrics: Metrics = {
        ...state.metrics,
        health: clamp(state.metrics.health + config.recoveryHealth, 0, 100),
        trust: clamp(state.metrics.trust + config.recoveryTrust, 0, 100),
        budget: state.metrics.budget + config.budgetAccrual,
      };

      return beginIncident(
        {
          ...state,
          index: state.index + 1,
          metrics,
        },
        action.now,
      );
    }

    case 'RESET':
      return initialState(state.difficulty);

    default:
      return state;
  }
}

export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
