import test from 'node:test';
import assert from 'node:assert/strict';
import { createInspectorMotion, inspectorEase, INSPECTOR_KEYFRAMES } from '../src/visuals/inspectorMotion.js';

test('pose keyframes ease to a soft landing, with modest distinct actions', () => {
  assert.ok(Math.abs(inspectorEase(0.5) - 0.5) < 0.00001);
  assert.ok(inspectorEase(0.25) < 0.25);
  for (const pose of ['offer', 'draw', 'react']) {
    const motion = createInspectorMotion({ now: () => 0 });
    assert.equal(motion.trigger(pose, 0), true);
    const keys = INSPECTOR_KEYFRAMES[pose];
    assert.equal(motion.sample(keys[1].at).pose, pose);
    assert.ok(Math.abs(motion.sample(keys[1].at).y - keys[1].y) < 0.001);
    assert.deepEqual(motion.sample(keys.at(-1).at), { y: 0, sleeve: 0, pose: 'idle' });
  }
  assert.ok(INSPECTOR_KEYFRAMES.react[1].y < 0);
  assert.ok(INSPECTOR_KEYFRAMES.draw[1].sleeve > 0);
});

test('interruptions start at the current pose and reduced motion is immediately still', () => {
  const motion = createInspectorMotion({ now: () => 0 });
  motion.trigger('react', 0);
  const before = motion.sample(70);
  motion.trigger('draw', 70);
  const after = motion.sample(70);
  assert.ok(Math.abs(before.y - after.y) < 0.001);
  assert.ok(Math.abs(before.sleeve - after.sleeve) < 0.001);
  motion.setReducedMotion(true);
  assert.deepEqual(motion.sample(90), { y: 0, sleeve: 0, pose: 'idle' });
  assert.equal(motion.trigger('offer', 90), false);
  motion.setReducedMotion(false);
  assert.equal(motion.sample(100).pose, 'idle');
  motion.trigger('offer', 100);
  motion.reset();
  assert.equal(motion.sample(101).pose, 'idle');
});
