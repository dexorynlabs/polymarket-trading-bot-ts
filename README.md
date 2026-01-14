# 🐋 Polymarket Copy Trading Bot

**📬 Contact:** [Your Contact Here]

Advanced automated copy trading bot for Polymarket prediction markets. Monitors whale wallets and copies their trades with intelligent position sizing, adaptive take-profit, and trailing stop-loss protection.

## ✨ Features

### Core Trading
- **🎯 Smart Copy Trading** — Real-time monitoring of whale wallets with instant trade replication
- **📊 Proportional Sizing** — Automatically scales trade sizes based on your balance vs whale's
- **🔄 Position Limits** — Configurable max buys per token to prevent overexposure
- **⏱️ Cooldown System** — Prevents rapid rebuying of the same position
- **⏸️ Auto-Pause** — Stops buying when balance drops below minimum stake

### Advanced Take-Profit System
- **📈 Adaptive Trailing Stop** — Dynamic stop-loss that tracks peak prices
  - Default: 15% trailing stop from peak
  - Sports markets: 25% trailing stop (higher volatility tolerance)
- **💰 Profit Triggers** — Automatically activates at +15% profit
- **🔄 Smart Order Updates** — Repositions orders as market moves up
- **🚨 Emergency Exit** — Aggressive market sells when stop-loss triggered
- **💾 State Persistence** — Saves tracking state for recovery after restart
- **⚡ Fast Monitoring** — 3-second checks for volatile markets

### Risk Management
- **🛡️ Position-Based Stops** — Protects profits without closing at a loss
- **📉 Stop-Loss Protection** — Configurable stop-loss percentage (can be disabled)
- **🏀 Sports Market Detection** — Wider stops for high-volatility sports markets
- **🔢 Decimal Precision** — Proper rounding for API compliance (SELL: 2 decimals, BUY: 4 decimals)

### Session Tracking
- **📊 Real-Time P&L** — Live session profit/loss tracking
- **🏆 Win/Loss Stats** — Track winning and losing trades
- **💵 Balance Monitoring** — Real-time USDC and position value display

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Setup environment
cp env.example .env
# Edit .env with your private key and wallet address

# Configure tracking (edit config.json)
# Add whale wallets, adjust stake sizes, set limits
cp config.example.json config.json

# Build and run
npm run build
npm run bot
```

## ⚙️ Configuration

### Environment Variables (.env)

```env
PRIVATE_KEY=0xYourPrivateKey        # MetaMask/Wallet private key
FUNDER_ADDRESS=0xYourTradingWallet  # Polymarket wallet address
TAKE_PROFIT_PERCENT=15              # Profit trigger threshold (%)
DEBUG=false                         # Enable verbose logging
```

### Trading Settings (config.json)

```json
{
  "wallets_to_track": [
    "0x33f6d97080e5215eb2cf679531496ace0330e0de"
  ],
  "mode": "proportional",           // Sizing mode
  "min_stake": 7,                   // Minimum trade size (USDC)
  "max_stake": 300,                 // Maximum trade size (USDC)
  "max_buys_per_token": 3,          // Max positions per token
  "cooldown_minutes": 30,           // Rebuy cooldown period
  "stop_loss_percent": 15,          // Trailing stop % (default)
  "stop_loss_enabled": true,        // Enable/disable stop-loss
  "skip_sports": false              // Skip sports markets
}
```

### Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `min_stake` | 7 | Minimum trade size in USDC |
| `max_stake` | 300 | Maximum trade size in USDC |
| `max_buys_per_token` | 3 | Max number of buys for same token |
| `cooldown_minutes` | 30 | Minutes before allowing rebuy |
| `stop_loss_percent` | 15 | Trailing stop % from peak (default markets) |
| `stop_loss_enabled` | true | Enable automatic stop-loss exits |
| `skip_sports` | false | Skip sports markets entirely |

**Note:** Sports markets automatically use 25% trailing stop regardless of `stop_loss_percent` setting.

## 📖 How It Works

### Trading Flow

1. **Monitor** — Bot polls tracked wallets every 5 seconds for new trades
2. **Analyze** — Validates trade against position limits and cooldown rules
3. **Size** — Calculates proportional stake based on balance ratio
4. **Execute** — Places market order matching whale's side (BUY/SELL)
5. **Track** — Monitors position for take-profit opportunities
6. **Exit** — Automatically sells when profit target or stop-loss triggers

### Take-Profit Logic

```
1. Position reaches +15% profit → Start tracking
2. Price continues up → Update trailing stop to track new peaks
3. If price drops 15% from peak → Trigger stop-loss
4. Place limit order 2% below current price
5. If order not filled → Update price or emergency exit
```

### Position Management

- **Multiple Buys**: Bot can buy same token up to 3 times (configurable)
- **Cooldown Protection**: 30-minute cooldown prevents rapid rebuying
- **Per-Wallet Tracking**: Sells only match specific wallet's position
- **State Persistence**: Tracking survives bot restarts

## 🔍 Finding Whale Wallets

**Top Traders**
- [Polymarket Leaderboard](https://polymarket.com/leaderboard) — Official rankings
- [Predictfolio](https://predictfolio.com/) — Analytics and insights

**Tips**
- Look for consistent profit over volume
- Track multiple whales for diversification
- Monitor their sports vs politics preferences
- Check average position sizes vs your budget

## 📜 Commands

| Command | Description |
|---------|-------------|
| `npm run bot` | Start the trading bot |
| `npm run balance` | Check wallet balance and positions |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run dev` | Development mode with hot reload |
| `npm run clean` | Remove compiled files |

