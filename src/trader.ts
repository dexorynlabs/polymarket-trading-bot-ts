/**
 * Real trading execution using Polymarket CLOB API
 * With retry logic for 502/503/timeout errors
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { WalletManager, initializeWallet } from './wallet';
import logger from './logger';

export interface TradeParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number; // USDC amount
  price?: number; // Price from original trade (optional)
}

export interface TradeResult {
  success: boolean;
  orderId?: string;
  error?: string;
  details?: any;
}

/**
 * Retry wrapper for CLOB client calls
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 2000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      // Check if error is retryable (502, 503, timeout, network)
      const errorStr = String(error.message || error).toLowerCase();
      const statusCode = error.response?.status || error.status;
      
      const isRetryable = 
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504 ||
        statusCode === 429 ||
        errorStr.includes('502') ||
        errorStr.includes('503') ||
        errorStr.includes('bad gateway') ||
        errorStr.includes('timeout') ||
        errorStr.includes('econnreset') ||
        errorStr.includes('enotfound') ||
        errorStr.includes('network');
      
      if (isRetryable && attempt < maxRetries) {
        const waitTime = delayMs * attempt;
        console.log(`  ⚠️ CLOB error (${statusCode || 'network'}), retry ${attempt}/${maxRetries} in ${waitTime/1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}

export class RealTrader {
  private wallet: WalletManager | null = null;
  private client: ClobClient | null = null;

  constructor() {}

  /**
   * Initialize the trader with wallet
   */
  async initialize(): Promise<void> {
    try {
      this.wallet = await initializeWallet();
      this.client = this.wallet.getClobClient();
      
      const balance = await this.wallet.getBalance();
      const totalUsdc = balance.polymarketBalance;
      if (totalUsdc < 1) {
        // Low balance warning handled by bot.ts
      }
    } catch (error: any) {
      logger.errorDetail('Failed to initialize trader', error);
      throw error;
    }
  }

  /**
   * Get current market price for a token
   */
  async getMarketPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number | null> {
    if (!this.client) {
      logger.error('Trader not initialized');
      return null;
    }

    try {
      const price = await withRetry(() => this.client!.getPrice(tokenId, side));
      return price ? parseFloat(price) : null;
    } catch (error: any) {
      logger.errorDetail('Error getting price', error);
      return null;
    }
  }

  /**
   * Execute a market order
   * @param orderType - 'GTC' (default), 'FOK' (Fill Or Kill), 'GTD' (Good Till Date)
   */
  async executeTrade(params: TradeParams, orderType: 'GTC' | 'FOK' | 'GTD' = 'GTC'): Promise<TradeResult> {

    if (!this.client || !this.wallet) {
      return { success: false, error: 'Not initialized' };
    }

    try {
      // Check balance only for BUY (SELL doesn't need USDC)
      if (params.side === 'BUY') {
        const hasFunds = await this.wallet.checkSufficientBalance(params.amount);
        if (!hasFunds) {
          return { success: false, error: 'Low balance' };
        }
      }

      // Get market price - use provided price or fetch from API
      let marketPrice: number | null = params.price || null;
      if (!marketPrice) {
        marketPrice = await this.getMarketPrice(params.tokenId, params.side);
      }
      
      if (!marketPrice || marketPrice <= 0) {
        return { success: false, error: 'No price' };
      }

      // Calculate size (shares)
      const size = params.amount / marketPrice;

      // Get tick size and neg risk for this market
      type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";
      let tickSize: TickSize = '0.01';  // Default to larger tick size
      let negRisk = false;
      
      try {
        tickSize = await withRetry(() => this.client!.getTickSize(params.tokenId)) as TickSize;
        negRisk = await withRetry(() => this.client!.getNegRisk(params.tokenId));
      } catch (e) {
        // Use default tick size
      }

      // Round price to tick size
      const tickNum = parseFloat(tickSize);
      const orderPrice = Math.round(marketPrice / tickNum) * tickNum;

      // Minimum order size is 5 shares on Polymarket
      const MIN_SHARES = 5;
      if (size < MIN_SHARES) {
        const minAmount = MIN_SHARES * marketPrice;
        return { success: false, error: `Min $${minAmount.toFixed(0)}` };
      }

      // Suppress CLOB client console output
      const originalLog = console.log;
      const originalError = console.error;
      const isDebug = process.env.DEBUG === 'true';
      if (!isDebug) {
        console.log = () => {};
        console.error = () => {};
      }

      let order: any;
      try {
        // Map string to OrderType enum
        const orderTypeMap: Record<string, any> = {
          'GTC': OrderType.GTC,
          'FOK': OrderType.FOK,
          'GTD': OrderType.GTD,
        };
        const selectedOrderType = orderTypeMap[orderType] || OrderType.GTC;
        
        order = await withRetry(() => this.client!.createAndPostOrder(
          {
            tokenID: params.tokenId,
            price: orderPrice,
            size: size,
            side: params.side === 'BUY' ? Side.BUY : Side.SELL,
          },
          { tickSize, negRisk },
          selectedOrderType
        ));
      } finally {
        // Restore console
        console.log = originalLog;
        console.error = originalError;
      }

      // Check if order was actually placed
      if (!order || !order.orderID || order.error) {
        return { success: false, error: order?.error || 'Rejected' };
      }

      // Invalidate balance cache after successful trade
      this.wallet?.invalidateBalanceCache();

      return {
        success: true,
        orderId: order.orderID,
        details: { ...order, size, price: orderPrice },
      };
    } catch (error: any) {
      return { success: false, error: error.message?.substring(0, 30) || 'Failed' };
    }
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<any[]> {
    if (!this.client) return [];
    
    try {
      const orders = await withRetry(() => this.client!.getOpenOrders());
      return orders || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      await withRetry(() => this.client!.cancelOrder({ orderID: orderId }));
      return true;
    } catch (error: any) {
      logger.errorDetail('Cancel failed', error);
      return false;
    }
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<number> {
    if (!this.client) return 0;
    
    try {
      const orders = await this.getOpenOrders();
      let cancelled = 0;
      
      for (const order of orders) {
        if (await this.cancelOrder(order.id || order.orderID)) {
          cancelled++;
        }
      }
      
      return cancelled;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Close all positions (market sell)
   */
  async closeAllPositions(positions: Array<{ tokenId: string; size: number; currentPrice: number; marketSlug?: string }>): Promise<{ closed: number; failed: number }> {
    let closed = 0;
    let failed = 0;
    
    for (const pos of positions) {
      if (pos.size < 0.01) continue;
      
      const sellValue = pos.size * pos.currentPrice;
      const market = pos.marketSlug?.substring(0, 25) || pos.tokenId.substring(0, 16);
      
      console.log(`  Closing ${market}... ($${sellValue.toFixed(2)})`);
      
      // Try FOK first, then GTC
      let result = await this.executeTrade({
        tokenId: pos.tokenId,
        side: 'SELL',
        amount: sellValue,
        price: pos.currentPrice,
      }, 'FOK');
      
      if (!result.success) {
        // Try with lower price
        const lowerPrice = pos.currentPrice * 0.95;
        result = await this.executeTrade({
          tokenId: pos.tokenId,
          side: 'SELL',
          amount: pos.size * lowerPrice,
          price: lowerPrice,
        }, 'GTC');
      }
      
      if (result.success) {
        console.log(`  ✅ Closed ${market}`);
        closed++;
      } else {
        console.log(`  ❌ Failed to close ${market}: ${result.error}`);
        failed++;
      }
      
      // Small delay between orders
      await new Promise(r => setTimeout(r, 500));
    }
    
    return { closed, failed };
  }

}
