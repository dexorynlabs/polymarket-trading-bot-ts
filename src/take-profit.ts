/**
 * Adaptive Take-Profit Manager with Trailing Stop
 * 
 * Features:
 * 1. Trailing Stop - tracks peak price, sells if drops X% from peak
 * 2. Dynamic order updates - repositions order as price moves
 * 3. Emergency exit - market sell if price falls below order
 * 4. State persistence - saves to file for recovery after restart
 * 5. Frequent checks - monitors every 3 seconds for volatile markets
 * 6. Smart price adjustment - lowers price when market drops
 */

import { PolymarketAPI } from './api';
import { RealTrader } from './trader';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_FILE = join(process.cwd(), 'take-profit-state.json');

// Max attempts to update order before forcing exit
const MAX_UPDATE_ATTEMPTS = 5;

// Sports markets have higher volatility - use wider trailing stop
const SPORTS_TRAILING_STOP = 25; // 25% for sports
const SPORTS_PREFIXES = ['nba-', 'nfl-', 'nhl-', 'mlb-', 'epl-', 'ucl-', 'boxing-', 'ufc-', 'mma-', 'tennis-', 'f1-', 'cricket-', 'soccer-'];

interface Position {
  tokenId: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  profitPercent: number;
  marketSlug: string;
  outcome: string;
}

interface TrackedPosition {
  tokenId: string;
  entryPrice: number;
  size: number;
  highestPrice: number;
  currentOrderId: string | null;
  currentOrderPrice: number;
  marketSlug: string;
  startedAt: string;
  updateAttempts: number;  // Counter for order update attempts
  lastUpdateTime: number;  // Prevent spam updates
}

interface SavedState {
  positions: TrackedPosition[];
  savedAt: string;
}

export class TakeProfitManager {
  private api: PolymarketAPI;
  private trader: RealTrader;
  private walletAddress: string;
  
  // Configuration
  private profitTrigger: number;
  private trailingStopPercent: number;
  private updateThreshold: number;
  private checkIntervalMs: number;
  
  private trackedPositions: Map<string, TrackedPosition> = new Map();
  private isRunning: boolean = false;
  private lastSaveTime: number = 0;

  constructor(
    trader: RealTrader,
    walletAddress: string,
    profitTriggerPercent: number = 15,
    checkIntervalMs: number = 3000,
    trailingStopPercent: number = 15
  ) {
    this.api = new PolymarketAPI();
    this.trader = trader;
    this.walletAddress = walletAddress;
    this.profitTrigger = profitTriggerPercent;
    this.trailingStopPercent = trailingStopPercent;
    this.updateThreshold = 5;        // Update order if price moved 5%+
    this.checkIntervalMs = checkIntervalMs;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    
    // Load saved state
    await this.loadState();
    
    console.log(`  📈 Take-Profit: trigger +${this.profitTrigger}%, trailing ${this.trailingStopPercent}% (sports: ${SPORTS_TRAILING_STOP}%)`);
    if (this.trackedPositions.size > 0) {
      console.log(`  📂 Restored ${this.trackedPositions.size} tracked position(s)`);
    }
    
    while (this.isRunning) {
      await this.checkAndManagePositions();
      await this.saveStateIfNeeded();
      await new Promise(r => setTimeout(r, this.checkIntervalMs));
    }
  }

  stop(): void {
    this.isRunning = false;
    this.saveState(); // Save on stop
  }

  /**
   * Load state from file
   */
  private async loadState(): Promise<void> {
    if (!existsSync(STATE_FILE)) return;
    
    try {
      const data = readFileSync(STATE_FILE, 'utf-8');
      const saved: SavedState = JSON.parse(data);
      
      // Get current real positions from API
      const realPositions = await this.api.getWalletPositions(this.walletAddress);
      const realTokenIds = new Set(realPositions.filter(p => p.size > 0.01).map(p => p.tokenId));
      
      // Restore only positions that still exist
      for (const pos of saved.positions) {
        if (realTokenIds.has(pos.tokenId)) {
          // Find current price from API
          const realPos = realPositions.find(p => p.tokenId === pos.tokenId);
          if (realPos) {
            // Update highest price if current is higher (market moved up while offline)
            const currentPrice = realPos.currentPrice || realPos.avgPrice;
            if (currentPrice > pos.highestPrice) {
              pos.highestPrice = currentPrice;
            }
            // Clear old order ID (order may have been filled or cancelled)
            pos.currentOrderId = null;
            pos.currentOrderPrice = 0;
            pos.size = realPos.size;
            pos.updateAttempts = pos.updateAttempts || 0;
            pos.lastUpdateTime = pos.lastUpdateTime || 0;
            
            this.trackedPositions.set(pos.tokenId, pos);
          }
        }
      }
    } catch (error) {
      // Ignore load errors, start fresh
    }
  }

