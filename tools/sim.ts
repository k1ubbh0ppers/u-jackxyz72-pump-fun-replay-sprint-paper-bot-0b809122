// Offline replay harness for the pump.fun replay bot, run locally without docker.
//
// This is an independent re-implementation of the house replay market: a
// constant-product bonding curve, protocol plus creator curve fees, a flat
// per-order transaction fee, two slots of order latency, seeded failed-tx
// draws, forced closes when a curve completes, and a final flatten at the
// end of the data. It is a development aid only. The graded entry point
// (main.ts / strategy.ts) never imports it, and the grader scores with its
// own engine. tools/backtest.ts and tools/sweep.ts use it to score a
// strategy against the kit's dev window.
//
// The data set is every part-*.ndjson.gz under <kit>/dataset/events,
// restricted to the manifest universe (SOL quote, no mayhem, no cashback,
// sha256(mint) mod modulus == residue, minus excluded_mints), then grouped
// into one batch per slot, preserving chain order.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { BotState, type Batch, type Bot, type Fill, type Hello, type Mark, type Order } from '../vendor/makefun-bot.ts';

const BASIS_POINTS = 10_000n;
const U64_MASK = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

/** Virtual plus real reserves of one bonding curve, in quote (SOL) and tokens. */
interface CurveReserves {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}

/** How far our own fills have pushed a curve away from its on-chain reserves. */
interface Displacement {
  quote: bigint;
  tokens: bigint;
}

interface FeeSchedule {
  protocol: bigint;
  creator: bigint;
}

export interface Dataset {
  sha256: string;
  events: any[];
  endSlot: number;
  batches: { slot: number; events: any[] }[];
}

export function loadDataset(kit: string): Dataset {
  const kitMeta = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8')) as { dataset_sha256: string };
  const manifestDoc = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifestDoc.universe.sample as { modulus: number; residue: number };
  const excludedMints = new Set<string>(manifestDoc.excluded_mints ?? []);
  const universe = new Set<string>();
  const collected: any[] = [];
  const files = readdirSync(`${kit}/dataset/events`)
    .filter((name) => name.endsWith('.ndjson.gz'))
    .sort();
  for (const file of files) {
    const text = gunzipSync(readFileSync(`${kit}/dataset/events/${file}`)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const event = JSON.parse(line);
      if (event.event === 'CreateEvent' && !universe.has(event.mint)) {
        const digest = BigInt('0x' + createHash('sha256').update(event.mint, 'utf8').digest('hex'));
        const inUniverse =
          event.quote_mint === '11111111111111111111111111111111' &&
          !event.is_mayhem_mode &&
          !event.is_cashback_enabled &&
          !excludedMints.has(event.mint) &&
          digest % BigInt(modulus) === BigInt(residue);
        if (inUniverse) universe.add(event.mint);
      }
      if (universe.has(event.mint)) collected.push(event);
    }
  }
  const grouped: { slot: number; events: any[] }[] = [];
  for (const event of collected) {
    const last = grouped[grouped.length - 1];
    if (last !== undefined && last.slot === event.slot) last.events.push(event);
    else grouped.push({ slot: event.slot, events: [event] });
  }
  const finalSlot = collected.length > 0 ? collected[collected.length - 1].slot : 0;
  return { sha256: kitMeta.dataset_sha256, events: collected, endSlot: manifestDoc.window?.end_slot ?? finalSlot, batches: grouped };
}

/** Seed derivation for a named competition phase, following the kit pilots' scheme. */
export function phaseSeed(competition: string, phase: string, datasetSha: string): string {
  const digest = createHash('sha256').update(`agent-fun/seed/v1\0${competition}\0${phase}\0${datasetSha}`).digest('hex');
  return BigInt(`0x${digest.slice(0, 16)}`).toString();
}

export function makeHello(seed: string): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed,
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 16, residue: 15 },
    },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: {
      protocol_bps_fallback: 95,
      creator_bps_fallback: 30,
      base_fee_lamports: '5000',
      priority_fee_lamports: '100000',
      failed_tx_bps: 200,
    },
  };
}

// ---------------------------------------------------------------- seeded draws

function scramble64(z0: bigint): bigint {
  let z = z0 & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return z ^ (z >> 31n);
}