## 🏗️ Architecture

```
src/
├── main.ts           # CLI entry point
├── bot.ts            # Main bot orchestrator
├── watcher.ts        # Wallet monitoring
├── trader.ts         # Trade execution (CLOB API)
├── executor.ts       # Position management
├── take-profit.ts    # Adaptive take-profit system
├── sizing.ts         # Proportional sizing logic
├── risk.ts           # Risk management rules
├── pnl-tracker.ts    # P&L and stats tracking
├── wallet.ts         # Wallet and balance management
├── api.ts            # Polymarket REST API
└── config.ts         # Configuration loading
```

## 📋 Requirements

- **Node.js** 18+ (with ESM support)
- **Polymarket Account** with USDC funded
- **MetaMask Wallet** linked to Polymarket
- **Private Key** exported from MetaMask

## 🐛 Troubleshooting

### Common Issues

**"Order failed: invalid amounts"**
- Fixed in latest version with proper decimal rounding
- Rebuild: `npm run build`

**"Not enough balance"**
- Check balance: `npm run balance`
- Deposit more USDC to Polymarket
- Lower `min_stake` in config.json

**"Position likely closed"**
- Take-profit already executed by smart contract
- Position was manually closed on Polymarket
- Bot will auto-cleanup tracking

**"502/503 CLOB errors"**
- Automatic retry logic handles temporary API issues
- If persistent, check Polymarket API status

## ⚠️ Risk Warning

**This bot is for educational purposes. Trading prediction markets involves substantial risk of loss.**

- Start with small stakes to test
- Never trade more than you can afford to lose
- Whale wallets can be wrong
- Markets can gap against you
- API issues can prevent exits
- Test thoroughly before scaling up

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

Issues and pull requests welcome! Please test thoroughly before submitting.

## 💡 Tips

- Start with `min_stake: 7` and `max_stake: 50` until comfortable
- Enable stop-loss initially: `stop_loss_enabled: true`
- Track 2-3 whales maximum to start
- Monitor first few days closely
- Keep at least 2x `max_stake` in balance for opportunities
- Sports markets are more volatile — use with caution

## 📈 Roadmap

- [ ] Web dashboard for monitoring
- [ ] Multi-wallet support (multiple trading accounts)
- [ ] Advanced analytics and backtesting
- [ ] Discord/Telegram notifications
- [ ] Custom strategy scripts
- [ ] Paper trading mode

---

**Built with TypeScript + Polymarket CLOB API**
