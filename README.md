# Pump.fun Replay Sprint — Paper Bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/k1ubbh0ppers/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/k1ubbh0ppers/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Sniper-style paper trading bot for the make.fun bounty
`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`
(protocol `agent-fun/replay/v2`, harness `pumpfun-replay/v2`).

The grader runs `node /bot/main.ts` (Node 22, TypeScript stripped as-is, zero
dependencies). `main.ts` is just the entrypoint; the trading logic is in
`strategy.ts`; `vendor/makefun-bot.ts` is a byte-identical copy of the kit SDK
shim and handles the wire: it reads the `hello`, then one `batch` per `slot`,
and writes exactly one `orders` reply per batch.

## Strategy

Take one early stake in a young bonding curve (0.05 SOL) and let winners run:

- **Entry** (judged once per coin, age 0–3 slots since its `CreateEvent`): real
  SOL reserve 3–30 SOL, creator buy 0–2.5 SOL, at most 3 distinct non-creator
  buyers, sell ratio and biggest single sell tracked but uncapped in practice,
  no creator sell, price run-up vs create-time price within 0–10000%.
- **Exits**: no take-profit (winners are allowed to run to completion); stop-loss
  −50%; trailing stop armed at +10%, trailing 10% from the best mark-to-market
  value; exit on creator sell after entry; no max hold (the S4 sweep showed any
  finite max hold of 50–500 slots loses ~0.5 SOL — forced exits bleed fees).
- **Position discipline**: at most 5 open positions, at most 16 orders per
  reply, every buy within the 1%-of-real-reserve size cap
  (`state.maxBuyLamports`), never more cash than `state.freeCashLamports()`.
- **Guardrail safety net** (≥20 coins × ≥0.01 SOL round trips, drawdown ≤50%):
  counted coins are paced against the replay window; when the pace lags, one
  slot is reserved for probes and small 0.02 SOL probe buys on liquid curves are
  sold whole as soon as they land. If every slot is held by riders in the second
  half of the window, the worst rider (lowest value/cost) is evicted to free a
  slot — at most one eviction per sell-settlement cycle.

## Determinism

A pure function of the `hello` message and the `batch` stream: no clock, no
`Math.random`, no environment reads, no network, no I/O in `main.ts` /
`strategy.ts`. Iteration only ever walks insertion-ordered maps fed by the batch
stream. Two runs of the backtest produce byte-identical output (verified).

## Local scores (dev window, full 24h, local engine `tools/sim.ts`)

| Bot | Net PnL (SOL) | 2x-fees (SOL) | Fills | Coins | Trips | Wins | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| **This bot (defaults)** | **+0.0449** | **+0.0148** | 39 | 22 | 22 | 9 | 0.0085 |
| pilot sniper (default) | −0.4749 | −0.7918 | 842 | 351 | 351 | 44 | 0.0519 |
| pilot momentum (default) | −9.6861 | −9.9721 | 439 | 49 | 82 | 5 | 0.9713 |
| equal-weight (buy early, hold) | −0.0193 | −0.0219 | 5 | 5 | 5 | 0 | 0.0093 |
| hold cash | 0.0000 | 0.0000 | 0 | 0 | 0 | 0 | 0.0000 |

Robustness across failed-tx draws (fail keys 11/22/33/44 + default seed):
mean net **+0.034 SOL**, worst **−0.030 SOL** (fail key 11), coins **20–23** on every
key (guardrail met on all keys), max drawdown ≤ 0.009. Net PnL without the single
best coin is still **+0.0098 SOL**, so the score is not a one-coin fluke.

Caveats: the dev window is a single 24h sample (2026-11-02..03) and the final
window is different data collected after entries close — dev scores are a guide,
not a promise. The pilot numbers above are measured with this repo's engine on
the full window; the kit's own pilot backtests only score the first data part.

## Tools (dev only, never run by the grader)

```sh
node tools/backtest.ts <kit dir> ['{param overrides}'] [--trips]
node tools/sweep.ts <kit dir> '<base json>' '<grid json>' [top N]
node tools/compare.ts <kit dir>   # this bot vs pilot sniper / momentum / equal-weight / hold cash
node tools/perkey.ts <kit dir>    # per-fail-key net PnL, coins, rider vs probe buys
```

`<kit dir>` is the unpacked kit, e.g.
`~/workspace/makefun/kit_new_u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit`.

## Guardrail checklist

- [x] Net PnL > 0 on the dev window (+0.0449 SOL, beats hold-cash 0)
- [x] ≥ 20 distinct coins with ≥ 0.01 SOL round trips (22; 20–23 across fail keys)
- [x] Max drawdown ≤ 50% (0.0085)
- [x] Deterministic: two runs byte-identical
- [x] MIT LICENSE, entrypoint `main.ts` at repo root
- [x] No network / clock / randomness in the graded code

---

<sub>Entered on [make.fun](https://make.fun/?ref=r9rev335&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
