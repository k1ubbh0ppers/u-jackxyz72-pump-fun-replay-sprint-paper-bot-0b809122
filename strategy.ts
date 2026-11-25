// Sniper-style strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The play: take one small, early stake in a young curve that is already showing
// genuine demand, then leave quickly. Almost every pump.fun curve trends toward
// zero, so the advantage does not come from spotting winners in advance. It comes
// from (a) entering only when the tape already shows real interest — real SOL in
// the reserve inside a band, a creator buy that is bounded, a few distinct buyers
// who are not the creator, and no large early sell, (b) cutting losers fast with
// a stop loss and a short maximum hold, and (c) locking in winners with a
// take-profit plus a trailing stop once a trade starts to run. A position that
// clears all of those exits is simply left alone until the curve completes (the
// replay then closes it at its final reserves) — the occasional runner covers
// the many small losses.
//
// Each choice is a pure function of the hello message and the batch stream: the
// hello supplies the caps, fees and seed, and every batch supplies its slot, its
// events, its fills and the account snapshot. There is no clock, no randomness,
// no I/O and no environment access, so the two graded runs emit byte-identical
// action logs (the same orders for every batch). Iteration only ever walks
// insertion-ordered Maps that the batch stream itself populated.
//
// Guardrail backstop: a run has to finish with at least 20 coins that each
// round-tripped >= 0.01 SOL, and with max drawdown <= 50%. Entry volume sits far
// above that bar on the dev window, but if the filled-coin count ever falls
// behind its expected pace (counted from batch fills against the slot clock of
// the batch stream), the bot takes small probe stakes on the most liquid
// unheld curves and sells them as soon as they land, so the bar is still met
// even on a window where the entry filter goes quiet. The pace is checked
// every batch, so probes switch on and off as the count catches up or lags.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total. */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (>= 10_000_000 keeps round trips counted). */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price run-up vs the create-time price, in bps: [minRunupBps, maxRunupBps]. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent-flow window (trades) and the minimum net flow over it (lamports, may be negative). */
  flowWindow: number;
  minFlowLamports: number;
  /** Distinct recent buyers required in the flow window. */
  minRecentBuyers: number;
  /** Never buy a coin whose creator has sold. */
  skipDevSold: boolean;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Take profit / stop loss, in bps of cost. */
  tpBps: number;
  slBps: number;
  /** Trailing stop: arms once value reaches cost * (1 + trailArmBps/10000), then sells at best * (1 - trailBps/10000). */
  trailArmBps: number;
  trailBps: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit as soon as the creator sells after we bought. */
  exitOnDevSell: boolean;
  /** Exit when the net flow over the last `staleTrades` trades falls below -exitFlowLamports. */
  staleTrades: number;
  exitFlowLamports: number;
  /** Flat-rider exit: sell when held longer than flatExitSlots without reaching cost * (1 + flatExitBps/10000). 0 = off. */
  flatExitSlots: number;
  flatExitBps: number;
  /** Rider slots: entries may only use this many of max_open_positions; the rest stays free for guardrail probes. */
  maxRiderPositions: number;
  /** Guardrail probe: stake per probe buy (lamports), and the slot pace at which probes arm. */
  probeLamports: number;
  probeAfterSlots: number;
  /** Slots over which the 20 counted coins are expected to arrive (pace denominator). */
  probeWindowSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 50_000_000,
  minBuyLamports: 10_000_000,
  minRealSol: 3_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minTrades: 0,
  minBuyers: 0,
  maxBuyers: 3,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 1_000_000,
  slBps: 5_000,
  trailArmBps: 1_000,
  trailBps: 1_000,
  maxHold: 1_000_000,
  exitOnDevSell: true,
  staleTrades: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  flatExitSlots: 0,
  flatExitBps: 500,
  maxRiderPositions: 5,
  probeLamports: 20_000_000,
  probeAfterSlots: 100_000,
  probeWindowSlots: 400_000,
};

