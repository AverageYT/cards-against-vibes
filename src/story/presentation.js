/** Narrative presentation only: observes the existing run, never acts on it. */
import { INTRO, ARRIVAL_NOTES, INSPECTABLE_ITEMS, ENDINGS } from '../data/lore.js';
import { createDialogueEngine, dialogueEvents } from './dialogue.js';

export function mountStory({ doc, controller, now = () => performance.now() }) {
  if (!doc || !controller) return null;
  const byId = id => doc.getElementById(id);
  const intro = byId('story-intro'), introText = byId('story-intro-text'), introNext = byId('story-intro-next'), introSkip = byId('story-intro-skip');
  const ending = byId('story-ending'), endingText = byId('story-ending-text'), endingNext = byId('story-ending-next'), endingSkip = byId('story-ending-skip');
  const arrival = byId('story-arrival'), items = byId('story-items');
  const dialogue = byId('inspector-dialogue'), mute = byId('dialogue-mute'), skip = byId('dialogue-skip');
  const engine = createDialogueEngine();
  const listeners = [];
  let introIndex = 0, endingIndex = 0, endingOutcome = null, previousScreen = null;
  function listen(node, type, fn) { if (!node) return; node.addEventListener(type, fn); listeners.push(() => node.removeEventListener(type, fn)); }
  function storyPage(box, text, next, pages, index) {
    if (!box || !text || !next) return;
    box.classList.toggle('hidden', index >= pages.length);
    if (index < pages.length) { text.textContent = pages[index]; next.textContent = index === pages.length - 1 ? 'Close' : 'Next'; }
  }
  function showIntro() { storyPage(intro, introText, introNext, INTRO, introIndex); }
  function showEnding() { storyPage(ending, endingText, endingNext, ENDINGS[endingOutcome] || [], endingIndex); }
  function focusAfterStory(id) { const target = byId(id); if (target && typeof target.focus === 'function') target.focus(); }
  listen(introNext, 'click', () => { introIndex += 1; showIntro(); if (introIndex >= INTRO.length) focusAfterStory('title-primary-btn'); });
  listen(introSkip, 'click', () => { introIndex = INTRO.length; showIntro(); focusAfterStory('title-primary-btn'); });
  listen(endingNext, 'click', () => { endingIndex += 1; showEnding(); if (endingIndex >= (ENDINGS[endingOutcome] || []).length) focusAfterStory('run-over-locker-btn'); });
  listen(endingSkip, 'click', () => { endingIndex = (ENDINGS[endingOutcome] || []).length; showEnding(); focusAfterStory('run-over-locker-btn'); });
  if (items) for (const item of INSPECTABLE_ITEMS) {
    const detail = doc.createElement('details'), summary = doc.createElement('summary'), text = doc.createElement('p');
    summary.textContent = item.name; text.textContent = item.text;
    detail.appendChild(summary); detail.appendChild(text); items.appendChild(detail);
  }
  function renderDialogue() {
    if (dialogue) { dialogue.textContent = engine.current ? `Inspector: “${engine.current.text}”` : ''; dialogue.classList.toggle('is-empty', !engine.current); }
    if (mute) { mute.textContent = engine.muted ? 'Talk off' : 'Talk'; mute.setAttribute('aria-label', 'Mute Inspector remarks'); mute.setAttribute('aria-pressed', String(engine.muted)); }
    if (skip) skip.disabled = !engine.current;
  }
  listen(mute, 'click', () => { engine.setMuted(!engine.muted); renderDialogue(); });
  listen(skip, 'click', () => { engine.skip(); renderDialogue(); });
  showIntro(); showEnding(); renderDialogue();
  const unsubscribe = controller.subscribe(snap => {
    if ((snap.screen === 'BRIEFING' && snap.encounterCounter === 0 && previousScreen !== 'BRIEFING') || (snap.screen === 'TUTORIAL' && previousScreen !== 'TUTORIAL')) engine.reset();
    if (snap.screen === 'TITLE' && previousScreen && previousScreen !== 'TITLE') { introIndex = 0; showIntro(); engine.reset(); }
    if (snap.screen !== previousScreen) { engine.skip(); }
    if (arrival && snap.screen === 'BRIEFING') arrival.textContent = ARRIVAL_NOTES[snap.stopIndex] || '';
    if (snap.screen === 'RUN_OVER' && (previousScreen !== 'RUN_OVER' || snap.runOutcome !== endingOutcome)) { endingOutcome = snap.runOutcome; endingIndex = 0; showEnding(); }
    // This summary contains only aggregate legally observed player draws.
    const habit = snap.screen === 'DUEL' && controller.getInspectorHabitSummary
      ? controller.getInspectorHabitSummary() : null;
    for (const event of dialogueEvents(snap, habit)) if (engine.emit(event, now())) break;
    previousScreen = snap.screen;
    renderDialogue();
  });
  return { dispose() { unsubscribe(); for (const remove of listeners) remove(); }, engine };
}
