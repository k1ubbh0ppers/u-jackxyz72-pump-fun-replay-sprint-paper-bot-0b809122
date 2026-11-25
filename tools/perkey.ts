// Per-fail-key diagnostic: net PnL, coins, and how many rider vs probe buys were sent.
// Usage: node tools/perkey.ts <kit dir>

import { createStrategy, DEFAULT_PARAMS } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/perkey.ts <kit dir>');
  process.exit(2);
}
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pump-fun-replay-sprint', 'dev', ds.sha256));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);

for (const key of [undefined, 11n, 22n, 33n, 44n]) {
  let riderBuys = 0;
  let probeBuys = 0;
  let sells = 0;
  const inner = createStrategy(DEFAULT_PARAMS);
  const bot = {
    onBatch(state: any, batch: any) {
      const orders = inner.onBatch(state, batch);
      for (const o of orders) {
        if (o.side === 'buy' && BigInt(o.quote_lamports) === 20_000_000n) probeBuys++;
        else if (o.side === 'buy') riderBuys++;
        else sells++;
      }
      return orders;
    },
  };
  const r = simulate(ds, hello, bot as any, key === undefined ? {} : { failKey: key });
  console.log(
    `failKey ${key === undefined ? 'default' : key}: net ${sol(r.netPnl)} fills ${r.fills} coins ${r.mints} trips ${r.trips.length} wins ${r.trips.filter((t) => t.pnl > 0n).length} dd ${r.maxDrawdown.toFixed(4)} riderBuys ${riderBuys} probeBuys ${probeBuys} sells ${sells} failed ${r.failed}`,
  );
}
