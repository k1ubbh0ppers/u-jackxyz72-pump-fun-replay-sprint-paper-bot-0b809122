// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// A sniper-style bot: it takes one early, small, fixed-size stake in a young
// bonding curve, then leaves quickly through take-profit / stop-loss /
// trailing-stop / max-hold exits. All trading decisions live in strategy.ts;
// the SDK shim (vendor/makefun-bot.ts) handles the wire — it reads the hello,
// then one batch per slot, and writes exactly one orders reply per batch.
//
// The grader runs `node /bot/main.ts`. Deterministic: no clock, no randomness,
// no I/O.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
