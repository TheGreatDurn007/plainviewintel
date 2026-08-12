export type AssetType = "stock" | "crypto";

export type PlainviewPosition = {
  assetType: AssetType;
  ticker: string;
  name?: string;
  currency: "USD" | "CAD";
  shares: number;
  averageCost: number;
  currentPrice: number;
  thesis?: string;
  exitRule?: string;
  catalyst?: string;
};

export type XrayMetric = {
  label: string;
  value: string;
  status: "good" | "watch" | "bad";
  context?: string;
};

export type XrayResult = {
  symbol: string;
  name?: string;
  source: string;
  score: number;
  metrics: XrayMetric[];
  valuation: XrayMetric[];
  warning?: string;
};
