/** Narrative only. No optional text contains rules required to play. */
export const INTRO = Object.freeze([
  'The last train arrives without a destination on its board. You board anyway; your name has been crossed out in the passenger book.',
  'Across the table, the Inspector lays out a fan of tickets. Behind his hood there is only dark. “A place must be accounted for,” he says.'
]);

export const ARRIVAL_NOTES = Object.freeze([
  'Alder Halt is empty. A station clock keeps time for a train that never appears on its face.',
  'At Mirebridge, luggage waits on the platform, each tag turned carefully away from the rain.',
  'Northfen’s dining room is set for passengers whose names have been rubbed from the reservation book.',
  'The sleepers at Holloway have their curtains drawn. No one answers when the guard calls the stop.',
  'At the terminus, the platform lamps illuminate a single line in the ledger: DUTY CONTINUES.'
]);

export const INSPECTABLE_ITEMS = Object.freeze([
  Object.freeze({ id: 'manifest', name: 'Brass Manifest Clipboard', text: 'A brass clip holds a manifest of names. Each crossed-out entry has a second, neat line beneath it: accounted for.' }),
  Object.freeze({ id: 'timetable', name: 'Water-Stained Timetable', text: 'Every station is marked as a departure. The arrival column has been left blank, as if the journey itself were the destination.' }),
  Object.freeze({ id: 'tag', name: 'Unclaimed Luggage Tag', text: 'A tag bears no passenger name, only a punched circle. Someone has tied it to the luggage rack rather than throw it away.' }),
  Object.freeze({ id: 'ledger', name: 'Guard’s Punch Ledger', text: 'The last guard signed the duty column, not the passenger column. The same hand signs every page that follows.' })
]);

export const ENDINGS = Object.freeze({
  VICTORY: Object.freeze([
    'The last pair clears. The Inspector holds the blank ticket as the doors open on the quiet platform.',
    'You step down. He cannot follow as a passenger: his name is written in the duty column, and the ledger still needs an Inspector. He bows, then returns to the train.'
  ]),
  DEFEAT: Object.freeze([
    'Your last lantern goes out. The blank ticket is yours as the train pulls away from the platform.',
    'The Inspector stays aboard, not because he has escaped, but because he is the one keeping the ledger. His name is in the duty column; the unaccounted passenger is you.'
  ])
});
