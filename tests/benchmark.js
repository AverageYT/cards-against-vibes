/**
 * tests/benchmark.js
 * Paired-seed benchmark comparing Inspector AI Tiers 1–5 against fixed policies.
 *
 * Methodology:
 * - Each paired series runs `duelsPerRun` consecutive encounters (alternating starting
 *   offerer for exact 50/50 seat balance) with fresh Inspector memory per run.
 * - Every tier faces the exact same shuffle seeds, pair counts, conditions, and
 *   isolated player-policy RNG seeds so variance from deal luck cancels out.
 * - Reports exact sample sizes (duels), win counts, win rates, and 95% normal CIs.
 *
 * Run directly: `node tests/benchmark.js`
 */

import { PHASES, SIDES, applyAction, createDuel, getActiveActor } from "../src/core/engine.js";
import { createObserverView } from "../src/core/observer.js";
import { createRng, deriveSeed } from "../src/core/rng.js";
import { AI_TIERS } from "../src/data/aiTuning.js";
import { createInspectorAgent } from "../src/ai/inspector.js";
import {
  createAlternatingEdgePolicy,
  createCenterPolicy,
  createHabitualHumanPolicy,
  createLeftEdgePolicy,
  createRevealAwarePolicy,
  createUniformPolicy,
} from "../src/ai/policies.js";

const STOP_PAIR_SCHEDULE = [6, 8, 10, 12];

export function playSingleMatchupDuel({
  duelSeed,
  pairCount,
  startingOfferer,
  condition = null,
  inspectorAgent,
  aiSeed,
  playerPolicy,
  policySeed,
}) {
  let state = createDuel({
    encounterSeed: duelSeed,
    pairCount,
    startingOfferer,
    condition,
  });

  inspectorAgent.resetForNewDuel();
  if (typeof playerPolicy.resetDuel === "function") {
    playerPolicy.resetDuel();
  }

  const aiRng = createRng(aiSeed);
  const pRng = createRng(policySeed);

  let guard = 0;
  while (state.phase !== PHASES.OVER) {
    guard += 1;
    if (guard > 600) {
      throw new Error("Benchmark duel exceeded 600 steps");
    }

    const actor = getActiveActor(state);
    if (actor === SIDES.INSPECTOR) {
      const view = createObserverView(state, SIDES.INSPECTOR);
      const action = inspectorAgent.act(view, aiRng);
      const res = applyAction(state, action);
      if (!res.ok) {
        throw new Error(
          `Tier ${inspectorAgent.getTier()} produced illegal action ${JSON.stringify(action)}: ${res.reason}`
        );
      }
      state = res.state;
    } else {
      const view = createObserverView(state, SIDES.PLAYER);
      const action = playerPolicy.act(view, pRng);
      const res = applyAction(state, action);
      if (!res.ok) {
        throw new Error(
          `Policy ${playerPolicy.id} produced illegal action ${JSON.stringify(action)}: ${res.reason}`
        );
      }
      state = res.state;
    }
  }

  // Let Inspector observe the final public event of the duel (last draw outcome) before next carriage.
  inspectorAgent.observe(createObserverView(state, SIDES.INSPECTOR));
  return state.winner;
}

/**
 * Run paired-seed comparison across specified tiers and policy factories.
 */