function deriveU64(seed: bigint, ...parts: bigint[]): bigint {
  let h = scramble64((seed + GOLDEN_GAMMA) & U64_MASK);
  for (const part of parts) h = scramble64((h ^ (part & U64_MASK)) + GOLDEN_GAMMA);
  return h;
}

const FAILED_TX_TAG = 0x6661696c65642d74n;
const PUBLIC_FAIL_TAG = 0x6661696c2d6b6579n;

// ---------------------------------------------------------------- curve math

const divCeil = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const feeAmount = (amount: bigint, bps: bigint): bigint => divCeil(amount * bps, BASIS_POINTS);
/** Quote received for selling t tokens against reserves (vq, vt). */
const quoteForSell = (t: bigint, s: CurveReserves): bigint => (t * s.vq) / (s.vt + t);
/** Quote that must be spent to buy t tokens. */
const quoteToBuyTokens = (t: bigint, s: CurveReserves): bigint => (t * s.vq) / (s.vt - t) + 1n;
/** Tokens received for spending q quote, net of the 1-lamport rounding. */
const tokensForQuote = (q: bigint, s: CurveReserves): bigint => (q <= 1n ? 0n : ((q - 1n) * s.vt) / (s.vq + q - 1n));

function priceBuyExactIn(spend: bigint, s: CurveReserves, bps: FeeSchedule): { q: bigint; t: bigint; paid: bigint } {
  const net0 = (spend * BASIS_POINTS) / (BASIS_POINTS + bps.protocol + bps.creator);
  const protocolFee = feeAmount(net0, bps.protocol);
  const creatorFee = feeAmount(net0, bps.creator);
  const excess = net0 + protocolFee + creatorFee > spend ? net0 + protocolFee + creatorFee - spend : 0n;
  const q0 = net0 - excess;
  const t = tokensForQuote(q0, s);
  if (t > s.rt) {
    const capped = s.rt;
    if (capped === 0n) return { q: 0n, t: 0n, paid: 0n };
    const q = quoteToBuyTokens(capped, s);
    return { q, t: capped, paid: q + feeAmount(q, bps.protocol) + feeAmount(q, bps.creator) };
  }
  return { q: q0, t, paid: q0 + protocolFee + creatorFee };
}

function priceSell(t: bigint, s: CurveReserves, bps: FeeSchedule): { q: bigint; proceeds: bigint } {
  const q = quoteForSell(t, s);
  return { q, proceeds: q - feeAmount(q, bps.protocol) - feeAmount(q, bps.creator) };
}

/** Fold our fills' displacement into a curve's reserves, scaled so real reserves stay non-negative. */
function applyShift(r: CurveReserves, off: Displacement): CurveReserves {
  let num = 1n;
  let den = 1n;
  if (off.tokens > r.rt) {
    num = r.rt;
    den = off.tokens;
  }
  if (off.quote < 0n && r.rq * den < num * -off.quote) {
    num = r.rq;
    den = -off.quote;
  }
  const scale = (x: bigint): bigint => (num === den ? x : x >= 0n ? (x * num) / den : -((-x * num) / den));
  const q = scale(off.quote);
  const t = scale(off.tokens);
  return { vq: r.vq + q, rq: r.rq + q, vt: r.vt - t, rt: r.rt - t };
}

// ---------------------------------------------------------------- simulation

interface MintBook {
  state: CurveReserves;
  stateSlot: number;
  lastTrade: any | null;
  lastTradeSlot: number;
  complete: boolean;
  offset: Displacement;
}

interface QueuedOrder {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decision: CurveReserves | null;
}

export interface SimResult {
  netPnl: bigint;
  fills: number;
  mints: number;
  rejected: number;
  failed: number;
  maxDrawdown: number;
  trips: { mint: string; open: number; close: number; pnl: bigint }[];
  perMint: Map<string, bigint>;
  rejectReasons: Record<string, number>;
}

export interface SimOptions {
  /** Key to draw failures from; null turns the failed-tx draw off. */
  failKey?: bigint | null;
  /** Scale every fee (curve fees and tx fees) by this — 2n scores the 2x-fees sensitivity. */
  feeMultiplier?: bigint;
}

