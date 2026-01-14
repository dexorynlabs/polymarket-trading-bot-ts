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
let skipSports = false;

// Track buy count per token
const tokenBuyCount: Map<string, number> = new Map();

// Track cooldown per token
const tokenCooldown: Map<string, number> = new Map();

// Sports market patterns
const SPORTS_PATTERNS = [
  /^nba-/i, /^nfl-/i, /^nhl-/i, /^mlb-/i, /^ncaa-/i, /^cfb-/i, /^cbb-/i,
  /^epl-/i, /^ucl-/i, /^la-liga-/i, /^serie-a-/i, /^bundesliga-/i, /^bl2-/i, /^mls-/i,
  /^ufc-/i, /^boxing-/i, /-spread-/i, /-moneyline/i, /-total-/i, /-over-under/i,
];

function isSportsMarket(marketSlug: string): boolean {
  return SPORTS_PATTERNS.some(pattern => pattern.test(marketSlug));
}

function onPositionClosed(tokenId: string, _marketSlug: string): void {
  tokenBuyCount.delete(tokenId);
  tokenCooldown.set(tokenId, Date.now() + (cooldownMinutes * 60 * 1000));
}

function isInCooldown(tokenId: string): boolean {
  const cooldownEnd = tokenCooldown.get(tokenId);
  if (!cooldownEnd) return false;
  
  if (Date.now() >= cooldownEnd) {
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
  } catch (error: any) {
    console.log('\n  ❌ Wallet connection failed');
    console.log(`     ${error.message}\n`);
    throw error;
  }

  // Initialize PnL tracker
  const walletAddress = wallet.getProxyAddress() || wallet.getAddress();
  pnlTracker = new PnLTracker(wallet, walletAddress, 30000);
  pnlTracker.setOnPositionClosed(onPositionClosed);
  
  const initialPnL = await pnlTracker.initialize();

  // Initialize CLOB client (silent)
  const { clobAuth } = await import('./logger');
  const credentials = wallet.getPrivateKey();
  clobAuth.authenticate(credentials).catch(() => {});

  // Config values
  const takeProfitPercent = process.env.TAKE_PROFIT_PERCENT 
    ? parseFloat(process.env.TAKE_PROFIT_PERCENT) 
    : (config.profit_take_percent || 15);
  
  const stopLossPercent = config.stop_loss_percent || 15;
  const stopLossEnabled = config.stop_loss_enabled !== false;

  // Initialize components
  const executor = new TradeExecutor(config);
  const sizer = new PositionSizer(config, startBalance);
  const interpreter = new TradeInterpreter();
  const watcher = new WalletWatcher(config.wallets_to_track, 5000, verbose);

  // ═══════════════════════════════════════════════════════════════
  //                         DISPLAY UI
  // ═══════════════════════════════════════════════════════════════
  
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │       🐋 POLYMARKET COPY TRADER         │');
  console.log('  └─────────────────────────────────────────┘');
  console.log('');
  console.log('  ┌─── ACCOUNT ───────────────────────────────');
  console.log(`  │  💵 USDC:      $${initialPnL.usdcBalance.toFixed(2)}`);
  console.log(`  │  📊 Positions: $${initialPnL.positionsValue.toFixed(2)} (${initialPnL.positionCount})`);
  console.log(`  │  💰 Total:     $${initialPnL.currentEquity.toFixed(2)}`);
  console.log('  │');
  console.log('  ├─── SETTINGS ──────────────────────────────');
  console.log(`  │  📊 Stake:      $${config.min_stake} - $${config.max_stake}`);
  console.log(`  │  🎯 Take-profit: +${takeProfitPercent}%`);
  console.log(`  │  📉 Stop-loss:   ${stopLossEnabled ? `${stopLossPercent}%` : 'OFF'}`);
  console.log(`  │  🔄 Max buys:    ${maxBuysPerToken}/token`);
  console.log(`  │  ⏱️  Cooldown:    ${cooldownMinutes} min`);
  if (skipSports) {
    console.log(`  │  🏀 Sports:     SKIP`);
  }
  console.log('  │');
  console.log('  ├─── WALLETS ───────────────────────────────');
  for (const w of config.wallets_to_track) {
    console.log(`  │  👀 ${w}`);
  }
  console.log('  └──────────────────────────────────────────');
  console.log('');

  await executor.initialize();

  // Start take-profit monitor
  if (takeProfitPercent > 0) {
    const takeProfitManager = new TakeProfitManager(
      executor.getTrader(),
      walletAddress,
      takeProfitPercent,
      3000,
      stopLossPercent,
      stopLossEnabled
    );
    takeProfitManager.start().catch(console.error);
  }

  // Start PnL tracker
  pnlTracker.start().catch(console.error);

  // Check initial balance
  if (initialPnL.usdcBalance < minStake) {
    isPaused = true;
    console.log(`  ⏸️  PAUSED — $${initialPnL.usdcBalance.toFixed(2)} < min $${minStake}`);
    console.log('');
  }

  console.log('  📡 Listening...\n');

  // Main loop
  try {
    for await (const event of watcher.stream()) {
      await processTradeEvent(event, interpreter, sizer, executor, verbose, wallet);
    }
  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  }
}

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
  
  // Skip sports if configured
  if (skipSports && trade.side === 'BUY' && isSportsMarket(trade.marketSlug || market)) {
    return;
  }
  
  // Get current balance
  const currentPnL = pnlTracker?.getPnLInfo();
  const currentBalance = currentPnL?.usdcBalance || 0;
  
  // Pause if balance too low
  if (trade.side === 'BUY' && currentBalance < minStake) {
    if (!isPaused) {
      isPaused = true;
      console.log(`\n  ⏸️  PAUSED — $${currentBalance.toFixed(2)} < min $${minStake}\n`);
    }
    return;
  }
  
  // Check cooldown
  if (trade.side === 'BUY' && isInCooldown(trade.tokenId)) {
    return;
  }
  
  // Check buy limit
  if (trade.side === 'BUY') {
    const count = tokenBuyCount.get(trade.tokenId) || 0;
    if (count >= maxBuysPerToken) return;
  }
  
  // Check if worth copying
  const worthCheck = sizer.isWorthCopying(event);
  if (!worthCheck.worth) return;

  const sizing = sizer.calculate(event);
  if (verbose) sizer.displayCalculation(event);
  
  try {
    const result = await executor.openPosition(trade.tokenId, trade.side, sizing.scaledAmount, trade.price, trade.wallet);

    if (result.success) {
      // Update buy count
      if (trade.side === 'BUY') {
        const count = tokenBuyCount.get(trade.tokenId) || 0;
        tokenBuyCount.set(trade.tokenId, count + 1);
      }
      
      // Update PnL
      const newPnL = await pnlTracker?.forceUpdate();
      
      if (newPnL) {
        const buyCount = tokenBuyCount.get(trade.tokenId) || 0;
        const buyInfo = trade.side === 'BUY' ? ` [${buyCount}/${maxBuysPerToken}]` : '';
        const pnlSign = newPnL.sessionPnL >= 0 ? '+' : '';
        
        console.log(`  ✅ ${trade.side} $${sizing.scaledAmount.toFixed(2)} ${market}${buyInfo}`);
        console.log(`     💵 $${newPnL.usdcBalance.toFixed(2)} | 📈 ${pnlSign}$${newPnL.sessionPnL.toFixed(2)} (${newPnL.winCount}W/${newPnL.lossCount}L)`);
        
        sizer.setMyBalance(newPnL.usdcBalance);
        
        // Check pause/resume
        if (newPnL.usdcBalance < minStake && !isPaused) {
          isPaused = true;
          console.log(`\n  ⏸️  PAUSED — $${newPnL.usdcBalance.toFixed(2)} < min $${minStake}\n`);
        }
        
        if (isPaused && newPnL.usdcBalance >= minStake) {
          isPaused = false;
          console.log(`\n  ▶️  RESUMED — $${newPnL.usdcBalance.toFixed(2)}\n`);
        }
      } else {
        console.log(`  ✅ ${trade.side} $${sizing.scaledAmount.toFixed(2)} ${market}`);
      }
      
      recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, true, 'success');
    } else {
      // Skip common errors silently
      const silentErrors = ['Low balance', 'No position', 'not enough balance', 'Min $'];
      const isSilent = silentErrors.some(e => result.error?.includes(e));
      if (!isSilent) {
        console.log(`  ❌ ${trade.side} ${market} — ${result.error}`);
      }
      recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, false, 'failed');
    }
  } catch (error: any) {
    console.log(`  ❌ ${trade.side} ${market} — ${error.message}`);
    recordTradeEvent(trade.wallet, trade.side, trade.usdcAmount, market, false, 'failed');
  }
}

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
