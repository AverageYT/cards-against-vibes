/** Public-event dialogue. No line claims knowledge of a hidden ticket. */
export const DIALOGUE_LINES = Object.freeze({
  FIRST_DEAL: ['Welcome aboard. Shall we begin?', 'Your seat is ready. Let us settle the manifest.'],
  EARLY_SUCCESS: ['A neat match. Well done.', 'A pair accounted for. My compliments.'],
  UNLISTED: ['Ah. The blank ticket has changed hands.', 'The unlisted passenger travels once more.'],
  FINAL_CALL: ['Final Call. The marked ticket must wait.', 'The bell has rung. Please choose an available ticket.'],
  REWARD: ['A Stamp for the next carriage, if you please.', 'Your choice of Stamp awaits.'],
  DUEL_WIN: ['That hand is yours. Very neatly played.', 'You have cleared your hand. My compliments.'],
  DUEL_LOSS: ['The hand is settled. We shall continue.', 'A difficult hand. There is still the journey.'],
  RUN_WIN: ['The platform is yours. Farewell, passenger.', 'You may step down. I must remain on duty.'],
  RUN_LOSS: ['I am sorry. The line continues without you.', 'The lamps are out. I will keep the ledger.'],
});

export const HABIT_LINES = Object.freeze({
  LEFT_EDGE: ['You often reach for the left edge.', 'The leftmost end has drawn your attention lately.'],
  LEFT_MID: ['You have favoured the left-middle tickets.', 'Your recent choices lean left of centre.'],
  CENTER: ['The centre seems to catch your eye.', 'You have often chosen near the middle.'],
  RIGHT_MID: ['You have favoured the right-middle tickets.', 'Your recent choices lean right of centre.'],
  RIGHT_EDGE: ['You often reach for the right edge.', 'The rightmost end has drawn your attention lately.'],
});
