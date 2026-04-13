/** Shared types for all Model Analysis pages */

/** Pre-computed market stats from the summary column */
export interface MarketSummary {
  bets: number;
  wins: number;
  win_rate: number;
  flat_pnl: number;
  flat_roi: number;
  flat_br: number;
  half_kelly_br: number;
  full_kelly_br: number;
  avg_raw_clv?: number;
  avg_clv_prob_edge?: number;
  pct_beat_close?: number;
  total_wagered?: number;
  turnover?: number;
  max_drawdown?: number;
  odds_buckets?: Record<string, { bets: number; wins: number; pnl: number; roi: number }>;
}

export interface BacktestSummary {
  total_bets: number;
  features?: string[];
  feature_importance?: Record<string, number>;
  accuracy?: number;
  auc?: number;
  skip_counts?: Record<string, number>;
  seasons?: string[];
  [key: string]: unknown;
}

export interface StatRow {
  league: string;
  market: string;
  model: string;
  bets: number;
  wins: number;
  winRate: number;
  flatPnl: number;
  flatRoi: number;
  flatBr: number;
  halfKellyPnl: number;
  fullKellyPnl: number;
  pEdge: number;
  allSeasons: string;
  stability: number;
  pctBeatClose: number;     // -1 = no data
  avgClvProbEdge: number;   // 0 = no data
  warnings: string[];        // sanity check warnings
  maxDrawdown: number;       // -1 = no data
  turnover: number;          // -1 = no data
  bookScore: string;         // "4/4", "3/4", etc. or "—"
  booksCombos: {
    fdFd: MarketSummary | null;  // trained FD, tested FD
    fdDk: MarketSummary | null;  // trained FD, tested DK (alt)
    dkDk: MarketSummary | null;  // trained DK, tested DK
    dkFd: MarketSummary | null;  // trained DK, tested FD (alt)
  };
}

export type OddsMode = "scrape" | "open" | "close" | "train" | "alt";
export type TrainBook = "fd" | "dk";

/** The shape of MODEL_DEFS entries */
export interface ModelDef {
  readonly suffix: string;
  readonly label: string;
  readonly color: string;
}
