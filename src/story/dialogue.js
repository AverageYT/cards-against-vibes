import { DIALOGUE_LINES, HABIT_LINES } from '../data/dialogue.js';
import { BUCKETS, LEARNER_TUNING } from '../data/aiTuning.js';

export const DIALOGUE_COOLDOWNS = Object.freeze({ globalMs: 1800, categoryMs: 7000 });

/** Only the learner's public-draw distribution and observation count are used. */
export function detectedHabit(summary) {
  const observations = summary?.totalObservations;
  const probs = summary?.drawBucketProbs;
  if (!Number.isInteger(observations) || observations < LEARNER_TUNING.patternMinObservations || !probs) return null;
  let best = null;
  for (const bucket of BUCKETS) {
    const value = probs[bucket];
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    if (!best || value > best.probability) best = { bucket, probability: value };
  }
  return best.probability >= LEARNER_TUNING.patternMinProbability ? best.bucket : null;
}

/** Timer-free dialogue state. Suppressed events are consumed, not queued. */
export function createDialogueEngine({ globalMs = DIALOGUE_COOLDOWNS.globalMs, categoryMs = DIALOGUE_COOLDOWNS.categoryMs } = {}) {
  let muted = false, current = null, lastLine = null, globalAt = -Infinity;
  let categoryAt = new Map(), seen = new Set();
  return {
    emit(event, now) {
      if (!event || typeof event.id !== 'string' || seen.has(event.id)) return null;
      seen.add(event.id);
      const lines = event.type === 'HABIT' ? HABIT_LINES[detectedHabit(event.habit)] : DIALOGUE_LINES[event.type];
      if (muted || !lines || !Number.isFinite(now) || now - globalAt < globalMs || now - (categoryAt.get(event.type) ?? -Infinity) < categoryMs) return null;
      const line = lines.find(value => value !== lastLine);
      if (!line) return null;
      current = { type: event.type, text: line };
      lastLine = line; globalAt = now; categoryAt.set(event.type, now);
      return current;
    },
    skip() { current = null; },
    setMuted(value) { muted = Boolean(value); if (muted) current = null; },
    get muted() { return muted; },
    get current() { return current; },
    reset() { current = null; lastLine = null; globalAt = -Infinity; categoryAt = new Map(); seen = new Set(); },
  };
}

/** Reduce snapshots to legal, explicitly enumerated event facts. */
export function dialogueEvents(snapshot, habit) {
  const events = [];
  if (!snapshot) return events;
  const encounter = snapshot.encounterCounter ?? 0;
  const view = snapshot.view;
  if (snapshot.screen === 'DUEL' && view) {
    if (encounter === 0) events.push({ id: 'first-deal', type: 'FIRST_DEAL' });
    if (view.finalCall?.active) events.push({ id: `final:${encounter}:${view.offerId}`, type: 'FINAL_CALL' });
    const res = view.lastResolution;
    if (res && snapshot.activeSpotlight) {
      const key = `${encounter}:${res.turnNumber}:${res.offerId}`;
      if (res.drawer === 'PLAYER' && res.drewUnlisted) events.push({ id: `unlisted:${key}`, type: 'UNLISTED' });
      if (res.drawer === 'PLAYER' && res.matchedSymbolId && res.turnNumber <= 4) events.push({ id: `success:${key}`, type: 'EARLY_SUCCESS' });
      if (res.drawer === 'PLAYER' && detectedHabit(habit)) events.push({ id: `habit:${key}`, type: 'HABIT', habit });
    }
  }
  if (snapshot.screen === 'STOP_RESULT' && snapshot.lastStopSummary) {
    events.push({ id: `duel:${encounter}`, type: snapshot.lastStopSummary.won ? 'DUEL_WIN' : 'DUEL_LOSS' });
  }
  if (snapshot.screen === 'REWARD') events.push({ id: `reward:${snapshot.stopIndex}`, type: 'REWARD' });
  if (snapshot.screen === 'RUN_OVER') events.push({ id: `run:${snapshot.runOutcome}`, type: snapshot.runOutcome === 'VICTORY' ? 'RUN_WIN' : 'RUN_LOSS' });
  return events;
}
