/**
 * PnL Tracker - tracks REALIZED profit/loss only
 * 
 * PnL = sum of realized P/L from closed positions
 * - BUY does NOT count as loss
 * - SELL at loss counts as loss
 * - SELL at profit counts as profit
 * 
 * Only displays PnL when position is closed (not periodic spam)
 */

import { PolymarketAPI } from './api';
import { WalletManager } from './wallet';

interface PositionSnapshot {
  tokenId: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  marketSlug: string;
  costBasis: number;      // size * avgPrice
  currentValue: number;   // size * currentPrice
  unrealizedPnL: number;  // currentValue - costBasis
}

interface PnLSnapshot {
  timestamp: Date;
  usdcBalance: number;
  positionsValue: number;
  totalEquity: number;
  positions: PositionSnapshot[];
}

// Callback type for when position closes
export type OnPositionClosedCallback = (tokenId: string, marketSlug: string) => void;

export class PnLTracker {
  private api: PolymarketAPI;
  private wallet: WalletManager;
  private walletAddress: string;
  
  private startSnapshot: PnLSnapshot | null = null;
  private currentSnapshot: PnLSnapshot | null = null;
  
  // REALIZED PnL - only counts closed positions
  private realizedPnL: number = 0;
  private winCount: number = 0;
  private lossCount: number = 0;
  
  private updateIntervalMs: number;
  private isRunning: boolean = false;
  private onPositionClosed: OnPositionClosedCallback | null = null;

  constructor(
    wallet: WalletManager,
    walletAddress: string,
    updateIntervalMs: number = 30000
  ) {
    this.api = new PolymarketAPI();
    this.wallet = wallet;
    this.walletAddress = walletAddress;
    this.updateIntervalMs = updateIntervalMs;
  }

  /**
   * Set callback for when position closes
   */
  setOnPositionClosed(callback: OnPositionClosedCallback): void {
    this.onPositionClosed = callback;
  }

  /**
   * Initialize with starting snapshot
   */
  async initialize(): Promise<PnLInfo> {
    this.startSnapshot = await this.takeSnapshot();
    this.currentSnapshot = this.startSnapshot;
    return this.getPnLInfo();
  }

  /**
   * Start periodic updates (silent - only logs on position close)
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    while (this.isRunning) {
      await new Promise(r => setTimeout(r, this.updateIntervalMs));
      await this.update();
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  /**
   * Update current snapshot and detect closed positions
   */
  async update(): Promise<PnLInfo> {
    const previousSnapshot = this.currentSnapshot;
    
    try {
      this.currentSnapshot = await this.takeSnapshot();
    } catch {
      // If snapshot fails, return current info without update
      return this.getPnLInfo();
    }
    
    // Detect closed positions and calculate realized PnL
    if (previousSnapshot) {
      const currentTokenIds = new Set(this.currentSnapshot.positions.map(p => p.tokenId));
      
      for (const prevPos of previousSnapshot.positions) {
        if (!currentTokenIds.has(prevPos.tokenId)) {
          // Position was closed - calculate realized PnL
          const realized = prevPos.unrealizedPnL;
          this.realizedPnL += realized;
          
          // Track wins/losses (0 is neither win nor loss)
          if (realized > 0.01) {
            this.winCount++;
          } else if (realized < -0.01) {
            this.lossCount++;
          }
          // else: breakeven, don't count
          
          // Display closed position
          const sign = realized >= 0 ? '+' : '';
          const emoji = realized >= 0 ? '✅' : '❌';
          const pnlPercent = prevPos.costBasis > 0 
            ? (realized / prevPos.costBasis) * 100 
            : 0;
          
          console.log(`\n  ${emoji} CLOSED: ${prevPos.marketSlug.substring(0, 30)}`);
          console.log(`     P/L: ${sign}$${realized.toFixed(2)} (${sign}${pnlPercent.toFixed(1)}%)`);
          
          // Show session totals (only realized PnL)
          const pnlSign = this.realizedPnL >= 0 ? '+' : '';
          console.log(`     Session: ${pnlSign}$${this.realizedPnL.toFixed(2)} | W/L: ${this.winCount}/${this.lossCount}`);
          
          // Call callback to notify about closed position
          if (this.onPositionClosed) {
            this.onPositionClosed(prevPos.tokenId, prevPos.marketSlug);
          }
        }
      }
    }
    
    return this.getPnLInfo();
  }

  /**
   * Force update now
   */
  async forceUpdate(): Promise<PnLInfo> {
    return this.update();
  }