export function runPairedBenchmark({
  runsPerPolicy = 300,
  duelsPerRun = 4,
  tiers = [1, 2, 3, 4, 5],
  seedPrefix = "BENCH-2026",
} = {}) {
  const policySpecs = [
    {
      factory: () => createUniformPolicy(),
      useDraftyCondition: false,
      description: "Uniform draw + uniform Unlisted conceal (neutral control)",
    },
    {
      factory: () => createRevealAwarePolicy(),
      useDraftyCondition: true,
      description: "Uses Drafty Window reveals + avoids right-edge arrival",
    },
    {
      factory: () => createLeftEdgePolicy({ bias: 1.0 }),
      useDraftyCondition: false,
      description: "Always draws leftmost legal slot; uniform conceal",
    },
    {
      factory: () => createCenterPolicy({ bias: 1.0 }),
      useDraftyCondition: false,
      description: "Always draws slot closest to center; uniform conceal",
    },
    {
      factory: () => createHabitualHumanPolicy(),
      useDraftyCondition: false,
      description: "Soft-left draws (62%) + hides Unlisted at left edge (85%)",
    },
    {
      factory: () => createAlternatingEdgePolicy(),
      useDraftyCondition: false,
      description: "Alternates strictly between leftmost and rightmost slots",
    },
  ];

  const totalDuelsPerCell = runsPerPolicy * duelsPerRun;
  const rows = [];

  for (const spec of policySpecs) {
    const samplePolicy = spec.factory();
    const tierStats = {};

    for (const tier of tiers) {
      let inspectorWins = 0;
      const agent = createInspectorAgent({ tier });

      for (let r = 0; r < runsPerPolicy; r += 1) {
        agent.resetForNewRun();
        const policy = spec.factory();
        policy.reset();

        for (let d = 0; d < duelsPerRun; d += 1) {
          const pairCount = STOP_PAIR_SCHEDULE[d % STOP_PAIR_SCHEDULE.length];
          const startingOfferer = d % 2 === 0 ? SIDES.INSPECTOR : SIDES.PLAYER;
          const base = `${seedPrefix}:${samplePolicy.id}:r${r}:d${d}`;
          const condition =
            spec.useDraftyCondition
              ? { id: "DRAFTY_WINDOW", activeThroughTurn: 4 }
              : null;

          const winner = playSingleMatchupDuel({
            duelSeed: deriveSeed(base, "shuffle"),
            pairCount,
            startingOfferer,
            condition,
            inspectorAgent: agent,
            aiSeed: deriveSeed(base, "ai"),
            playerPolicy: policy,
            policySeed: deriveSeed(base, "player"),
          });

          if (winner === SIDES.INSPECTOR) {
            inspectorWins += 1;
          }
        }
      }

      const winRate = inspectorWins / totalDuelsPerCell;
      const se = Math.sqrt((winRate * (1 - winRate)) / totalDuelsPerCell);
      tierStats[tier] = {
        wins: inspectorWins,
        duels: totalDuelsPerCell,
        winRate,
        ci95: 1.96 * se,
      };
    }

    rows.push({
      policyId: samplePolicy.id,
      policyName: samplePolicy.name,
      description: spec.description,
      duelsPerTier: totalDuelsPerCell,
      runsPerPolicy,
      duelsPerRun,
      tierStats,
    });
  }

  // Compute aggregate Inspector win rate across all non-uniform exploitable policies.
  const exploitable = rows.filter((r) => r.policyId !== "uniform");
  const aggregate = {};
  for (const tier of tiers) {
    let wins = 0;
    let duels = 0;
    for (const row of exploitable) {
      wins += row.tierStats[tier].wins;
      duels += row.tierStats[tier].duels;
    }
    const winRate = wins / duels;
    const se = Math.sqrt((winRate * (1 - winRate)) / duels);
    aggregate[tier] = { wins, duels, winRate, ci95: 1.96 * se };
  }

  return {
    seedPrefix,
    runsPerPolicy,
    duelsPerRun,
    totalDuelsPerCell,
    totalDuelsRun: totalDuelsPerCell * policySpecs.length * tiers.length,
    tiers: tiers.map((t) => ({ tier: t, name: AI_TIERS[t].name })),
    rows,
    aggregate,
  };
}

export function formatBenchmarkTable(report) {
  const lines = [];
  lines.push(
    `Paired-Seed AI Benchmark — N = ${report.totalDuelsPerCell} duels/cell (${report.runsPerPolicy} runs × ${report.duelsPerRun} alternating duels; ${report.totalDuelsRun.toLocaleString()} total duels)`
  );
  lines.push(
    "Policy                                      |   T1    |   T2    |   T3    |   T4    |   T5   "
  );
  lines.push(
    "--------------------------------------------+---------+---------+---------+---------+--------"
  );

  const fmt = (stat) => `${(stat.winRate * 100).toFixed(1).padStart(5)}%`;

  for (const row of report.rows) {
    const label = row.policyName.padEnd(43).slice(0, 43);
    const cols = [1, 2, 3, 4, 5]
      .map((t) => (row.tierStats[t] ? ` ${fmt(row.tierStats[t])} ` : "   -   "))
      .join("|");
    lines.push(`${label} |${cols}`);
  }

  lines.push(
    "--------------------------------------------+---------+---------+---------+---------+--------"
  );
  const aggLabel = "OVERALL vs Exploitable Policies (N=6,000)  ".slice(0, 43);
  const aggCols = [1, 2, 3, 4, 5]
    .map((t) => (report.aggregate[t] ? ` ${fmt(report.aggregate[t])} ` : "   -   "))
    .join("|");
  lines.push(`${aggLabel} |${aggCols}`);
  return lines.join("\n");
}

// Run when invoked directly via `node tests/benchmark.js`.
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("benchmark.js");

if (isDirectRun) {
  const start = Date.now();
  const report = runPairedBenchmark({ runsPerPolicy: 300, duelsPerRun: 4 });
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(formatBenchmarkTable(report));
  console.log(`\nCompleted in ${elapsed}s.`);
}
