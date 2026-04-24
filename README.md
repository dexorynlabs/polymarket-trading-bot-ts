# Polymarket copy trading bot (TypeScript)

[Dexoryn Labs](https://github.com/dexorynLabs) — see repository for updates. **Warning:** this software is for education and research. Prediction markets are risky; you can lose your stake.

A Polymarket CLOB copy-trading tool: it follows configured wallet addresses, sizes orders relative to your balance, and can manage exits with take-profit and trailing stop logic.

## Features

- **Copy trading** — Polls public trade activity for whitelisted addresses and mirrors BUY/SELL on the CLOB.
- **Sizing** — `fixed` or `proportional` stake between `min_stake` and `max_stake`.
- **Position limits** — `max_buys_per_token` and per-token cooldown after a position is closed.
- **Take-profit / trailing stop** — Configurable profit trigger and stop-from-peak; wider behavior on sports slugs (see `take-profit.ts` / `bot.ts`).
- **Session P&L** — Tracks session stats while the process runs.
- **CLI** — Wallets, balance, readiness, allowances (relayer), and `close-all`.

## Requirements

- **Node.js** 18+  
- A Polymarket account with **USDC**, **private key** (signing), and **FUNDER_ADDRESS** (Polymarket trading / proxy address as shown on the site).

## Quick start

```bash
npm install

cp env.example .env
# Set PRIVATE_KEY and FUNDER_ADDRESS in .env

cp config.example.json config.json
# Set wallets_to_track and risk parameters

npm run build

npm run cli check-ready
npm run cli set-allowances   # once, if you use the relayer path

npm run bot
# or: npm start   (uses compiled dist/main.js)
```

**Windows:** `npm run clean` removes the `dist` folder (no Unix `rm` required).

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | EOA private key (0x-prefixed) for signing. |
| `FUNDER_ADDRESS` | Yes* | Polymarket wallet address (needed for CLOB/relayer flows). *Required for `set-allowances` and normal trading per code paths. |
| `TAKE_PROFIT_PERCENT` | No | Profit trigger (%). Overrides `profit_take_percent` in config when set. |
| `DEBUG` | No | `true` for verbose error detail in logs. |

## `config.json`

Copy from `config.example.json`. All boolean/number fields should be valid JSON (no `//` comments in the file).

| Field | Description |
|--------|-------------|
| `wallets_to_track` | List of 0x addresses to follow. |
| `mode` | `proportional` or `fixed` (use `fixed_stake` when `fixed`). |
| `min_stake` / `max_stake` | USDC bounds for order size. |
| `max_buys_per_token` | Max BUY entries for the same token. |
| `cooldown_minutes` | After a position is treated as closed, wait before re-buying the same token. |
| `stop_loss_percent` / `stop_loss_enabled` | Trailing stop from peak; can be disabled. |
| `skip_sports` | If true, skips BUYs on markets detected as sports by slug patterns. |
| `profit_take_percent` | Default take-profit / tracking threshold when `TAKE_PROFIT_PERCENT` is unset. |

## CLI commands

| Command | Description |
|---------|-------------|
| `npm run bot` | Start the bot (`tsx src/main.ts start`). |
| `npm run cli start` | Same as `bot`. |
| `npm run cli check-ready` | Balances, CLOB, allowances. |
| `npm run cli set-allowances` | Set allowances via relayer (requires `FUNDER_ADDRESS`). |
| `npm run cli balance` | Show balance / positions. |
| `npm run cli wallets add 0x…` | Add a tracked address. |
| `npm run cli wallets list` | List tracked addresses. |
| `npm run cli wallets remove 0x…` | Remove an address. |
| `npm run cli config` | View or set config fields (see `--help`). |
| `npm run cli status` | Show env + config summary. |
| `npm run cli close-all --yes` | Market-close open positions (destructive; confirms with `--yes`). |
| `npm run dev` / `npm run build` / `npm run clean` | Develop, compile, clean `dist`. |

## How it works (high level)

1. `WalletWatcher` polls recent trades for each tracked address.  
2. `TradeInterpreter` maps API events to a normalized trade.  
3. `PositionSizer` enforces min/max and proportional sizing.  
4. `TradeExecutor` / `RealTrader` submit CLOB orders with retries on transient API errors.  
5. `TakeProfitManager` monitors open positions and may place exit orders per your thresholds.

## Project layout

```text
src/
  main.ts          # entry — loads .env, runs CLI
  cli.ts           # Commander: start, balance, wallets, check-ready, etc.
  bot.ts           # startBot: watcher + execution loop
  watcher.ts       # trade polling
  executor.ts      # position/trade coordination
  trader.ts        # CLOB order placement
  take-profit.ts   # profit / stop monitoring
  sizing.ts        # stake calculation
  interpreter.ts   # normalize watch events
  api.ts           # data-api, gamma-api HTTP client
  wallet.ts        # keys, CLOB client, balance
  relayer.ts       # allowance helper
  pnl-tracker.ts   # session P&L
  stats.ts         # trade event stats
  config.ts        # default config and loadConfig()
  logger.ts        # debug-aware logging
```

## Troubleshooting

- **“PRIVATE_KEY not found”** — Create `.env` from `env.example`.  
- **“Not enough balance” / min stake** — Fund Polymarket USDC; lower `min_stake` or top up.  
- **CLOB 502/503** — Transient; the trader retries. Persistent failures: check network and Polymarket status.  
- **Allowances** — Use `check-ready` and either `set-allowances` or complete approvals in the Polymarket UI.

## License

MIT — see [LICENSE](./LICENSE).
