/**
 * Trade Interpreter
 * 
 * Normalizes trade events from different sources
 */

import { TradeEvent } from './watcher';

export interface NormalizedTrade {
  wallet: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;          // shares
  usdcAmount: number;    // USDC amount
  outcome?: string;
  marketSlug?: string;
  traderBalance?: number;
  timestamp: string;
}

export class TradeInterpreter {
  /**
   * Normalize a trade event
   */
  normalize(event: TradeEvent): NormalizedTrade {
    return {
      wallet: event.wallet,
      tokenId: event.tokenId,
      conditionId: event.conditionId,
      side: event.side,
      price: event.price,
      size: event.size,
      usdcAmount: event.usdcAmount,
      outcome: event.outcome,
      marketSlug: event.marketSlug,
      traderBalance: event.traderBalance,
      timestamp: event.timestamp,
    };
  }
}
