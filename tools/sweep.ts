// Sweep strategy parameters over the dev window with the local replay engine.
//
//   node tools/sweep.ts <kit dir> '<base params json>' '<grid json: {"key":[v1,v2],...}>' [top N]
//
// Every setting is scored as the mean net PnL over several fail keys, because
// the final window's failed-tx draw is secret and no setting should be judged
// on one lucky draw. The printout also shows the net without the single best
// round trip, so a setting that only wins through one lucky coin stands out.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const [kitDir, baseJson, gridJson, topArg] = process.argv.slice(2);
if (kitDir === undefined || gridJson === undefined) {
  console.error("usage: node tools/sweep.ts <kit dir> '<base json>' '<grid json>' [top]");
  process.exit(2);
}
const baseParams = { ...DEFAULT_PARAMS, ...(JSON.parse(baseJson ?? '{}') as Partial<Params>) };
const grid = JSON.parse(gridJson) as Record<string, unknown[]>;
const dataset = loadDataset(kitDir);
const hello = makeHello(phaseSeed('pump-fun-replay-sprint', 'dev', dataset.sha256));
const gridKeys = Object.keys(grid);
const combos: Record<string, unknown>[] = gridKeys.reduce<Record<string, unknown>[]>(
  (acc, key) => acc.flatMap((combo) => grid[key]!.map((value) => ({ ...combo, [key]: value }))),
  [{}],
);
// Score every setting over several fail keys (and keep the worst of them),
// never on a single draw.
const FAIL_KEYS = [11n, 22n, 33n, 44n];
interface SweepRow {
  c: Record<string, unknown>;
  net: number;
  worst: number;
  exBest: number;
  ex2: number;
  fills: number;
  coins: number;
  dd: number;
  trips: number;
  wins: number;
}
const rows: SweepRow[] = [];
for (const combo of combos) {
  let totalNet = 0;
  let worstNet = Infinity;
  let exBestTotal = 0;
  let exTopTwoTotal = 0;
  let minFills = Infinity;
  let minCoins = Infinity;
  let maxDd = 0;
  let tripCount = 0;
  let winCount = 0;
  for (const failKey of FAIL_KEYS) {
    const run = simulate(dataset, hello, createStrategy({ ...baseParams, ...combo } as Params), { failKey });
    const tripPnls = run.trips.map((trip) => Number(trip.pnl) / 1e9).sort((a, b) => b - a);
    const net = Number(run.netPnl) / 1e9;
    totalNet += net;
    worstNet = Math.min(worstNet, net);
    exBestTotal += (net - (tripPnls[0] ?? 0)) / FAIL_KEYS.length;
    exTopTwoTotal += (net - (tripPnls[0] ?? 0) - (tripPnls[1] ?? 0)) / FAIL_KEYS.length;
    minFills = Math.min(minFills, run.fills);
    minCoins = Math.min(minCoins, run.mints);
    maxDd = Math.max(maxDd, run.maxDrawdown);
    tripCount = run.trips.length;
    winCount = run.trips.filter((trip) => trip.pnl > 0n).length;
  }
  rows.push({ c: combo, net: totalNet / FAIL_KEYS.length, worst: worstNet, exBest: exBestTotal, ex2: exTopTwoTotal, fills: minFills, coins: minCoins, dd: maxDd, trips: tripCount, wins: winCount });
}
rows.sort((a, b) => b.net - a.net);
for (const row of rows.slice(0, Number(topArg ?? 25))) {
  console.log(
    `mean ${row.net.toFixed(3)} worst ${row.worst.toFixed(3)} exBest ${row.exBest.toFixed(3)} ex2 ${row.ex2.toFixed(3)} fills ${row.fills} coins ${row.coins} trips ${row.trips} wins ${row.wins} dd ${row.dd.toFixed(3)} ${JSON.stringify(row.c)}`,
  );
}
