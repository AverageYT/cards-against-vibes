# RULES.md — *The Unlisted*

Canonical rules specification and ambiguity-resolution log for **The Unlisted**. One deterministic rules engine enforces these rules identically for both sides (`PLAYER` and `INSPECTOR`).

---

## 1. Premise & Objective

Aboard a midnight train making scheduled stops at empty stations, a ticket inspector challenges you across a fold-down carriage table. A deck of paired railway tickets plus one unmatchable ticket — **the Unlisted** (a damp blank ticket bearing a single black punch hole where the passenger's name belongs) — is dealt between both players.

Match and discard every ordinary ticket pair. As soon as **only the Unlisted remains**, the duel ends immediately and **whoever holds the Unlisted loses**.

---

## 2. Deck Composition & Card Conservation

- An encounter configured with pair count `P` (`6 <= P <= 12`) contains exactly `2P + 1` tickets:
  - `2P` **ordinary tickets** forming `P` matching pairs. Each ordinary `symbolId` appears **exactly twice**, and every card has a unique immutable `ticketId` (e.g., `LANTERN-A`, `LANTERN-B`).
  - `1` **Unlisted ticket** (`ticketId: "UNLISTED-0"`, `symbolId: "UNLISTED"`, `isUnlisted: true`). It never pairs with any ticket and is never discarded.
- **Ticket Symbols (12 canonical pairs)**:
  1. `LANTERN` — Signal Lantern *(Emblem Pair ★)*
  2. `WATCH` — Conductor's Watch *(Emblem Pair ★)*
  3. `KEY` — Sleeper Key *(Emblem Pair ★)*
  4. `BELL` — Platform Bell *(Emblem Pair ★)*
  5. `TRUNK` — Baggage Trunk
  6. `SEAL` — Manifest Seal
  7. `WHISTLE` — Brass Whistle
  8. `COMPASS` — Line Compass
  9. `TEACUP` — Dining Cup
  10. `UMBRELLA` — Rain Umbrella
  11. `COUPLER` — Iron Coupler
  12. `SIGNAL` — Semaphore Arm
- Encounters with `P < 12` use the first `P` symbols in canonical order, guaranteeing all four marked **Emblem Pairs (★)** are present in every standard duel (`P >= 6`).
- **Card Conservation Invariant**: In every legal state of a duel, the union of `player.hand`, `inspector.hand`, and `discardPile` contains the exact initial `2P + 1` unique `ticketId`s with no duplicates and no missing tickets. `discardPile` contains only complete ordinary pairs (even length; every discarded `symbolId` appears exactly twice; `UNLISTED-0` never appears in `discardPile`). No Stamp or Carriage Condition ever creates, duplicates, transforms, or deletes a ticket.

---

## 3. Seeded Randomness & Separation of Streams

A string run seed (user-supplied or auto-generated, shareable) is hashed deterministically into independent 32-bit PRNG streams (SplitMix32 seeding + Mulberry32 generator):

1. `runStream` — selects Carriage Conditions and Stamp reward offers for the run.
2. `shuffleStream` — derived per encounter (including Final Inspection rematches); performs the Fisher–Yates deck shuffle and any deterministic encounter setup.
3. `aiStream` — derived independently for Inspector decisions; never touches or observes `shuffleStream`.
4. `visualStream` — cosmetic-only variation (rain streaks, wood grain, dust); never affects game state.

Every duel is 100% replayable from `{ encounterSeed, duelConfig }` plus the ordered list of legal `Action` objects.

---

## 4. Duel Setup

1. Build the canonical `2P + 1` deck for the encounter's pair count `P`.
2. Shuffle the deck with the encounter's `shuffleStream`.
3. Determine starting roles (`offerer` and `drawer`), alternating across encounters in a run (see Decision D1).
4. Deal the entire deck one ticket at a time, alternating between sides starting with the initial `offerer` (who receives `P + 1` tickets; the initial `drawer` receives `P` tickets).
5. **Initial Pair Discard**: Scan each hand from left to right. Whenever two tickets share an ordinary `symbolId`, move both to `discardPile` while preserving the relative order of remaining tickets.
6. **Post-Deal End Check**: If only `UNLISTED-0` remains across both hands (all `P` pairs paired on the deal), the duel ends immediately (`phase = "DUEL_OVER"`); whoever holds `UNLISTED-0` loses.
7. Otherwise, initialize `turnNumber = 1`, `unlistedStreak = 0`, apply any opening Carriage Condition rules to `swapsRemaining`, and enter `OFFER_PHASE`.

> **Two-Player Hand-Parity Property**: After initial pair discard, if `m >= 1` ordinary pairs remain, neither hand holds a duplicate symbol. Each remaining pair has one ticket in each hand: the non-holder of `UNLISTED-0` holds exactly `m` tickets, and the holder of `UNLISTED-0` holds exactly `m + 1` tickets. Thus both hands are strictly non-empty on every active turn, and either hand reaching `0` coincides with only `UNLISTED-0` remaining.

---

## 5. Turn Structure

Each turn proceeds through two phases:

### Phase A — `OFFER_PHASE` (active side: `offerer`)

The offerer prepares the face-down fan from which the drawer will pick.

- Optional legal Offer-phase Stamp action (`USE_STAMP`), if owned, charged, unlocked, and legal.
- `SWAP { indexA, indexB }`: If `swapsRemaining > 0`, privately swap two distinct unlocked slots (`0 <= indexA, indexB < offerer.hand.length`, `indexA !== indexB`) and decrement `swapsRemaining` by `1`. Default `swapsRemaining` per offer is `1`.
- `COMMIT_OFFER`: Locks the offerer's fan order for this turn, applies any commit-time public slot exposures (e.g., *Drafty Window* or pending Stamp exposure penalties), and transitions to `DRAW_PHASE`. Committing without swapping is always legal.

### Phase B — `DRAW_PHASE` (active side: `drawer`)

The drawer selects one ticket from the offerer's committed face-down fan.

- Optional legal Draw-phase Stamp action (`USE_STAMP`), if owned, charged, unlocked, and legal.
- `DRAW { slotIndex }`: Select one legal (unlocked, in-bounds) slot in `offerer.hand`.
- **Resolution order**:
  1. Remove ticket `T` at `offerer.hand[slotIndex]` and append `T` to the right end of `drawer.hand`.
  2. If `T.isUnlisted` is `true`:
     - Increment `unlistedStreak` by `1`.
  3. If `T.isUnlisted` is `false`:
     - Find the matching ticket `M` in `drawer.hand` (`M.symbolId === T.symbolId`, `M.ticketId !== T.ticketId`).
     - If found, remove both `M` and `T` from `drawer.hand`, append `[M, T]` to `discardPile`, increment `playedPairsDiscarded`, reset `unlistedStreak` to `0`, and resolve any matching-pair Stamp triggers (e.g., *Carbon Copy*, *Bell Cord*).
  4. Clear all turn-scoped locks and slot reveals from the completed offer; if this turn was under **Final Call**, clear `finalCall` and ensure `unlistedStreak = 0`.
  5. Advance turn-based and pair-based Carriage Condition expiration counters.
  6. **End-of-Duel Check**: If the total number of tickets across both hands is `1` (only `UNLISTED-0` remains), set `phase = "DUEL_OVER"`, mark the holder of `UNLISTED-0` as `loser` and the other side as `winner`, and stop.
  7. **Role Switch**: Swap roles (`newOfferer = drawer`, `newDrawer = offerer`) and increment `turnNumber`.
  8. **Final Call Check**: If `unlistedStreak >= finalCallThreshold` (default `3`; `2` under *Short Whistle*), apply **Final Call** to `newOfferer` (Section 6).
  9. Compute `newOfferer.swapsRemaining` (default `1`; `0` if `forfeitNextSwap` is active or blocked by a Carriage Condition; consume the `forfeitNextSwap` flag) and enter `OFFER_PHASE`.

### Illegal & Duplicate Action Handling

Any action submitted out of phase, by the inactive side, after `DUEL_OVER`, with invalid/duplicate/locked slot indices, with an unavailable Stamp, or bearing a stale action sequence ID is rejected cleanly without mutating state. The UI additionally locks pointer/keyboard draw inputs while an action resolves and animates.

---

## 6. Final Call (Anti-Ping-Pong Rule)

- Whenever `UNLISTED-0` transfers hands `finalCallThreshold` times in a row (standard threshold: `3`), **Final Call** triggers on the incoming `OFFER_PHASE`.
- The slot holding `UNLISTED-0` in the offerer's hand is **publicly marked and locked** for the upcoming turn:
  - It cannot be swapped during `OFFER_PHASE`. (If the offerer holds `>= 3` tickets and has `swapsRemaining > 0`, they may still swap among their remaining unlocked slots.)
  - It cannot be chosen by `DRAW` during `DRAW_PHASE`, forcing the drawer to pick an ordinary ticket, form a pair, and break the streak.
  - At the end of that turn's draw, the Final Call lock clears and `unlistedStreak` resets to `0`.
- **Small-Hand Deadlock Guard**:
  - End-of-duel check always runs *before* Final Call, so a 1-ticket game (`[UNLISTED-0]` vs `[]`) ends immediately.
  - If Final Call is ever evaluated when locking `UNLISTED-0` would leave `0` legal drawable slots in `offerer.hand` (e.g., offerer has `< 2` tickets or all other slots are unavailable), Final Call is safely waived (`FINAL_CALL_WAIVED` event logged): the slot is not locked for drawing and `unlistedStreak` resets to `0`, guaranteeing at least one legal draw always exists.

---

## 7. Run Structure

A full run consists of **5 stops** (4 Carriages + Final Inspection):

| Stop | Encounter | Pairs (`P`) | Total Tickets | Carriage Condition | Target AI Tier |
| --- | --- | :---: | :---: | --- | :---: |
| 1 | Carriage I — Third-Class Coach | 6 | 13 | None (*Clear Line*) | Tier 1 |
| 2 | Carriage II — Luggage Van | 7 | 15 | 1 seeded condition | Tier 2 |
| 3 | Carriage III — Dining Car | 9 | 19 | 1 seeded condition | Tier 3 |
| 4 | Carriage IV — Sleeper Corridor | 10 | 21 | 1 seeded condition | Tier 4 *(Tier 3 fallback)* |
| 5 | Final Inspection — Guard's Brake | 12 | 25 | 1 seeded condition | Tier 5 *(Tier 3 fallback)* |

- **Lantern Charges**: Start with `3` charges (maximum `3`).
- **Winning Stops 1–4**: Keep current Lantern charges, visit the Stamp reward tray (choose 1 of 3 distinct unowned Stamps, replacing an existing Stamp if all 3 slots are full, or skip), inspect optional carriage lore, and advance to the next stop.
- **Losing Stops 1–4**: Spend `1` Lantern charge and receive **no** Stamp reward. If `lanterns >= 1`, advance to the next stop. If `lanterns === 0`, the run ends (**Defeat Ending**).
- **Final Inspection (Stop 5)**:
  - **Win**: Run succeeds (**Victory Ending**).
  - **Lose with `lanterns >= 1` remaining (after spending 1)**: Stay at Stop 5 for a **Final Inspection rematch** (fresh derived encounter seed, alternating first actor, per-carriage Stamp charges reset).
  - **Lose reaching `lanterns === 0`**: Run ends (**Defeat Ending**).
- **Tutorial**: A short, skippable interactive tutorial demonstrates matching/discarding a pair, offering/swapping a fan, and drawing the Unlisted before Stop 1.

---

## 8. Stamps (Player Modifiers)

The player holds up to **3 Stamp slots**. Per-carriage Stamp charges refresh at the start of every duel (including Final Inspection rematches). Stamps #1–6 are **MUST SHIP**; #7–8 are **SHOULD SHIP**.

1. **Inspection Window** *(MUST — Active, Draw Phase, 1/carriage, Inspection)*
   - **Effect**: Privately reveal 1 face-down unlocked slot in the Inspector's committed fan before drawing.
   - **Tradeoff**: Your next `OFFER_PHASE` forfeits its swap (`swapsRemaining = 0`).
2. **Carbon Copy** *(MUST — Passive, 1/carriage)*
   - **Effect**: When you discard a **Signal Lantern (`LANTERN`)** or **Conductor's Watch (`WATCH`)** Emblem Pair ★ during play, immediately restore 1 spent charge of an equipped Inspection Stamp (*Inspection Window* or *Manifest Loupe*).
   - **Tradeoff**: Occupies a Stamp slot and provides no benefit unless you also hold a spent Inspection Stamp and match one of those two marked pairs.
3. **Night Transfer** *(MUST — Active, Offer Phase, 1/carriage)*
   - **Effect**: Requires `offerer.hand.length >= 3`. Grants `+1` private swap on the current offer (clearing a forfeited swap back to `1`, or raising a normal offer to `2`).
   - **Tradeoff**: Cannot be used when your hand has fewer than `3` tickets; stamping it is publicly visible on the table.
4. **Spare Wick** *(MUST — Consumable, Active in Offer or Draw Phase)*
   - **Effect**: Requires `lanterns < 3`. Immediately restore `+1` Lantern charge (up to the max of `3`), then permanently remove *Spare Wick* from its Stamp slot.
   - **Tradeoff**: Provides zero in-duel advantage while carried and leaves an empty Stamp slot once spent.
5. **Manifest Loupe** *(MUST — Active, Draw Phase, 1/carriage, Inspection)*
   - **Effect**: Requires `>= 3` unlocked slots in the Inspector's committed fan. Choose two adjacent unlocked slots (`i` and `i + 1`); privately learn whether `UNLISTED-0` is in either of those two slots (`YES` or `NO`).
   - **Tradeoff**: On your next committed offer, your leftmost unlocked slot (`slot 0`) is publicly revealed face-up for that turn.
6. **Brass Weight** *(MUST — Active, Offer Phase, 1/carriage)*
   - **Effect**: Requires `offerer.hand.length >= 3` and at least `2` other drawable slots remaining. Lock `1` ordinary ticket in your hand so it cannot be drawn this turn (compressing the fan to increase the Inspector's odds of drawing your Unlisted).
   - **Tradeoff**: Cannot be placed on `UNLISTED-0`; on your next committed offer, your rightmost unlocked slot is publicly revealed face-up for that turn.
7. **Bell Cord** *(SHOULD — Triggered + Active, 1/carriage)*
   - **Effect**: Discarding a **Sleeper Key (`KEY`)** or **Platform Bell (`BELL`)** Emblem Pair ★ grants a *Signal Token* (max 1 per carriage). Spend it during your `DRAW_PHASE` (when Inspector offers `>= 3` unlocked slots) to publicly mark one slot holding an Emblem ticket (or confirm none are present).
   - **Tradeoff**: Spending the *Signal Token* forfeits your next `OFFER_PHASE` swap; provides no benefit until `KEY` or `BELL` is paired during play.
8. **Last-Stop Punch** *(SHOULD — Active, Draw Phase, 1/carriage)*
   - **Effect**: Requires `unlistedStreak >= 1` and `>= 3` unlocked slots in the Inspector's fan. Immediately increase `unlistedStreak` by `+1` before drawing (allowing an Unlisted draw to trigger Final Call one step early to shield your incoming offer).
   - **Tradeoff**: If your draw matches an ordinary pair instead, `unlistedStreak` resets to `0` as normal and your next committed offer publicly reveals your leftmost unlocked slot.

### Example Stamp Synergies

- **Inspection Window + Carbon Copy**: Spend *Inspection Window* early to deliberately confirm or preserve a draw when hunting `LANTERN`/`WATCH`, refreshing *Inspection Window* for a second decisive peek in the late duel.
- **Inspection Window + Night Transfer**: Inspect safely without leaving your Unlisted pinned in a predictable slot on the following offer (as long as you hold `>= 3` tickets).
- **Manifest Loupe + Carbon Copy + Brass Weight**: High-information, high-exposure play — sweep two slots at a time with *Loupe*, refresh it off `LANTERN`/`WATCH`, and compress your own fan with *Brass Weight* to force the Unlisted onto the Inspector before public exposure penalties matter.

---

## 9. Carriage Conditions

Conditions apply symmetrically to both sides, are explained on the carriage briefing card before Turn 1, and display their live status and exact expiration condition on the table. Conditions #1–3 are **MUST SHIP**; #4 is **SHOULD SHIP**.

1. **Sealed Manifest** *(MUST)*: Neither side may swap on their opening offer (`Turns 1–2`; swap-granting Stamps are also paused during `Turns 1–2`). **Expires**: at the start of Turn 3.
2. **Drafty Window** *(MUST)*: During `Turns 1–4`, whenever either side commits a fan of `3` or more tickets, their leftmost unlocked slot (`slot 0`) is publicly revealed face-up for that draw. **Expires**: at the start of Turn 5.
3. **Late Schedule** *(MUST)*: Active Stamps cannot be used until `K` pairs have been discarded during play, where `K = min(3, max(1, initialRemainingPairs - 1))`. **Expires**: immediately once `playedPairsDiscarded >= K` (displaying remaining pairs needed).
4. **Short Whistle** *(SHOULD)*: Final Call triggers after `2` consecutive Unlisted transfers instead of `3` (`finalCallThreshold = 2`). **Expires**: at the end of the carriage duel.

---

## 10. Inspector AI, Information Boundary & Learning

- **Strict Legal Knowledge (`ObserverView`)**: The Inspector receives only its own hand, the player's slot count, public discards, active conditions and expirations, equipped Stamps, public marks/reveals, private reveals addressed to `INSPECTOR`, legal actions, and observed public action history. It never receives the player's hidden slot-to-ticket mapping, deck order, or `shuffleStream`.
- **Positional Habit Learning**:
  - Each unforced player draw (`legalDrawSlots.length >= 2`) from a hand of size `N` at `slotIndex` is mapped via normalized coordinate `u = slotIndex / (N - 1)` into five symmetric buckets spanning edges, middles, and center:
    - `LEFT_EDGE`: `u < 0.20`
    - `LEFT_MID`: `0.20 <= u < 0.40`
    - `CENTER`: `0.40 <= u <= 0.60`
    - `RIGHT_MID`: `0.60 < u <= 0.80`
    - `RIGHT_EDGE`: `u > 0.80`
  - Before recording a new observation, existing bucket counts are multiplied by decay factor `gamma` (default `0.82`), then the chosen bucket increments by `+1.0`. Bucket probabilities use symmetric Dirichlet smoothing (`alpha = 0.6` per bucket) so sparse early data stays close to uniform and habit changes naturally overtake stale patterns.
  - All learned counts reset to zero at the start of a new run.
- **Reveal Memory**: Any ticket revealed to the Inspector (e.g., via *Drafty Window* or a player Stamp exposure penalty) is remembered only for the specific committed offer on which it was revealed and cleared immediately when that turn resolves.
- **Tier Ramp**:
  - **Tier 1**: Mostly uniform legal draws, occasional random swap bluff, logs player draws without exploiting them yet.
  - **Tier 2**: Always uses valid slot reveals (picks known pairs, avoids known Unlisted), tracks hand-count parity (knows who holds `UNLISTED-0`), and varies Unlisted placement across offers.
  - **Tier 3**: Places `UNLISTED-0` toward the player's highest-probability learned draw buckets when offering (sampled via temperature-controlled weighting).
  - **Tier 4** *(SHOULD)*: Accounts for active Carriage Conditions (e.g., avoids leaving `UNLISTED-0` in a *Drafty Window* exposed slot unless baiting/avoiding strategically, adjusts around *Sealed Manifest* right-edge arrival and *Short Whistle* streak thresholds) and sharpens play at small hand sizes (`<= 4`).
  - **Tier 5** *(SHOULD)*: Evaluates plausible hidden configurations consistent with public reveals and unshuffled right-edge arrivals, weighs immediate draw risk against next-turn offer/Final Call states, responds faster to recent player streaks, and retains a small exploration rate (`~10%`) so he remains beatable.
- **Decision Trace & Dialogue**: Every AI decision emits a developer-only trace showing observed facts, bucket probabilities, candidate weights, and chosen action. Optional flavor remarks about player tendencies trigger only when a bucket measurably exceeds uniform baseline with sufficient observations, observe cooldowns, and never leak hidden cards.

---

## 11. Decisions (Resolved Ambiguities)

- **D1 — First-action alternation & deal order**: Across encounters in a run (including Final Inspection rematches), first draw alternates starting with the Player in Stop 1 (Stop 1: Inspector offers, Player draws first; Stop 2: Player offers, Inspector draws first; etc.). Dealing alternates one card at a time starting with the initial offerer. Standalone duels can select either starting side explicitly.
- **D2 — Empty hands & instant post-deal end**: If automatic post-deal pair removal eliminates all `P` pairs so only `UNLISTED-0` remains, the duel ends immediately before Turn 1 and the holder of `UNLISTED-0` loses. During play, `totalRemainingTickets === 1` ends the duel immediately before role swap or Final Call.
- **D3 — Final Call lock & tiny-hand safety**: During Final Call, the slot holding `UNLISTED-0` is publicly marked and pinned against both swapping and drawing for one turn, then clears with `unlistedStreak = 0`. If locking it would leave `0` drawable slots (e.g., a 1-card offerer edge state), Final Call is waived and `unlistedStreak` resets to `0` so the game can never deadlock.
- **D4 — Private swap secrecy & arrival position**: Neither side sees which indices the opponent swapped during `OFFER_PHASE` (nor whether an ordinary optional swap was skipped). A drawn non-matching ticket (`UNLISTED-0`) enters at the right end of the drawer's hand; therefore, if the drawer's ensuing `OFFER_PHASE` cannot swap (e.g., *Sealed Manifest* or forfeited swap), a legal observer can deduce from public action history that `UNLISTED-0` remained at the rightmost slot.
- **D5 — Deal pairs vs. played pairs**: Pairs auto-discarded during initial dealing never trigger Stamp pair effects (*Carbon Copy*, *Bell Cord*) and do not count toward *Late Schedule*.
- **D6 — Reveal lifetime**: All slot reveals (*Inspection Window*, *Manifest Loupe*, *Drafty Window*, Stamp penalty exposures) last strictly for the single committed `DRAW_PHASE` in which they apply and expire once that draw resolves.
- **D7 — Forced draws ignored by learner**: When the player has only `1` legal drawable slot (e.g., a 2-ticket fan under Final Call), the observation is skipped by the positional learner because no choice existed.
- **D8 — Overlapping public exposures & locks**: If two effects expose the same slot publicly on the same offer (e.g., *Drafty Window* and *Manifest Loupe* penalty both exposing `slot 0`), only that single slot is revealed. Publicly revealed slots remain legally drawable unless also locked by Final Call or *Brass Weight*. *Brass Weight* can never be activated if fewer than `2` drawable slots would remain.
- **D9 — Stamp uniqueness & replacement**: A run never offers a Stamp the player already holds. With 3 full slots, taking a reward requires replacing one held Stamp; skipping is always legal. *Spare Wick* activates manually during the player's turn when `lanterns < 3` and does not auto-trigger after dropping to `0` lanterns.
- **D10 — Late Schedule scaling on tiny post-deal hands**: If initial deal luck removes most pairs leaving `initialRemainingPairs <= 3`, *Late Schedule* lowers its unlock requirement to `max(1, initialRemainingPairs - 1)` so Stamps are never permanently locked for the entire duel unless only 1 pair survived the deal.
