// Global configuration for the Polymarket Copy Trading Bot

export type SizingMode = "fixed" | "proportional";

export interface Config {
  wallets_to_track: string[];
  mode: SizingMode;
  fixed_stake?: number;  // Only used if mode = "fixed"
  min_stake: number;
  max_stake: number;
  profit_take_percent?: number;
  max_buys_per_token?: number;      // Max times to buy same token (prevents spam from limit orders)
  cooldown_minutes?: number;         // Cooldown after position closes before buying same token again
  trailing_stop_percent?: number;    // Trailing stop % from peak (default 15)
  skip_sports?: boolean;             // Skip volatile sports markets (NBA, NFL, etc.)
}

export const CONFIG: Config = {
  wallets_to_track: [],
  mode: "proportional",
  min_stake: 5,
  max_stake: 300,
  profit_take_percent: 15,
  max_buys_per_token: 3,
  cooldown_minutes: 30,        // 30 min cooldown after position closes
  trailing_stop_percent: 15,   // 15% trailing stop (safer than 10%)
  skip_sports: false,          // Set to true to skip NBA, NFL, NHL etc.
};

export function loadConfig(): Config {
  return { ...CONFIG };
}