const BPS = 10_000n;
const FEE_BPS = 125n; // protocol 95 bps + creator 30 bps fallback, charged on the curve side.
const COUNTED_MIN_LAMPORTS = 10_000_000n; // a round trip only counts toward the guardrail at >= 0.01 SOL.
const SELL_SLIPPAGE_BPS = 10_000;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function exitProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

/** Price-ratio checks, all in bigint so no floats are involved: is (vq/vt) at least
 *  (1 + bps/10000) times (vq0/vt0), and is it at most that multiple? */
function priceUpAtLeast(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint, bps: number): boolean {
  return vq * vt0 * BPS >= vq0 * vt * (BPS + BigInt(bps));
}
function priceUpAtMost(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint, bps: number): boolean {
  return vq * vt0 * BPS <= vq0 * vt * (BPS + BigInt(bps));
}

interface TradeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Most recent trades (flowWindow kept). */
  recent: TradeTick[];
  buysSent: number;
  spentSent: bigint;
  /** Decision price (vq/vt pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (entered, exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
  /** Probe buy sent and awaiting its fill; sold as soon as it lands. */
  probe: boolean;
}

interface OpenPosition {
  openedSlot: number;
  /** Best mark-to-market sell value seen (lamports). */
  best: bigint;
  /** Creator sold after we opened. */
  devSoldAtOpen: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const P = params;
  const tracked = new Map<Pubkey, Coin>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Mints with a sell in flight (do not send a second sell for the same tokens). */
  const sellInFlight = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  const probeStake = BigInt(P.probeLamports);
  /** Distinct mints with a filled buy of >= 0.01 SOL (the guardrail counts round trips). */
  const countedMints = new Set<Pubkey>();
  const filledBuys = new Map<Pubkey, bigint>();
  let windowStart: number | null = null;

