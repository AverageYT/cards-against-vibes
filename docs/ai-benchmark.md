# Inspector AI Benchmark Report — *The Unlisted*

Reproduce anytime with plain Node (zero dependencies):

```bash
node tests/benchmark.js
```

---

## Methodology

- **Paired-seed design**: Every tier (`1` through `5`) faces the exact same derived shuffle seeds, encounter pair counts (`[6, 8, 10, 12]`), active conditions, and player-policy RNG streams (`seedPrefix = "BENCH-2026"`).
- **Sample size**: `300` independent runs × `4` consecutive alternating-starter duels per run = **`1,200` paired duels per `(Tier, Policy)` cell** (`600` Inspector-offers-first + `600` Player-offers-first for exact 50/50 seat balance). Across `6` policies × `5` tiers = **`36,000` full duels**. 95% normal confidence interval is approx. `±2.8%` per cell (`±1.2%` on the `N = 6,000` aggregate row).
- **Information boundary**: Both the Inspector and every fixed policy receive strictly their own `ObserverView` and independent PRNG streams. Inspector habit memory persists across the 4 stops of a run and resets via `resetForNewRun()` before every new run.

---

## Inspector Win Rates by Tier (`N = 1,200` paired duels / cell)

| Opponent Policy | Tier 1 (Novice) | Tier 2 (Examiner) | Tier 3 (Dining Car) | Tier 4 (Sleeper) | Tier 5 (Chief) |
| --- | :---: | :---: | :---: | :---: | :---: |
| **Uniform Control** *(neutral check)* | 52.2% | 50.4% | 50.9% | 49.3% | 47.5% |
| **Reveal-Aware Arrival-Avoider** *(Drafty Window)* | 32.6% | 50.2% | 50.7% | 52.0% | 52.4% |
| **Left-Edge Picker** *(always leftmost)* | 43.5% | 48.7% | 72.5% | 82.2% | 82.0% |
| **Center Picker** *(closest to center)* | 43.5% | 48.8% | 73.4% | 81.7% | 83.5% |
| **Habitual Player** *(62% left draw + 85% left hide)* | 47.8% | 50.7% | 61.5% | 70.6% | 71.7% |
| **Alternating-Edge Picker** *(left ↔ right)* | 55.3% | 51.0% | 53.3% | 50.6% | 66.3% |
| **OVERALL vs Exploitable (`N = 6,000`/tier)** | **44.5%** | **49.9%** | **62.3%** | **67.4%** | **71.2%** |

---

## Habit-Shift Placement Verification (`N = 400` 5-card offers / probe)

| Stage | Tier 1 `LEFT_EDGE` | Tier 3 `LEFT_EDGE` | Tier 3 `CENTER` | Tier 5 `LEFT_EDGE` | Tier 5 `CENTER` |
| --- | :---: | :---: | :---: | :---: | :---: |
| Fresh run prior (`obs = 0`) | ~20% | 21.5% | 17.5% | ~20% | ~20% |
| After Left-Edge phase (`obs = 6`) | 18.0% | **65.8%** | 7.2% | **94.5%** | 0.8% |
| Switched to Center (`obs = 15`) | ~20% | 12.5% | **63.7%** | 2.0% | **93.5%** |
| After `resetForNewRun()` (`obs = 0`) | ~20% | 21.3% | 19.0% | ~20% | ~20% |

---

## Investigations & Tuning Notes

1. **Uniform Control (~50% across all tiers)**: Against a mathematically memoryless uniform opponent (uniform draws + uniform concealment), no legal observer can beat 50% in expectation. All five tiers staying within statistical noise of 50% confirms zero hidden-state leakage.
2. **Tier 4 initial dip against Alternating-Edge (fixed)**: On the first benchmark pass, Tier 4 scored `48.2%` vs. Alternating-Edge (below Tier 3's `52.3%`) because Tier 4 blended a short-window marginal recency counter (`fastRecencyBlend = 0.20`) without a transition matrix — causing it to bait the edge the player *just left* one turn out of phase. Setting `fastRecencyBlend = 0` on Tier 4 removed that lag while preserving Tier 4's strong gains on small-hand focus and player hiding-habit tracking (`+9.1` pts over Tier 3 on Habitual Player, `+9.7` pts on Left-Edge). Tier 5 pairs fast recency with a 1st-order `prevBucket -> nextBucket` transition matrix, jumping to **`66.3%`** against Alternating-Edge.
3. **Why Tier 1 scores `55.3%` vs. Alternating-Edge but `43.5%` vs. Left-Edge / Center**: Newly drawn Unlisted tickets enter at the right edge (`slot N - 1`, Decision D4), and Tier 1 only swaps 30% of the time. Left-Edge and Center pickers never touch the right edge (accidentally dodging Tier 1's unmoved Unlisted), whereas Alternating-Edge draws the exact right edge 50% of the time (walking straight into Tier 1's unmoved arrival slot). Tier 2 actively conceals The Unlisted evenly across all slots, normalizing all unrevealed positional policies to ~50% before Tiers 3–5 actively exploit them.
4. **Tier 4 → Tier 5 plateau on pure Left-Edge (`82.2%` vs. `82.0%`)**: Both tiers reach the natural ceiling imposed by initial-deal variance, Final Call protection, and Tier 5's deliberate `8%` exploration floor (`explorationRate = 0.08`) that keeps the final Inspector fallible.
5. **Caveat**: Bot benchmarks measure strategic accuracy and non-cheating progression — they do not measure whether pacing or difficulty feels fun for humans. Tuning parameters are centralized in `src/data/aiTuning.js` for playtest adjustments.
