import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketArtSymbol } from '../src/ui/appView.js';
import { TICKET_SYMBOLS, getTicketMeta } from '../src/data/tickets.js';
import { cachedTicketFace, cachedTicketBack } from '../src/visuals/tickets.js';
import { FIXTURES } from '../src/visuals/fixtures.js';
import { sceneTransform, projectFramePoint } from '../src/visuals/layout.js';

test('visible ticket metadata selects the matching art, not the Unlisted', () => {
  for (const symbol of TICKET_SYMBOLS) {
    assert.equal(ticketArtSymbol(getTicketMeta(symbol.id)), symbol.id);
    assert.notEqual(cachedTicketFace(symbol.id), cachedTicketFace('UNLISTED'));
  }
  assert.equal(ticketArtSymbol({ isUnlisted: true }), 'UNLISTED');
  assert.equal(ticketArtSymbol(null), '');
  assert.equal(cachedTicketBack(), cachedTicketBack());
});

test('fixture points use the same contained scene transform as the renderer', () => {
  const frame = sceneTransform(1280, 800);
  assert.equal(frame.offsetY, 40);
  const point = projectFramePoint(frame, FIXTURES.strip.x, FIXTURES.strip.y);
  assert.equal(point.left, 928);
  assert.equal(point.top, 188);
});
