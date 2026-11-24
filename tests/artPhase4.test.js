import test from 'node:test';
import assert from 'node:assert/strict';
import { describeInspectorSprite, describeLayout } from '../src/visuals/scene.js';

test('Inspector is an enclosing cloak with a continuous featureless opening', () => {
  for (const breathing of [false, true]) {
    for (const headTilt of [-1, 0, 1]) {
      const sprite = describeInspectorSprite({ breathing, headTilt });
      assert.equal(sprite.width, 104);
      assert.equal(sprite.height, 70);
      assert.ok(sprite.runs.every((run) => ['k', 'c', 'C', 'h', 'H', 'v'].includes(run.key)), 'cloth and void only, no skin, eyes or hands');
      const voidRuns = sprite.runs.filter((run) => run.key === 'v');
      assert.ok(voidRuns.length >= 20, 'opening spans the hood');
      assert.equal(new Set(voidRuns.map((run) => run.y)).size, voidRuns.length, 'each opening row is one continuous black run');
      assert.ok(Math.max(...voidRuns.map((run) => run.w)) >= 19, 'opening is legible at source resolution');
      const body = sprite.runs.filter((run) => run.y === 38 + Number(breathing));
      const width = Math.max(...body.map((run) => run.x + run.w)) - Math.min(...body.map((run) => run.x));
      assert.ok(width >= 80, 'broad shoulders enclose the body');
      assert.ok(sprite.runs.some((run) => run.y >= 68), 'lower folds continue behind the table');
    }
  }
});

test('scene layout still leaves room for the far fan in both framings', () => {
  for (const framing of ['wide', 'portrait']) {
    const layout = describeLayout({ framing });
    assert.ok(layout.checks.every((check) => check.pass), `${framing}: ${JSON.stringify(layout.checks.filter((c) => !c.pass))}`);
  }
});

test('hood is painted black after scene effects in every mood and post mode', async () => {
  const { drawScene } = await import('../src/visuals/scene.js');
  for (const mood of ['warm', 'neutral', 'cold']) {
    for (const post of [false, true]) {
      for (const time of [0, 2.5, 8]) {
        const calls = [];
        const ctx = {
          fillStyle: '', globalAlpha: 1,
          save() {}, restore() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {},
          closePath() {}, ellipse() {}, rect() {}, clip() {}, fill() {}, drawImage() {},
          fillRect(x, y, w, h) { calls.push({ color: this.fillStyle, x, y, w, h }); },
          createLinearGradient: () => ({ addColorStop() {} }),
          createRadialGradient: () => ({ addColorStop() {} }),
          getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
          putImageData() {},
        };
        drawScene(ctx, { mood, post, time });
        const rows = describeInspectorSprite().runs.filter((run) => run.key === 'v').length;
        const last = calls.slice(-rows);
        assert.equal(last.length, rows);
        assert.ok(last.every((call) => call.color === '#000000' && call.h === 1), `${mood} post=${post} time=${time}`);
      }
    }
  }
});
