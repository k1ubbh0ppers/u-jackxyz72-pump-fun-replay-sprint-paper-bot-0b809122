// Run strategy.ts against the kit's dev window using the local replay engine.
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.4}'] [--trips]
//
// The first line reports net PnL, fills, coins, round trips and drawdown for
// the default failed-tx draw, followed by the same run with failures turned
// off and with fees doubled (the fee-sensitivity check). --trips prints
// every round trip on its own line.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kitDir = process.argv[2];
if (kitDir === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const thirdArg = process.argv[3];
const overrides = thirdArg !== undefined && thirdArg.startsWith('{') ? (JSON.parse(thirdArg) as Partial<Params>) : {};
const dataset = loadDataset(kitDir);
const hello = makeHello(phaseSeed('pump-fun-replay-sprint', 'dev', dataset.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const result = simulate(dataset, hello, createStrategy(params));
const toSol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
const winningTrips = result.trips.filter((trip) => trip.pnl > 0n).length;
console.log(`net ${toSol(result.netPnl)} SOL  fills ${result.fills}  coins ${result.mints}  trips ${result.trips.length}  wins ${winningTrips}  dd ${result.maxDrawdown.toFixed(4)}  rejected ${result.rejected} ${JSON.stringify(result.rejectReasons)}  failed ${result.failed}`);
const cleanRun = simulate(dataset, hello, createStrategy(params), { failKey: null });
const priceyRun = simulate(dataset, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${toSol(cleanRun.netPnl)}  at 2x fees ${toSol(priceyRun.netPnl)}`);
const ranked = [...result.perMint.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
const topCoin = ranked.length > 0 ? ranked[0]![1] : 0n;
console.log(`best coin ${ranked.length > 0 ? toSol(topCoin) : 'n/a'} SOL  net ex-best ${(Number(result.netPnl - topCoin) / 1e9).toFixed(6)} SOL`);
if (process.argv.includes('--trips')) {
  for (const trip of result.trips) console.log(trip.mint, trip.open, trip.close - trip.open, toSol(trip.pnl));
}