  /**
   * Save state to file
   */
  private saveState(): void {
    try {
      const state: SavedState = {
        positions: Array.from(this.trackedPositions.values()),
        savedAt: new Date().toISOString(),
      };
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // Ignore save errors
    }
  }

  /**
   * Save state every 30 seconds
   */
  private async saveStateIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSaveTime > 30000) {
      this.saveState();
      this.lastSaveTime = now;
    }
  }

  private async checkAndManagePositions(): Promise<void> {
    try {
      const positions = await this.getPositionsWithProfit();
      
      for (const pos of positions) {
        // Skip resolved markets
        if (pos.currentPrice >= 0.99 || pos.currentPrice <= 0.01) continue;
        
        const tracked = this.trackedPositions.get(pos.tokenId);
        
        if (!tracked) {
          // Not tracking yet - check if should start
          if (pos.profitPercent >= this.profitTrigger) {
            await this.startTracking(pos);
          }
        } else {
          // Already tracking - manage the position
          // Update with latest data from API
          tracked.size = pos.size;
          tracked.entryPrice = pos.avgPrice; // Use aggregated avg price from API
          await this.manageTrackedPosition(tracked, pos.currentPrice);
        }
      }
      
      // Cleanup positions that no longer exist
      await this.cleanupClosedPositions(positions);
      
    } catch {
      // Retry next cycle
    }
  }

  private async getPositionsWithProfit(): Promise<Position[]> {
    const rawPositions = await this.api.getWalletPositions(this.walletAddress);
    
    return rawPositions
      .filter(p => p.size > 0.01)
      .map(p => {
        const avgPrice = p.avgPrice || 0;
        const currentPrice = p.currentPrice || avgPrice;
        const profitPercent = avgPrice > 0 
          ? ((currentPrice - avgPrice) / avgPrice) * 100 
          : 0;
        
        return {
          tokenId: p.tokenId,
          size: p.size,
          avgPrice,
          currentPrice,
          profitPercent,
          marketSlug: p.marketSlug || '',
          outcome: p.outcome || '',
        };
      });
  }

  private async startTracking(pos: Position): Promise<void> {
    // Check if already tracking this token (prevent duplicates)
    if (this.trackedPositions.has(pos.tokenId)) {
      return; // Already tracking
    }
    
    const profitPercent = ((pos.currentPrice - pos.avgPrice) / pos.avgPrice) * 100;
    
    console.log(`\n  🎯 TRACKING: ${pos.marketSlug.substring(0, 30)}`);
    console.log(`     Entry: $${pos.avgPrice.toFixed(3)} | Now: $${pos.currentPrice.toFixed(3)} (+${profitPercent.toFixed(1)}%)`);
    
    const tracked: TrackedPosition = {
      tokenId: pos.tokenId,
      entryPrice: pos.avgPrice,
      size: pos.size,
      highestPrice: pos.currentPrice,
      currentOrderId: null,
      currentOrderPrice: 0,
      marketSlug: pos.marketSlug,
      startedAt: new Date().toISOString(),
      updateAttempts: 0,
      lastUpdateTime: 0,
    };
    
    this.trackedPositions.set(pos.tokenId, tracked);
    this.saveState(); // Save immediately when tracking starts
    
    // Place initial take-profit order slightly below current price
    await this.placeOrUpdateOrder(tracked, pos.currentPrice);
  }

  private async manageTrackedPosition(tracked: TrackedPosition, currentPrice: number): Promise<void> {
    // Update highest price if we hit new peak
    if (currentPrice > tracked.highestPrice) {
      tracked.highestPrice = currentPrice;
      tracked.updateAttempts = 0; // Reset attempts on new high
      
      // Price went up - check if should update order
      if (tracked.currentOrderId && tracked.currentOrderPrice > 0) {
        const priceChange = ((currentPrice - tracked.currentOrderPrice) / tracked.currentOrderPrice) * 100;
        
        if (priceChange >= this.updateThreshold) {
          const profitNow = ((currentPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
          console.log(`\n  📈 Price up! ${tracked.marketSlug.substring(0, 25)}`);
          console.log(`     New high: $${currentPrice.toFixed(3)} (+${profitNow.toFixed(1)}%) - updating order`);
          await this.cancelAndReplace(tracked, currentPrice);
        }
      }
    } else {
      // Price dropped - check if trailing stop triggered
      const dropFromPeak = ((tracked.highestPrice - currentPrice) / tracked.highestPrice) * 100;
      const effectiveTrailingStop = this.getTrailingStop(tracked.marketSlug);
      
      if (dropFromPeak >= effectiveTrailingStop) {
        const profitNow = ((currentPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
        const isSports = this.isSportsMarket(tracked.marketSlug);
        console.log(`\n  ⚠️ TRAILING STOP${isSports ? ' (SPORTS)' : ''}: ${tracked.marketSlug.substring(0, 25)}`);
        console.log(`     Peak: $${tracked.highestPrice.toFixed(3)} | Now: $${currentPrice.toFixed(3)} (-${dropFromPeak.toFixed(1)}% from peak)`);
        console.log(`     ${profitNow >= 0 ? '+' : ''}${profitNow.toFixed(1)}% from entry - executing emergency exit`);
        await this.emergencyExit(tracked, currentPrice);
        return;
      }
      
      // Check if price fell below our order (order won't fill)
      if (tracked.currentOrderId && currentPrice < tracked.currentOrderPrice * 0.98) {
        // Prevent spam - only update every 30 seconds
        const now = Date.now();
        if (now - tracked.lastUpdateTime < 30000) {
          return; // Skip update, too soon
        }
        
        tracked.updateAttempts++;
        
        // If too many attempts, force emergency exit
        if (tracked.updateAttempts >= MAX_UPDATE_ATTEMPTS) {
          const profitNow = ((currentPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
          console.log(`\n  ⚠️ MAX ATTEMPTS: ${tracked.marketSlug.substring(0, 25)}`);
          console.log(`     ${tracked.updateAttempts} update attempts failed - forcing exit`);
          console.log(`     ${profitNow >= 0 ? '+' : ''}${profitNow.toFixed(1)}% from entry`);
          await this.emergencyExit(tracked, currentPrice);
          return;
        }
        
        const profitNow = ((currentPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
        console.log(`\n  ⚠️ Price below order: ${tracked.marketSlug.substring(0, 25)} [${tracked.updateAttempts}/${MAX_UPDATE_ATTEMPTS}]`);
        console.log(`     Order @ $${tracked.currentOrderPrice.toFixed(3)} | Price: $${currentPrice.toFixed(3)} (${profitNow >= 0 ? '+' : ''}${profitNow.toFixed(1)}%)`);
        await this.cancelAndReplace(tracked, currentPrice);
      }
    }
  }

  private async placeOrUpdateOrder(tracked: TrackedPosition, currentPrice: number): Promise<void> {
    tracked.lastUpdateTime = Date.now();
    
    // Place order at current price (2% below for faster fill)
    const orderPrice = currentPrice * 0.98;
    const minProfitPrice = tracked.entryPrice * 1.03; // At least +3% profit (lowered from 5%)
    
    // Use the LOWER of orderPrice or minProfitPrice if current price dropped below min
    // This prevents the infinite loop of always placing order at minProfitPrice
    let finalPrice: number;
    
    if (currentPrice >= minProfitPrice) {
      // Price is good - use order price (2% below current)
      finalPrice = Math.max(orderPrice, minProfitPrice);
    } else {
      // Price dropped below min profit - sell at current price anyway
      // Better to take small profit/breakeven than hold and lose more
      finalPrice = currentPrice * 0.98;
      
      // If we're at a loss, exit via emergency
      if (currentPrice < tracked.entryPrice * 0.98) {
        console.log(`     ⚠️ Price below entry - executing emergency exit`);
        await this.emergencyExit(tracked, currentPrice);
        return;
      }
    }
    
    finalPrice = Math.min(finalPrice, 0.99);
    
    const value = tracked.size * finalPrice;
    const expectedProfit = ((finalPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
    
    try {
      const result = await this.trader.executeTrade({
        tokenId: tracked.tokenId,
        side: 'SELL',
        amount: value,
        price: finalPrice,
      }, 'GTC');
      
      if (result.success && result.orderId) {
        tracked.currentOrderId = result.orderId;
        tracked.currentOrderPrice = finalPrice;
        console.log(`     📤 Order @ $${finalPrice.toFixed(3)} (${expectedProfit >= 0 ? '+' : ''}${expectedProfit.toFixed(1)}%)`);
      } else {
        // Check if market is closed/resolved
        if (this.isMarketClosedError(result.error)) {
          console.log(`     ⚠️ Market closed - removing from tracking`);
          this.trackedPositions.delete(tracked.tokenId);
          this.saveState();
        } else if (result.error?.includes('not enough balance')) {
          // This shouldn't happen for SELL, but handle it
          console.log(`     ⚠️ Allowance issue - try running: npm run cli set-allowances`);
          tracked.updateAttempts++;
        } else {
          console.log(`     ❌ Order failed: ${result.error}`);
          tracked.updateAttempts++;
        }
      }
    } catch (error: any) {
      if (this.isMarketClosedError(error.message)) {
        console.log(`     ⚠️ Market closed - removing from tracking`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
      } else {
        console.log(`     ❌ Order error: ${error.message?.substring(0, 30)}`);
        tracked.updateAttempts++;
      }
    }
  }

  private async cancelAndReplace(tracked: TrackedPosition, currentPrice: number): Promise<void> {
    // Cancel existing order
    if (tracked.currentOrderId) {
      const cancelled = await this.trader.cancelOrder(tracked.currentOrderId);
      if (cancelled) {
        console.log(`     🔄 Order cancelled`);
      }
      tracked.currentOrderId = null;
      tracked.currentOrderPrice = 0;
    }
    
    // Place new order at current price
    await this.placeOrUpdateOrder(tracked, currentPrice);
  }

  /**
   * Check if error indicates market is closed/resolved
   */
  private isMarketClosedError(error: string | undefined): boolean {
    if (!error) return false;
    const closedIndicators = [
      'does not exist',
      'orderbook',
      'market closed',
      'resolved',
      'inactive',
    ];
    return closedIndicators.some(ind => error.toLowerCase().includes(ind));
  }

  /**
   * Check if market is a sports market (higher volatility)
   */
  private isSportsMarket(marketSlug: string): boolean {
    const slug = marketSlug.toLowerCase();
    return SPORTS_PREFIXES.some(prefix => slug.startsWith(prefix));
  }

  /**
   * Get effective trailing stop for a position
   */
  private getTrailingStop(marketSlug: string): number {
    if (this.isSportsMarket(marketSlug)) {
      return SPORTS_TRAILING_STOP;
    }
    return this.trailingStopPercent;
  }

  private async emergencyExit(tracked: TrackedPosition, currentPrice: number): Promise<void> {
    // Cancel existing order first
    if (tracked.currentOrderId) {
      await this.trader.cancelOrder(tracked.currentOrderId);
      tracked.currentOrderId = null;
    }
    
    // Try aggressive FOK at 10% below current price (more likely to fill)
    const aggressivePrice = currentPrice * 0.90;
    const value = tracked.size * aggressivePrice;
    
    try {
      let result = await this.trader.executeTrade({
        tokenId: tracked.tokenId,
        side: 'SELL',
        amount: value,
        price: aggressivePrice,
      }, 'FOK');
      
      if (result.success) {
        const profit = ((aggressivePrice - tracked.entryPrice) / tracked.entryPrice) * 100;
        console.log(`     🚨 EXIT @ $${aggressivePrice.toFixed(3)} (${profit >= 0 ? '+' : ''}${profit.toFixed(1)}%)`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
        return;
      }
      
      // Check if market is closed
      if (this.isMarketClosedError(result.error)) {
        console.log(`     ⚠️ Market closed - removing from tracking`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
        return;
      }
      
      // FOK failed - try even lower price (20% below)
      const veryLowPrice = currentPrice * 0.80;
      result = await this.trader.executeTrade({
        tokenId: tracked.tokenId,
        side: 'SELL',
        amount: tracked.size * veryLowPrice,
        price: veryLowPrice,
      }, 'FOK');
      
      if (result.success) {
        const profit = ((veryLowPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
        console.log(`     🚨 EXIT @ $${veryLowPrice.toFixed(3)} (${profit >= 0 ? '+' : ''}${profit.toFixed(1)}% - high slippage)`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
        return;
      }
      
      // Check again for closed market
      if (this.isMarketClosedError(result.error)) {
        console.log(`     ⚠️ Market closed - removing from tracking`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
        return;
      }
      
      // Still failed - place aggressive GTC order and move on
      const lastResortPrice = currentPrice * 0.70;
      result = await this.trader.executeTrade({
        tokenId: tracked.tokenId,
        side: 'SELL',
        amount: tracked.size * lastResortPrice,
        price: lastResortPrice,
      }, 'GTC');
      
      if (result.success && result.orderId) {
        tracked.currentOrderId = result.orderId;
        tracked.currentOrderPrice = lastResortPrice;
        const profit = ((lastResortPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
        console.log(`     📤 Last resort order @ $${lastResortPrice.toFixed(3)} (${profit >= 0 ? '+' : ''}${profit.toFixed(1)}%)`);
        this.saveState();
      } else if (this.isMarketClosedError(result.error)) {
        console.log(`     ⚠️ Market closed - removing from tracking`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
      } else {
        console.log(`     ❌ All exit attempts failed - removing from tracking`);
        this.trackedPositions.delete(tracked.tokenId);
        this.saveState();
      }
    } catch (error: any) {
      const errorMsg = error.message || '';
      if (this.isMarketClosedError(errorMsg)) {
        console.log(`     ⚠️ Market closed - removing from tracking`);
      } else {
        console.log(`     ❌ Exit error - removing from tracking`);
      }
      // Always remove from tracking on error to stop spam
      this.trackedPositions.delete(tracked.tokenId);
      this.saveState();
    }
  }

  private async cleanupClosedPositions(currentPositions: Position[]): Promise<void> {
    const activeTokens = new Set(currentPositions.map(p => p.tokenId));
    let changed = false;
    
    for (const [tokenId, tracked] of this.trackedPositions) {
      if (!activeTokens.has(tokenId)) {
        const profitPercent = tracked.currentOrderPrice > 0 
          ? ((tracked.currentOrderPrice - tracked.entryPrice) / tracked.entryPrice) * 100 
          : 0;
        console.log(`  ✅ Sold: ${tracked.marketSlug.substring(0, 25)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(1)}%)`);
        this.trackedPositions.delete(tokenId);
        changed = true;
      }
    }
    
    if (changed) {
      this.saveState();
    }
  }

  async displayPositions(): Promise<void> {
    const positions = await this.getPositionsWithProfit();
    
    if (positions.length === 0) {
      console.log('No open positions');
      return;
    }
    
    console.log('\n📊 Positions:');
    
    let totalValue = 0;
    let totalPL = 0;
    
    for (const pos of positions) {
      const value = pos.size * pos.currentPrice;
      const cost = pos.size * pos.avgPrice;
      const pl = value - cost;
      totalValue += value;
      totalPL += pl;
      
      const emoji = pos.profitPercent >= 0 ? '🟢' : '🔴';
      const sign = pos.profitPercent >= 0 ? '+' : '';
      const tracking = this.trackedPositions.has(pos.tokenId) ? ' 🎯' : '';
      
      console.log(`${emoji} ${pos.marketSlug.substring(0, 25)} | ${sign}${pos.profitPercent.toFixed(0)}% | $${value.toFixed(2)}${tracking}`);
    }
    
    const totalSign = totalPL >= 0 ? '+' : '';
    console.log(`Total: $${totalValue.toFixed(2)} (${totalSign}$${totalPL.toFixed(2)})`);
    
    if (this.trackedPositions.size > 0) {
      console.log(`\n🎯 Tracking ${this.trackedPositions.size} position(s) for take-profit`);
    }
  }
}
