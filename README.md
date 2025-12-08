# Polymarket Sniper Bot

Automated sniper bot for Polymarket. Monitors the mempool and Polymarket API for pending trades, then executes orders with higher priority to frontrun target transactions.

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your wallet and trader addresses

# Run the bot
npm run build && npm start
```

## Configuration

Required environment variables:

```env
TARGET_ADDRESSES=0xabc...,0xdef...    # Target addresses to frontrun (comma-separated)
PUBLIC_KEY=your_bot_wallet            # Public address of ur bot wallet will be used for copytrading
PRIVATE_KEY=your_bot_wallet_privatekey   # Privatekey of above address
RPC_URL=https://polygon-mainnet...  # Polygon RPC endpoint (must support pending tx monitoring)
```

Optional settings:

```env
FETCH_INTERVAL=1                    # Polling interval (seconds)
MIN_TRADE_SIZE_USD=100              # Minimum trade size to frontrun (USD)
FRONTRUN_SIZE_MULTIPLIER=0.5        # Frontrun size as % of target (0.0-1.0)
GAS_PRICE_MULTIPLIER=1.2            # Gas price multiplier for priority (e.g., 1.2 = 20% higher)
USDC_CONTRACT_ADDRESS=0x2791...     # USDC contract (default: Polygon mainnet)
```

## Finding Target Wallets

To identify successful traders to track, you can use these resources:

- **Polymarket Leaderboard**: https://polymarket.com/leaderboard - Official leaderboard showing top performers on Polymarket
- **Predictfolio**: https://predictfolio.com/ - Analytics platform for prediction market traders and portfolios

## Features

- Mempool monitoring for pending transactions
- Real-time trade detection via API and mempool
- Priority execution with configurable gas pricing
- Automatic frontrun order execution
- Configurable frontrun size and thresholds
- Error handling and retries

## Requirements

- Node.js 18+
- Polygon wallet with USDC balance
- POL/MATIC for gas fees

## Scripts

- `npm run dev` - Development mode
- `npm run build` - Compile TypeScript
- `npm start` - Production mode
- `npm run lint` - Run linter

## Documentation

See [GUIDE.md](./GUIDE.md) for detailed setup, configuration, and troubleshooting.

## License

Apache-2.0

## Contact

For support or questions, reach out on Telegram: [@jackthem](https://t.me/jackthem)

## Disclaimer

This software is provided as-is. Trading involves substantial risk. Use at your own risk.