export function simulate(ds: Dataset, hello: Hello, bot: Bot, opts: SimOptions = {}): SimResult {
  const failureKey = opts.failKey === undefined ? deriveU64(BigInt(hello.seed), PUBLIC_FAIL_TAG) : opts.failKey;
  const feeScale = opts.feeMultiplier ?? 1n;
  const perTxFee = (BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports)) * feeScale;
  const delay = hello.latency_slots;
  const limits = hello.caps;
  const books = new Map<string, MintBook>();
  const queue: QueuedOrder[] = [];
  const seenClientIds = new Set<string>();
  const holdings = new Map<string, { tokens: bigint; cost: bigint }>();
  const initialCash = BigInt(hello.capital.lamports);
  let balance = initialCash;
  let outbound: Fill[] = [];
  let batchSeq = 0;
  let forcedSeq = 0;
  const batchSpend = { seq: -1, byMint: new Map<string, bigint>() };
  let fillCount = 0;
  let rejectCount = 0;
  let failCount = 0;
  const rejectionTally: Record<string, number> = {};
  const touchedMints = new Set<string>();
  const pnlByMint = new Map<string, bigint>();
  const openTrips = new Map<string, { pnl: bigint; open: number }>();
  const closedTrips: SimResult['trips'] = [];
  let equityPeak = initialCash;
  let worstDrawdown = 0;

  const recordFlow = (mint: string, d: bigint): void => {
    pnlByMint.set(mint, (pnlByMint.get(mint) ?? 0n) + d);
    const trip = openTrips.get(mint);
    if (trip) trip.pnl += d;
  };
  const finishTrip = (mint: string, slot: number): void => {
    const trip = openTrips.get(mint);
    if (!trip) return;
    closedTrips.push({ mint, open: trip.open, close: slot, pnl: trip.pnl });
    openTrips.delete(mint);
  };
  const effectiveReserves = (book: MintBook): CurveReserves => applyShift(book.state, book.offset);
  const feesForLanding = (landing: any | null): FeeSchedule =>
    landing !== null && BigInt(landing.fee_basis_points) > 0n
      ? { protocol: BigInt(landing.fee_basis_points) * feeScale, creator: BigInt(landing.creator_fee_basis_points) * feeScale }
      : { protocol: BigInt(hello.fees.protocol_bps_fallback) * feeScale, creator: BigInt(hello.fees.creator_bps_fallback) * feeScale };
  const applyImpact = (book: MintBook, isBuy: boolean, q: bigint, t: bigint): void => {
    book.offset = isBuy
      ? { quote: book.offset.quote + q, tokens: book.offset.tokens + t }
      : { quote: book.offset.quote - q, tokens: book.offset.tokens - t };
  };
  const quoteToClose = (
    book: MintBook,
    tokens: bigint,
    s: CurveReserves = effectiveReserves(book),
  ): { q: bigint; proceeds: bigint; net: bigint; abandon: boolean } => {
    const bps = feesForLanding(book.lastTrade);
    const raw = priceSell(tokens, s, bps);
    const q = raw.q > s.rq ? s.rq : raw.q;
    const proceeds = q - feeAmount(q, bps.protocol) - feeAmount(q, bps.creator);
    return { q, proceeds, net: proceeds - perTxFee, abandon: proceeds - perTxFee <= 0n };
  };
  const currentEquity = (): bigint => {
    let equity = balance;
    for (const [mint, pos] of holdings) {
      const quote = quoteToClose(books.get(mint)!, pos.tokens);
      if (!quote.abandon) equity += quote.net;
    }
    return equity;
  };
  const trackEquity = (equity: bigint): void => {
    if (equity > equityPeak) equityPeak = equity;
    const dd = Number(equityPeak - equity) / Number(equityPeak);
    if (dd > worstDrawdown) worstDrawdown = dd;
  };
  const openPositionCount = (): number => {
    let count = 0;
    for (const pos of holdings.values()) if (pos.tokens > 0n) count++;
    return count;
  };
  const drawFailed = (p: QueuedOrder): boolean =>
    failureKey !== null && deriveU64(failureKey, FAILED_TX_TAG, BigInt(p.seq), BigInt(p.index)) % 10_000n < BigInt(hello.fees.failed_tx_bps);
  const emitFill = (p: QueuedOrder, status: Fill['status'], reason: string | null, quote: bigint, tokens: bigint): void => {
    if (status === 'rejected') {
      rejectCount++;
      rejectionTally[reason!] = (rejectionTally[reason!] ?? 0) + 1;
    }
    if (status === 'failed') failCount++;
    if (status === 'filled') {
      fillCount++;
      touchedMints.add(p.order.mint);
    }
    outbound.push({
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status,
      reason: reason as Fill['reason'],
      decided_slot: p.decidedSlot,
      slot: p.fillSlot,
      quote_lamports: quote.toString(),
      token_amount: tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: status === 'rejected' ? '0' : perTxFee.toString(),
      fee_fallback: false,
    });
  };

  const resolve = (p: QueuedOrder): void => {
    if (p.reject !== null) return emitFill(p, 'rejected', p.reject, 0n, 0n);
    const book = books.get(p.order.mint)!;
    if (book.complete) return emitFill(p, 'rejected', 'token_complete', 0n, 0n);
    const landing = book.lastTradeSlot === p.fillSlot ? book.lastTrade : null;
    const bps = feesForLanding(landing);
    const slip = BigInt(p.order.max_slippage_bps);
    const decision = p.decision!;
    const s = effectiveReserves(book);
    if (p.order.side === 'sell') {
      const pos = holdings.get(p.order.mint);
      const t = BigInt(p.order.token_amount);
      if (pos === undefined || pos.tokens < t) return emitFill(p, 'rejected', 'insufficient_tokens', 0n, 0n);
      const sq = priceSell(t, s, bps);
      if (sq.q > s.rq) return emitFill(p, 'rejected', 'max_order_size', 0n, 0n);
      if (sq.proceeds <= 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
      const expected = priceSell(t, decision, bps).proceeds;
      if (sq.proceeds * BASIS_POINTS < expected * (BASIS_POINTS - slip)) return emitFill(p, 'rejected', 'max_slippage', 0n, 0n);
      if (balance < perTxFee) return emitFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
      if (drawFailed(p)) {
        balance -= perTxFee;
        recordFlow(p.order.mint, -perTxFee);
        return emitFill(p, 'failed', null, 0n, 0n);
      }
      balance += sq.proceeds - perTxFee;
      recordFlow(p.order.mint, sq.proceeds - perTxFee);
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      applyImpact(book, false, sq.q, t);
      if (pos.tokens === 0n) {
        holdings.delete(p.order.mint);
        finishTrip(p.order.mint, p.fillSlot);
      }
      return emitFill(p, 'filled', null, sq.proceeds, t);
    }
    const spend = BigInt(p.order.quote_lamports);
    const held = holdings.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && openPositionCount() >= limits.max_open_positions) {
      return emitFill(p, 'rejected', 'max_open_positions', 0n, 0n);
    }
    if (batchSpend.seq !== p.seq) {
      batchSpend.seq = p.seq;
      batchSpend.byMint.clear();
    }
    const total = (batchSpend.byMint.get(p.order.mint) ?? 0n) + spend;
    if (total * BASIS_POINTS > decision.rq * BigInt(limits.max_order_bps_of_real_reserve)) {
      return emitFill(p, 'rejected', 'max_order_size', 0n, 0n);
    }
    batchSpend.byMint.set(p.order.mint, total);
    const bq = priceBuyExactIn(spend, s, bps);
    if (bq.t === 0n) return emitFill(p, 'rejected', 'zero_amount', 0n, 0n);
    const expected = priceBuyExactIn(spend, decision, bps).t;
    if (bq.t * BASIS_POINTS < expected * (BASIS_POINTS - slip)) return emitFill(p, 'rejected', 'max_slippage', 0n, 0n);
    if (balance < spend + perTxFee) return emitFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
    if (drawFailed(p)) {
      balance -= perTxFee;
      recordFlow(p.order.mint, -perTxFee);
      return emitFill(p, 'failed', null, 0n, 0n);
    }
    balance -= bq.paid + perTxFee;
    let pos = held;
    const opening = pos === undefined || pos.tokens === 0n;
    if (pos === undefined) {
      pos = { tokens: 0n, cost: 0n };
      holdings.set(p.order.mint, pos);
    }
    if (opening) openTrips.set(p.order.mint, { pnl: 0n, open: p.fillSlot });
    recordFlow(p.order.mint, -(bq.paid + perTxFee));
    pos.tokens += bq.t;
    pos.cost += bq.paid;
    applyImpact(book, true, bq.q, bq.t);
    return emitFill(p, 'filled', null, bq.paid, bq.t);
  };

  const forceClose = (mint: string, why: string, slot: number): void => {
    const pos = holdings.get(mint)!;
    const book = books.get(mint)!;
    const quote = quoteToClose(book, pos.tokens);
    const n = forcedSeq++;
    const kind = quote.abandon ? 'writeoff' : why;
    if (!quote.abandon) {
      balance += quote.net;
      recordFlow(mint, quote.net);
      applyImpact(book, false, quote.q, pos.tokens);
    }
    outbound.push({
      client_id: `_${kind}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: quote.abandon ? '0' : quote.proceeds.toString(),
      token_amount: pos.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: quote.abandon ? '0' : perTxFee.toString(),
      fee_fallback: false,
    });
    holdings.delete(mint);
    finishTrip(mint, slot);
  };

  const snapshotAccount = (): { cash_lamports: string; positions: { mint: string; token_amount: string; cost_lamports: string }[] } => ({
    cash_lamports: balance.toString(),
    positions: [...holdings.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mint, pos]) => ({ mint, token_amount: pos.tokens.toString(), cost_lamports: pos.cost.toString() })),
  });
  const buildMarks = (): Mark[] => {
    const wanted = new Set<string>(holdings.keys());
    for (const p of queue) if (books.has(p.order.mint)) wanted.add(p.order.mint);
    return [...wanted].sort().map((mint) => {
      const book = books.get(mint)!;
      const s = effectiveReserves(book);
      return {
        mint,
        slot: book.stateSlot,
        virtual_token_reserves: s.vt.toString(),
        virtual_quote_reserves: s.vq.toString(),
        real_token_reserves: s.rt.toString(),
        real_quote_reserves: s.rq.toString(),
      };
    });
  };

  const state = new BotState(hello);
  bot.onHello?.(state);
  for (const b of ds.batches) {
    const x = b.slot;
    while (queue.length > 0 && queue[0]!.fillSlot < x) {
      const p = queue.shift()!;
      resolve(p);
    }
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.event === 'CreateEvent') {
        books.set(e.mint, {
          state: { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves) },
          stateSlot: x,
          lastTrade: null,
          lastTradeSlot: -1,
          complete: false,
          offset: { quote: 0n, tokens: 0n },
        });
      } else if (e.event === 'TradeEvent') {
        const book = books.get(e.mint)!;
        book.state = {
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
          rq: BigInt(e.real_quote_reserves),
          rt: BigInt(e.real_token_reserves),
        };
        book.stateSlot = x;
        book.lastTrade = e;
        book.lastTradeSlot = x;
      } else {
        books.get(e.mint)!.complete = true;
        completed.push(e.mint);
      }
    }
    for (const mint of completed) if (holdings.has(mint)) forceClose(mint, 'complete', x);
    while (queue.length > 0 && queue[0]!.fillSlot === x) resolve(queue.shift()!);
    const batch: Batch = { type: 'batch', seq: batchSeq, slot: x, events: b.events, marks: buildMarks(), fills: outbound, account: snapshotAccount() };
    outbound = [];
    trackEquity(currentEquity());
    state.applyBatch(batch);
    const orders = state.toOrders(bot.onBatch(state, batch) as any);
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let reject: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= limits.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (seenClientIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!books.has(order.mint)) reject = 'not_in_universe';
      seenClientIds.add(order.client_id);
      const book = books.get(order.mint);
      queue.push({ order, seq: batchSeq, index, decidedSlot: x, fillSlot: x + delay, reject, decision: book ? effectiveReserves(book) : null });
    });
    batchSeq++;
  }
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (p.fillSlot > ds.endSlot) emitFill(p, 'rejected', 'after_end', 0n, 0n);
    else resolve(p);
  }
  for (const mint of [...holdings.keys()].sort()) forceClose(mint, 'flatten', ds.endSlot);
  trackEquity(balance);
  return { netPnl: balance - initialCash, fills: fillCount, mints: touchedMints.size, rejected: rejectCount, failed: failCount, maxDrawdown: worstDrawdown, trips: closedTrips, perMint: pnlByMint, rejectReasons: rejectionTally };
}
