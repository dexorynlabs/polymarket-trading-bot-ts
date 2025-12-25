# Polymarket Copy Trading Bot

Automated copy trading bot for Polymarket with advanced features: adaptive take-profit, trailing stops, and smart position management.

## Features

- 🐋 **Copy Trading** — Monitor successful traders and mirror their positions
- 📊 **Proportional Sizing** — Scale trades based on your balance
- 🎯 **Adaptive Take-Profit** — Dynamic limit orders that adjust with market
- 📉 **Trailing Stop** — Lock in profits with configurable trailing stops (25% for sports)
- 🔄 **Smart Exits** — Emergency market sells on significant drops
- ⏱️ **Cooldown System** — Prevent re-entry after closing positions (default 30 min)
- 🚫 **Position Limits** — Max buys per token to prevent overexposure
- 💾 **State Persistence** — Recovers tracked positions after restart
- 📈 **Real-time P&L** — Track wins/losses and session performance

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp env.example .env
# Edit .env with your credentials

# 3. Setup configuration
cp config.example.json config.json
# Add wallet addresses to track

# 4. Build and run
npm run build
npm run bot
```

## Configuration

### Environment Variables (.env)

```env
# Required
PRIVATE_KEY=0xYourPrivateKey              # Your wallet private key
FUNDER_ADDRESS=0xYourPolymarketProxy      # Your Polymarket trading wallet address

# Optional
POLY_API_KEY=your-api-key                 # Polymarket API key (if needed)
POLY_PASSPHRASE=your-passphrase           # API passphrase
TAKE_PROFIT_PERCENT=15                    # Default take-profit trigger %
DEBUG=false                               # Enable verbose logging
```

**Finding Your FUNDER_ADDRESS:**
1. Go to polymarket.com and connect wallet
2. Open browser console
3. Check network requests for your proxy wallet address
4. Or leave empty - bot will try to detect it automatically

### Trading Settings (config.json)

```json
{
  "wallets_to_track": [
    "0x1234567890abcdef1234567890abcdef12345678",
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  ],
  "mode": "proportional",
  "min_stake": 5,
  "max_stake": 300,
  "max_buys_per_token": 3,
  "cooldown_minutes": 30,
  "trailing_stop_percent": 15,
  "skip_sports": false
}
```

**Settings Explained:**
- `wallets_to_track` — Wallet addresses to copy trades from
- `mode` — `"proportional"` or `"fixed"`
- `min_stake` — Minimum order size (must be ≥ $5 for Polymarket)
- `max_stake` — Maximum order size per trade
- `max_buys_per_token` — Limit buys for same token (prevents spam)
- `cooldown_minutes` — Wait time before re-entering same market
- `trailing_stop_percent` — % drop from peak to trigger sell (sports: 25%)
- `skip_sports` — Skip volatile sports markets

## How It Works

### Copy Trading
1. Bot monitors tracked wallets every 10 seconds
2. When tracked wallet buys → bot copies with proportional sizing
3. When tracked wallet sells → bot sells matching position
4. Automatically pauses when balance < min_stake

### Take-Profit System
1. **Tracking Trigger**: Starts tracking at +15% profit (configurable)
2. **Dynamic Orders**: Places limit orders 2% below current price
3. **Trailing Stop**: Sells if price drops 15% from peak (25% for sports)
4. **Price Updates**: Adjusts orders as price moves up
5. **Emergency Exit**: Market sell if trailing stop triggered or max update attempts reached

### Position Management
- **Max 5 update attempts** per position before forced exit
- **Cooldown after close** to prevent immediate re-entry
- **State persistence** survives bot restarts
- **Smart error handling** for closed/resolved markets

## Finding Smart Wallets to Track

- **Polymarket Leaderboard**: https://polymarket.com/leaderboard
- **Predictfolio**: https://predictfolio.com/
- **Polymarket Activity**: https://polymarket.com/activity

Look for wallets with:
- High win rate (>60%)
- Consistent returns
- Active trading history
- Similar risk tolerance to yours

## Commands

| Command | Description |
|---------|-------------|
| `npm run bot` | Start copy trading bot |
| `npm run balance` | Check wallet balance and allowances |
| `npm run cli set-allowances` | Setup trading permissions |
| `npm run cli close-all` | Emergency close all positions |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Development mode with auto-reload |

## Requirements

- **Node.js** 18+ 
- **Polymarket Account** with USDC deposited
- **MetaMask** or compatible Web3 wallet
- **Trading Allowances** set (run `npm run cli set-allowances`)

## Troubleshooting

### "API timeout" errors
- Reduce polling frequency in bot.ts
- API has rate limits, timeouts are normal and automatically retried

### "Min $5" errors on sell
- Positions must have ≥5 shares to sell via API
- Increase `min_stake` to 6-7 to ensure sufficient shares

### "not enough balance / allowance"
- For BUY: deposit more USDC
- For SELL: run `npm run cli set-allowances`

### Position not selling at profit
- Check `take-profit-state.json` for tracking status
- Verify position still exists (not manually closed)
- Sports markets may need wider trailing stop (25%)

## Safety Features

- **Cached Balance**: Reduces API calls (30s TTL)
- **Retry Logic**: Automatic retry on network/API errors (3 attempts)
- **Error Recovery**: Continues on temporary failures
- **State Backup**: Positions saved every 30 seconds
- **Rate Limiting**: Configurable polling intervals

## Performance Tips

1. **Start Small**: Test with min_stake = $5-10
2. **Diversify**: Track 3-5 successful traders
3. **Set Limits**: Use max_buys_per_token to prevent overexposure
4. **Monitor API**: Watch for timeout errors, adjust intervals if needed
5. **Review Stats**: Check wins/losses regularly

## Architecture

```
src/
├── bot.ts           # Main orchestrator
├── watcher.ts       # Monitors wallet trades
├── executor.ts      # Executes trades
├── trader.ts        # CLOB API interface
├── take-profit.ts   # Adaptive TP manager
├── pnl-tracker.ts   # P&L calculation
├── api.ts           # Polymarket data API
└── wallet.ts        # Wallet management
```

## API Rate Limits

The bot makes approximately:
- **60-90 requests/minute** to Polymarket APIs
- Automatic retry on timeouts/errors
- Increase polling intervals if hitting limits

## License

MIT - See LICENSE file

## Disclaimer

**Use at your own risk.** Trading prediction markets involves substantial risk of loss. This bot is for educational purposes. The authors are not responsible for any financial losses incurred through the use of this software.

## Contributing

Issues and pull requests welcome!

## Support

For issues, please open a GitHub issue with:
- Error message or unexpected behavior
- Your configuration (without private keys!)
- Steps to reproduce
