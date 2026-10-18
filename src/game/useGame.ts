import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ACHIEVEMENTS } from '../data/achievements';
import { DIFFICULTIES } from '../data/difficulty';
import { INCIDENTS } from '../data/incidents';
import type { AchievementDef, DifficultyId } from '../types';
import { setSoundEnabled, sfx } from '../utils/sound';
import {
  loadAchievements,
  loadDifficulty,
  loadHighScore,
  loadSound,
  saveAchievements,
  saveDifficulty,
  saveHighScore,
  saveSound,
} from '../utils/storage';
import { defaultGrader } from './grader';
import { initialState, reducer, shuffle } from './engine';
import { isViteTestMode, mulberry32, readTestHooks } from './testHooks';

export interface Toast {
  id: string;
  title: string;
  description: string;
}

export function useGame() {
  const [state, dispatch] = useReducer(reducer, loadDifficulty(), initialState);
  const [highScore, setHighScore] = useState(loadHighScore);
  const [isNewHighScore, setIsNewHighScore] = useState(false);
  const [soundOn, setSoundOn] = useState(loadSound);
  const [unlocked, setUnlocked] = useState<string[]>(loadAchievements);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;
  const rollRef = useRef<() => number>(() => Math.random());

  useEffect(() => {
    setSoundEnabled(soundOn);
  }, [soundOn]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      saveSound(next);
      setSoundEnabled(next);
      if (next) sfx.click();
      return next;
    });
  }, []);

  const ticking = state.phase === 'incident' || state.phase === 'result';
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => dispatch({ type: 'TICK', now: Date.now() }), 250);
    return () => window.clearInterval(id);
  }, [ticking]);

  const start = useCallback((difficulty: DifficultyId, openResponsePreferred?: boolean) => {
    const config = DIFFICULTIES[difficulty];
    let queue = shuffle(INCIDENTS.map((i) => i.id)).slice(0, config.incidentCount);
    rollRef.current = () => Math.random();

    // Test-mode only — fixed queue + seeded rolls for Playwright.
    if (isViteTestMode()) {
      const hooks = readTestHooks();
      if (hooks?.queue?.length) {
        queue = hooks.queue.filter((id) => INCIDENTS.some((incident) => incident.id === id));
      }
      if (hooks?.seed != null) {
        rollRef.current = mulberry32(hooks.seed);
      }
    }

    saveDifficulty(difficulty);
    setIsNewHighScore(false);
    sfx.click();
    dispatch({
      type: 'START',
      difficulty,
      queue,
      now: Date.now(),
      openResponsePreferred: openResponsePreferred ?? config.allowOpenResponse,
    });
  }, []);

  const investigate = useCallback((sourceId: string) => {
    sfx.click();
    dispatch({ type: 'INVESTIGATE', sourceId, now: Date.now() });
  }, []);

  const choose = useCallback((actionId: string) => {
    dispatch({ type: 'CHOOSE', actionId, roll: rollRef.current(), now: Date.now() });
  }, []);

  const submitOpenResponse = useCallback(
    (text: string) => {
      const incidentId = state.queue[state.index];
      if (!incidentId) return;
      const grade = defaultGrader.grade(text, {
        incidentId,
        investigatedSourceIds: state.investigatedSources,
        difficulty: state.difficulty,
      });
      sfx.click();
      dispatch({ type: 'SUBMIT_OPEN', grade, now: Date.now() });
    },
    [state.queue, state.index, state.investigatedSources, state.difficulty],
  );

  const clearOpenPending = useCallback(() => {
    dispatch({ type: 'CLEAR_OPEN_PENDING' });
  }, []);

  const setOpenPreferred = useCallback((value: boolean) => {
    dispatch({ type: 'SET_OPEN_PREFERRED', value });
  }, []);

  const continueShift = useCallback(() => {
    sfx.click();
    dispatch({ type: 'CONTINUE', now: Date.now() });
  }, []);

  const goHome = useCallback(() => {
    sfx.click();
    dispatch({ type: 'RESET' });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.phase === 'incident') {
        const config = DIFFICULTIES[state.difficulty];
        if (state.investigatedSources.length < config.minInvestigationsBeforeActions) return;
        const num = Number.parseInt(event.key, 10);
        if (num >= 1 && num <= 4) {
          const incidentId = state.queue[state.index];
          const incident = INCIDENTS.find((i) => i.id === incidentId);
          const action = incident?.actions[num - 1];
          if (action) {
            event.preventDefault();
            choose(action.id);
          }
        }
      } else if (state.phase === 'result' && event.key === 'Enter') {
        if (document.activeElement instanceof HTMLButtonElement) return;
        if (document.activeElement instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        continueShift();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    state.phase,
    state.queue,
    state.index,
    state.difficulty,
    state.investigatedSources.length,
    choose,
    continueShift,
  ]);

  useEffect(() => {
    if (state.phase === 'incident') sfx.alert();
  }, [state.phase, state.index]);

  const lastResult = state.lastResult;
  useEffect(() => {
    if (!lastResult) return;
    if (lastResult.record.timedOut || lastResult.outcome.quality === 'failure') sfx.failure();
    else if (lastResult.outcome.quality === 'partial') sfx.partial();
    else sfx.success();
  }, [lastResult]);

  useEffect(() => {
    if (state.phase !== 'over') return;
    if (state.gameOverReason) sfx.gameOver();
    else sfx.success();
    setHighScore((prev) => {
      if (state.score > prev) {
        saveHighScore(state.score);
        setIsNewHighScore(true);
        return state.score;
      }
      return prev;
    });
  }, [state.phase, state.gameOverReason, state.score]);

  useEffect(() => {
    const scope: AchievementDef['scope'] | null =
      state.phase === 'result' ? 'decision' : state.phase === 'over' ? 'shift' : null;
    if (!scope) return;
    const config = DIFFICULTIES[state.difficulty];
    const fresh = ACHIEVEMENTS.filter(
      (a) => a.scope === scope && !unlockedRef.current.includes(a.id) && a.check(state, config),
    );
    if (fresh.length === 0) return;
    const nextUnlocked = [...unlockedRef.current, ...fresh.map((a) => a.id)];
    setUnlocked(nextUnlocked);
    saveAchievements(nextUnlocked);
    sfx.achievement();
    setToasts((prev) => [
      ...prev,
      ...fresh.map((a) => ({ id: a.id, title: a.title, description: a.description })),
    ]);
  }, [state]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return {
    state,
    highScore,
    isNewHighScore,
    soundOn,
    unlocked,
    toasts,
    start,
    investigate,
    choose,
    submitOpenResponse,
    clearOpenPending,
    setOpenPreferred,
    continueShift,
    goHome,
    toggleSound,
    dismissToast,
  };
}

export type Game = ReturnType<typeof useGame>;