  /**
   * Take a snapshot of current state
   */
  private async takeSnapshot(): Promise<PnLSnapshot> {
    const [balance, rawPositions] = await Promise.all([
      this.wallet.getBalance(),
      this.api.getWalletPositions(this.walletAddress),
    ]);
    
    const positions: PositionSnapshot[] = rawPositions
      .filter(p => p.size > 0.01)
      .map(p => {
        const currentPrice = p.currentPrice || p.avgPrice;
        const costBasis = p.size * p.avgPrice;
        const currentValue = p.size * currentPrice;
        
        return {
          tokenId: p.tokenId,
          size: p.size,
          avgPrice: p.avgPrice,
          currentPrice,
          marketSlug: p.marketSlug || '',
          costBasis,
          currentValue,
          unrealizedPnL: currentValue - costBasis,
        };
      });
    
    const positionsValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
    
    return {
      timestamp: new Date(),
      usdcBalance: balance.polymarketBalance,
      positionsValue,
      totalEquity: balance.polymarketBalance + positionsValue,
      positions,
    };
  }

  /**
   * Get current PnL info
   * sessionPnL = REALIZED PnL only (closed positions)
   */
  getPnLInfo(): PnLInfo {
    if (!this.startSnapshot || !this.currentSnapshot) {
      return {
        startEquity: 0,
        currentEquity: 0,
        sessionPnL: 0,
        sessionPnLPercent: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        usdcBalance: 0,
        positionsValue: 0,
        positionCount: 0,
        winCount: 0,
        lossCount: 0,
        positions: [],
      };
    }
    
    const unrealizedPnL = this.currentSnapshot.positions.reduce(
      (sum, p) => sum + p.unrealizedPnL, 
      0
    );
    
    // sessionPnL = only REALIZED PnL (not equity change)
    const sessionPnLPercent = this.startSnapshot.totalEquity > 0
      ? (this.realizedPnL / this.startSnapshot.totalEquity) * 100
      : 0;
    
    return {
      startEquity: this.startSnapshot.totalEquity,
      currentEquity: this.currentSnapshot.totalEquity,
      sessionPnL: this.realizedPnL,  // Only realized!
      sessionPnLPercent,
      realizedPnL: this.realizedPnL,
      unrealizedPnL,
      usdcBalance: this.currentSnapshot.usdcBalance,
      positionsValue: this.currentSnapshot.positionsValue,
      positionCount: this.currentSnapshot.positions.length,
      winCount: this.winCount,
      lossCount: this.lossCount,
      positions: this.currentSnapshot.positions.map(p => ({
        market: p.marketSlug,
        size: p.size,
        avgPrice: p.avgPrice,
        currentPrice: p.currentPrice,
        pnl: p.unrealizedPnL,
        pnlPercent: p.costBasis > 0 ? (p.unrealizedPnL / p.costBasis) * 100 : 0,
      })),
    };
  }

  /**
   * Format PnL for display
   */
  formatPnL(): string {
    const info = this.getPnLInfo();
    const sign = info.sessionPnL >= 0 ? '+' : '';
    
    return `${sign}$${info.sessionPnL.toFixed(2)} (${info.winCount}W/${info.lossCount}L)`;
  }

  /**
   * Get detailed display
   */
  getDetailedDisplay(): string[] {
    const info = this.getPnLInfo();
    const lines: string[] = [];
    
    const pnlSign = info.sessionPnL >= 0 ? '+' : '';
    
    lines.push(`💵 Balance: $${info.usdcBalance.toFixed(2)}`);
    lines.push(`📊 Positions: $${info.positionsValue.toFixed(2)} (${info.positionCount})`);
    lines.push(`💰 Equity: $${info.currentEquity.toFixed(2)}`);
    lines.push(`📈 Realized P/L: ${pnlSign}$${info.sessionPnL.toFixed(2)} (${info.winCount}W/${info.lossCount}L)`);
    
    if (info.unrealizedPnL !== 0) {
      const unSign = info.unrealizedPnL >= 0 ? '+' : '';
      lines.push(`   Unrealized: ${unSign}$${info.unrealizedPnL.toFixed(2)}`);
    }
    
    return lines;
  }
}

export interface PnLInfo {
  startEquity: number;
  currentEquity: number;
  sessionPnL: number;       // Now = realized PnL only
  sessionPnLPercent: number;
  realizedPnL: number;
  unrealizedPnL: number;
  usdcBalance: number;
  positionsValue: number;
  positionCount: number;
  winCount: number;
  lossCount: number;
  positions: Array<{
    market: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    pnl: number;
    pnlPercent: number;
  }>;
}
