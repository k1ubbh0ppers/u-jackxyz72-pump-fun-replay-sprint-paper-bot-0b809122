// Dev-only comparison: run the kit's pilot strategies and an equal-weight replica
// through this repo's local engine on the FULL dev window, same hello/seed as backtest.
// Usage: node tools/compare.ts <kit dir>

import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';
import { createStrategy as sniper } from '/home/hatch/workspace/makefun/kit_new_u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit/baselines/pilot/sniper/strategy.ts';
import { createStrategy as momentum } from '/home/hatch/workspace/makefun/kit_new_u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit/baselines/pilot/momentum/strategy.ts';
import { createStrategy as mine } from '../strategy.ts';
import { LAMPORTS_PER_SOL, type BotState, type Batch, type BuyInput } from '../vendor/makefun-bot.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/compare.ts <kit dir>');
  process.exit(2);
}
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pump-fun-replay-sprint', 'dev', ds.sha256));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);

// Equal-weight replica (same rules as baselines/baseline-equal-weight/main.ts):
// buy each coin once, 0.05 SOL, as soon as its size cap allows, then hold.
const STAKE = LAMPORTS_PER_SOL / 20n;
const MIN_BUY = LAMPORTS_PER_SOL / 200n;
const makeEqualWeight = () => {
  const candidates = new Set<string>();
  return {
  onBatch(state: BotState, batch: Batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: BuyInput[] = [];
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') candidates.add(e.mint);
      if (!candidates.has(e.mint)) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(e.mint);
        continue;
      }
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY) continue;
      candidates.delete(e.mint);
      const amount = cap < STAKE ? cap : STAKE;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0 || free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
  };
};

const bots: [string, () => any][] = [
  ['mine (sniper-family)', () => mine()],
  ['pilot sniper', () => sniper()],
  ['pilot momentum', () => momentum()],
  ['equal-weight (buy early, hold)', () => makeEqualWeight()],
  ['hold cash', () => ({ onBatch: () => [] })],
];
for (const [name, makeBot] of bots) {
  // Fresh bot instance per run: strategies hold per-run state (coin maps, held map).
  const r = simulate(ds, hello, makeBot());
  const twoX = simulate(ds, hello, makeBot(), { feeMultiplier: 2n });
  const best = [...r.perMint.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))[0] ?? 0n;
  console.log(
    `${name}: net ${sol(r.netPnl)} SOL  2x-fees ${sol(twoX.netPnl)}  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${r.trips.filter((t) => t.pnl > 0n).length}  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected}  best-coin ${sol(best)}  ex-best ${sol(r.netPnl - best)}`,
  );
}
