import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspectorMemory } from '../src/ai/learner.js';
import { createRunController } from '../src/core/run.js';
import { createDialogueEngine, dialogueEvents, detectedHabit } from '../src/story/dialogue.js';
import { INTRO, ENDINGS, ARRIVAL_NOTES, INSPECTABLE_ITEMS } from '../src/data/lore.js';

const summary = memory => ({ totalObservations: memory.getDetectedPattern().observations, drawBucketProbs: memory.getDrawBucketProbs() });

test('optional story has distinct advanceable opening, four objects, arrivals and both endings', () => {
  assert.ok(INTRO.length >= 2 && INTRO.every(Boolean));
  assert.equal(ARRIVAL_NOTES.length, 5);
  assert.equal(new Set(INSPECTABLE_ITEMS.map(x => x.id)).size, 4);
  assert.ok(INSPECTABLE_ITEMS.every(x => x.name && x.text));
  assert.ok(ENDINGS.VICTORY.length >= 2 && ENDINGS.DEFEAT.length >= 2);
  assert.notDeepEqual(ENDINGS.VICTORY, ENDINGS.DEFEAT);
});

test('dialogue engine responds to every category, enforces both cooldowns and avoids immediate repeats', () => {
  const engine = createDialogueEngine({ globalMs: 100, categoryMs: 300 });
  assert.ok(engine.emit({ id:'a', type:'FIRST_DEAL' }, 0));
  assert.equal(engine.emit({ id:'b', type:'UNLISTED' }, 50), null, 'global cooldown');
  assert.equal(engine.emit({ id:'c', type:'FIRST_DEAL' }, 100), null, 'category cooldown');
  const second = engine.emit({ id:'d', type:'FIRST_DEAL' }, 300);
  assert.ok(second); assert.notEqual(second.text, 'Welcome aboard. Shall we begin?');
  assert.equal(engine.emit({ id:'d', type:'FIRST_DEAL' }, 1000), null, 'event IDs are consumed once');
  let now = 1000, prev = second.text;
  for (const type of ['EARLY_SUCCESS','UNLISTED','FINAL_CALL','REWARD','DUEL_WIN','DUEL_LOSS','RUN_WIN','RUN_LOSS']) {
    const line = engine.emit({ id:type, type }, now); assert.ok(line, type); assert.notEqual(line.text, prev); prev = line.text; now += 1000;
  }
  engine.skip(); assert.equal(engine.current, null);
  engine.setMuted(true); assert.equal(engine.emit({ id:'muted', type:'RUN_WIN' }, now), null);
  engine.setMuted(false); assert.equal(engine.emit({ id:'muted', type:'RUN_WIN' }, now + 1000), null, 'muted events do not replay');
});

test('habit remarks require real learner thresholds and exclude forced draws', () => {
  const memory = createInspectorMemory();
  for (let i=0; i<10; i++) memory.recordPlayerDraw(0, 1, 1);
  assert.equal(detectedHabit(summary(memory)), null);
  for (let i=0; i<3; i++) memory.recordPlayerDraw(0, 5, 5);
  assert.equal(detectedHabit(summary(memory)), null);
  memory.recordPlayerDraw(0, 5, 5);
  assert.equal(detectedHabit(summary(memory)), 'LEFT_EDGE');
  const engine = createDialogueEngine();
  const line = engine.emit({ id:'habit', type:'HABIT', habit:summary(memory) }, 0);
  assert.match(line.text, /left/i);
  assert.doesNotMatch(line.text, /unlisted|ticket identity|slot #/i);
  assert.equal(detectedHabit({totalObservations:99,drawBucketProbs:{LEFT_EDGE:1}}), null, 'incomplete statistics rejected');
  const controller = createRunController({ immediate:true });
  assert.deepEqual(Object.keys(controller.getInspectorHabitSummary()).sort(), ['drawBucketProbs','totalObservations']);
  controller.dispose();
});

test('public event mapping covers required triggers without consulting hidden hands', () => {
  const base = {screen:'DUEL',encounterCounter:0,stopIndex:0,activeSpotlight:{},view:{offerId:7,finalCall:null,lastResolution:{turnNumber:2,offerId:6,drawer:'PLAYER',matchedSymbolId:'WATCH',drewUnlisted:false}}};
  const types = s => dialogueEvents(s,null).map(e=>e.type);
  assert.deepEqual(types(base), ['FIRST_DEAL','EARLY_SUCCESS']);
  assert.ok(types({...base,view:{...base.view,lastResolution:{...base.view.lastResolution,drewUnlisted:true,matchedSymbolId:null}}}).includes('UNLISTED'));
  assert.ok(types({...base,view:{...base.view,finalCall:{active:true,slotIndex:3}}}).includes('FINAL_CALL'));
  assert.deepEqual(types({screen:'REWARD',stopIndex:1}),['REWARD']);
  assert.deepEqual(types({screen:'STOP_RESULT',encounterCounter:1,lastStopSummary:{won:true}}),['DUEL_WIN']);
  assert.deepEqual(types({screen:'STOP_RESULT',encounterCounter:1,lastStopSummary:{won:false}}),['DUEL_LOSS']);
  assert.deepEqual(types({screen:'RUN_OVER',runOutcome:'VICTORY'}),['RUN_WIN']);
  assert.deepEqual(types({screen:'RUN_OVER',runOutcome:'DEFEAT'}),['RUN_LOSS']);
  const changed = {...base, view:{...base.view, myHand:[{ticket:{symbolId:'SECRET'}}], opponentSlots:[{revealedTicket:{symbolId:'OTHER SECRET'}}]}};
  assert.deepEqual(dialogueEvents(base,null),dialogueEvents(changed,null));
});

test('dialogue observation does not alter seeded run progression or outcomes', () => {
  function simulate(withDialogue, n) {
    const seed = `STORY-${n}`, c = createRunController({initialSeed:seed, immediate:true});
    const engine = createDialogueEngine(); let clock = 0;
    if (withDialogue) c.subscribe(s => {
      for (const e of dialogueEvents(s, c.getInspectorHabitSummary())) engine.emit(e, clock += 8000);
    });
    c.startRun({seed, withTutorial:false});
    for (let k=0;k<1000;k++) {
      const s=c.getSnapshot();
      if (s.screen === 'RUN_OVER') { const result={outcome:s.runOutcome,stats:s.runStats,history:s.stopHistory}; c.dispose(); return result; }
      if (s.screen === 'BRIEFING') c.beginStopDuel();
      else if (s.screen === 'DUEL') {
        if (s.view.legal.canCommit) c.commitOffer();
        else if (s.view.legal.canDraw) { const slots=s.view.legal.legalDrawSlots; c.drawSlot(slots[(n+k*3)%slots.length]); }
        else assert.fail('no legal action');
      } else if (s.screen === 'STOP_RESULT') c.continueAfterStop();
      else if (s.screen === 'REWARD') c.skipReward();
      else assert.fail(`unexpected ${s.screen}`);
    }
    assert.fail('run did not finish');
  }
  for (const n of [0,58]) assert.deepEqual(simulate(true,n),simulate(false,n));
});
