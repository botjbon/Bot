export interface Strategy {
  minPrice?: number;
  maxPrice?: number;
  minMarketCap?: number;
  minLiquidity?: number;
  minVolume?: number;
  minHolders?: number;
  minAge?: number;
  // New unified max age in seconds; prefer this over minAge
  maxAgeSec?: number;
  onlyVerified?: boolean;
  enabled?: boolean;
  buyAmount?: number;
  profitTargets?: string;
  sellPercents?: string;
  stopLossPercent?: number;
  // Extended fields for Jupiter / pump integration
  requirePool?: boolean;
  // New tunables
  skipOnchainEnrich?: boolean;
  enrichTimeoutMs?: number;
  explainFiltering?: boolean;
}