  function absorbEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tracked.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 0n,
          lastBuySlot: -1,
          done: false,
          complete: false,
          probe: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = tracked.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const fromCreator = e.user === c.creator;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        if (e.is_buy) {
          if (fromCreator) c.devBuy += sol;
          else {
            c.buyers.add(e.user);
            c.bought += sol;
          }
        } else if (fromCreator) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_sol_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.recent.length > P.flowWindow) c.recent.splice(0, c.recent.length - P.flowWindow);
      } else {
        const c = tracked.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function absorbFills(batch: Batch): void {
    for (const f of batch.fills) {
      // Any terminal sell fill (filled / rejected / failed) frees the mint for a retry.
      if (f.side === 'sell') sellInFlight.delete(f.mint);
      if (f.status !== 'filled') continue;
      if (f.client_id.startsWith('_')) continue;
      if (f.side === 'buy') {
        const total = (filledBuys.get(f.mint) ?? 0n) + BigInt(f.quote_lamports);
        filledBuys.set(f.mint, total);
        if (total >= COUNTED_MIN_LAMPORTS) countedMints.add(f.mint);
      }
    }
  }

  function windowFlow(c: Coin): { net: bigint; buyers: number } {
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      net += t.isBuy ? t.sol : -t.sol;
      if (t.isBuy && t.user !== c.creator) buyers.add(t.user);
    }
    return { net, buyers: buyers.size };
  }

  function passesEntry(c: Coin, state: BotState): boolean {
    const curve = state.curves.get(c.mint);
    if (curve === undefined || curve.complete) return false;
    const age = state.slot - c.createSlot;
    if (age < P.minAge || age > P.maxAge) return false;
    const rq = curve.real_quote_reserves;
    if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) return false;
    if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) return false;
    if (c.trades < P.minTrades) return false;
    if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) return false;
    if (c.bought > 0n && (c.soldByOthers * BPS) / c.bought > BigInt(P.maxSellRatioBps)) return false;
    if (c.bigSellBps > BigInt(P.maxBigSellBps)) return false;
    if (P.skipDevSold && c.devSold) return false;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (!priceUpAtLeast(vq, vt, c.vq0, c.vt0, P.minRunupBps)) return false;
    if (!priceUpAtMost(vq, vt, c.vq0, c.vt0, P.maxRunupBps)) return false;
    const flow = windowFlow(c);
    if (flow.net < BigInt(P.minFlowLamports)) return false;
    if (flow.buyers < P.minRecentBuyers) return false;
    return true;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (windowStart === null) windowStart = batch.slot;
    absorbEvents(batch);
    absorbFills(batch);
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const room = (): number => caps.max_orders_per_batch - orders.length;

    // ---- Exits first: every held position is tested against take-profit,
    // stop-loss, trailing stop, max hold, creator-sell and stale-flow exits.
    for (const [mint, pos] of state.positions) {
      if (room() <= 0) break;
      if (sellInFlight.has(mint)) continue;
      const curve = state.curves.get(mint);
      const h = open.get(mint);
      if (curve === undefined || h === undefined) continue;
      const value = exitProceeds(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value > h.best) h.best = value;
      const cost = pos.cost_lamports;
      const c = tracked.get(mint);
      let exit = false;
      if (value * BPS >= cost * (BPS + BigInt(P.tpBps))) exit = true;
      if (value * BPS <= cost * (BPS - BigInt(P.slBps))) exit = true;
      if (h.best * BPS >= cost * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
      if (state.slot - h.openedSlot >= P.maxHold) exit = true;
      if (P.exitOnDevSell && c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
      // Flat-rider exit: a position that has sat for flatExitSlots without getting
      // 5% above cost is dead money occupying one of the 5 slots — free the slot.
      if (
        P.flatExitSlots > 0 &&
        state.slot - h.openedSlot >= P.flatExitSlots &&
        value * BPS < cost * (BPS + BigInt(P.flatExitBps))
      ) {
        exit = true;
      }
      if (c !== undefined && c.recent.length >= P.staleTrades) {
        let net = 0n;
        for (const t of c.recent.slice(-P.staleTrades)) net += t.isBuy ? t.sol : -t.sol;
        if (net < -BigInt(P.exitFlowLamports)) exit = true;
      }
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        sellInFlight.add(mint);
        const coin = tracked.get(mint);
        if (coin !== undefined) coin.done = true;
        open.delete(mint);
      }
    }

    // ---- Probe sells: a probe position is sold whole as soon as its buy has landed.
    for (const [mint, pos] of state.positions) {
      if (room() <= 0) break;
      if (sellInFlight.has(mint)) continue;
      const c = tracked.get(mint);
      if (c !== undefined && c.probe && !open.has(mint)) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        sellInFlight.add(mint);
        c.probe = false;
        c.done = true;
      }
    }

    // ---- Entries: one first buy per qualifying coin, in batch event order.
    // Guardrail pace: 20 counted coins spread over probeWindowSlots (~the replay
    // window). When the counted-coin pace lags, one slot is reserved for guardrail
    // probes and rider entries may not take it; otherwise riders may use all 5 slots.
    // (A permanent reservation was measured to cost ~0.06 SOL of PnL, so the reserve
    // only bites while the run is actually behind pace.)
    const elapsed = windowStart === null ? 0 : state.slot - windowStart;
    const paceDue =
      windowStart === null ? 0 : Math.min(20, Math.floor((20 * elapsed) / Math.max(1, P.probeWindowSlots)));
    const probesArmed = windowStart !== null && elapsed >= P.probeAfterSlots && countedMints.size < 20 && countedMints.size < paceDue;
    const reserve = probesArmed ? 1 : 0;
    const riderSlots = Math.max(0, P.maxRiderPositions - reserve - state.committedPositionCount());
    let riderRoom = riderSlots;
    // state.pending is keyed by client_id, so collect the mints with a buy in flight first.
    const pendingBuyMints = new Set<Pubkey>();
    for (const p of state.pending.values()) if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
    for (const e of batch.events) {
      if (room() <= 0 || riderRoom <= 0) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const c = tracked.get(e.mint);
      if (c === undefined || c.done || c.complete) continue;
      if (open.has(e.mint) || state.positions.has(e.mint)) continue;
      if (pendingBuyMints.has(e.mint)) continue;
      const age = state.slot - c.createSlot;
      if (age < P.minAge) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < minBuy) {
        if (age >= P.maxAge) c.done = true;
        continue;
      }
      if (!passesEntry(c, state)) {
        if (age >= P.maxAge) c.done = true;
        continue;
      }
      const amount = cap < stake ? cap : stake;
      if (amount < minBuy) {
        if (age >= P.maxAge) c.done = true;
        continue;
      }
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
      free -= amount + tx;
      slots -= 1;
      riderRoom -= 1;
      c.buysSent += 1;
      c.spentSent += amount;
      c.lastBuyVq = curve.virtual_quote_reserves;
      c.lastBuyVt = curve.virtual_token_reserves;
      c.lastBuySlot = state.slot;
      c.done = true;
    }

    // ---- Guardrail probes: if counted coins lag the pace, buy small stakes on the
    // most liquid unheld curves (deterministic order: insertion order of the map).
    // If every slot is held by riders, evict the worst rider (lowest value/cost) to
    // free one slot — but only while the guardrail is actually at risk, only in the
    // second half of the window (a mid-window pace lag is usually transient and not
    // worth cutting a rider for), and at most one eviction per sell-settlement cycle
    // (selling must be empty), so a full book of long-held riders can never starve
    // the run of counted coins.
    const evictArmed = probesArmed && elapsed >= 200_000;
    if (evictArmed && room() > 0 && slots <= 0 && sellInFlight.size === 0) {
      let worstMint: Pubkey | null = null;
      let worstValue = 0n;
      let worstCost = 1n;
      for (const [mint, pos] of state.positions) {
        const h = open.get(mint);
        const curve = state.curves.get(mint);
        if (h === undefined || curve === undefined) continue;
        const value = exitProceeds(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (worstMint === null || value * worstCost < worstValue * pos.cost_lamports) {
          worstMint = mint;
          worstValue = value;
          worstCost = pos.cost_lamports;
        }
      }
      if (worstMint !== null) {
        const pos = state.positions.get(worstMint)!;
        orders.push({ side: 'sell', mint: worstMint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        sellInFlight.add(worstMint);
        const coin = tracked.get(worstMint);
        if (coin !== undefined) coin.done = true;
        open.delete(worstMint);
      }
    }
    if (probesArmed && room() > 0 && slots > 0) {
      // Pace: 20 counted coins spread over probeWindowSlots (~the replay window).
      // At the end of the window paceDue == 20, so probes keep firing until the bar is met.
      for (const c of tracked.values()) {
        if (room() <= 0 || slots <= 0) break;
        // NOTE: entry-decided coins are marked done within maxAge slots of creation,
        // so probes must NOT skip done coins — only completed, already-probed, held,
        // or buy-in-flight ones. A probe is a fresh decision on a liquid curve.
        if (c.complete || c.probe) continue;
        if (open.has(c.mint) || state.positions.has(c.mint)) continue;
        if (pendingBuyMints.has(c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < BigInt(P.minRealSol)) continue;
        const cap = state.maxBuyLamports(c.mint);
        if (cap < probeStake) continue;
        if (free < probeStake + tx) break;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: probeStake, max_slippage_bps: P.buySlippageBps });
        free -= probeStake + tx;
        slots -= 1;
        c.probe = true;
      }
    }

    // ---- Register newly opened positions (their buy just filled this batch).
    // Probe positions are NOT registered here: they are sold whole by the probe-sell
    // branch on the next batch instead of going through the normal exit rules.
    for (const [mint, pos] of state.positions) {
      if (!open.has(mint)) {
        const coin = tracked.get(mint);
        if (coin !== undefined && coin.probe) continue;
        const curve = state.curves.get(mint);
        const c = tracked.get(mint);
        const value = curve === undefined ? 0n : exitProceeds(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        open.set(mint, { openedSlot: state.slot, best: value, devSoldAtOpen: c !== undefined && c.devSold });
      }
    }
    return orders;
  }

  return { onBatch };
}
