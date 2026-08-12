import type { MetadataRoute } from "next";

// Sitemap — how Google discovers the per-ticker X-Ray pages (our programmatic-SEO surface). Static
// surfaces + a curated set of the most-searched liquid tickers (quality over a thin-content long tail:
// we list names people actually search, not every OTC shell). Expand the list as the per-ticker pages
// gain real server-rendered content. Must be reachable logged-out — middleware exempts /sitemap.xml.
const BASE = "https://plainviewintel.com";

// High-search-volume, liquid US tickers + major crypto/ETFs — the queries worth ranking for.
const TICKERS = [
  // Mega-cap tech
  "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","AVGO","AMD","NFLX","ADBE","CRM","ORCL","INTC","CSCO","QCOM","TXN","IBM","NOW","AMAT",
  // Popular / retail favorites
  "AMC","GME","PLTR","SOFI","HOOD","RIVN","LCID","NIO","COIN","RBLX","SNAP","UBER","LYFT","ABNB","DKNG","PINS","SHOP","SQ","PYPL","ROKU",
  // Semis / AI
  "MU","ARM","SMCI","MRVL","ASML","TSM","ON","LRCX","KLAC","WOLF",
  // Finance
  "JPM","BAC","WFC","GS","MS","C","SCHW","V","MA","AXP","BRK-B","BLK","COF",
  // Healthcare / pharma / biotech
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","BMY","AMGN","GILD","MRNA","CVS",
  // Consumer / retail
  "WMT","COST","HD","LOW","NKE","SBUX","MCD","TGT","DIS","KO","PEP","PG","CMG","LULU",
  // Energy / industrial
  "XOM","CVX","COP","OXY","SLB","BA","CAT","GE","HON","LMT","RTX","DE","UPS","FDX","F","GM",
  // Telecom / media
  "T","VZ","TMUS","CMCSA","WBD",
  // Expanded — high-search names with real SSR content
  "PANW","CRWD","ZS","NET","SNOW","DDOG","MDB","TEAM","WDAY","HUBS","ZM","DOCU","TWLO","TTD","BILL",
  "ENPH","FSLR","SEDG","RUN","SPWR",
  "SPOT","SE","MELI","GRAB","BABA","JD","PDD","BIDU",
  "SMMT","CELH","MNST","CAVA",
  "CRSP","BEAM","NTLA","EDIT","EXAS",
  "MSTR","RIOT","MARA","HUT","CLSK",
  "PATH","AI","BBAI","SOUN","IONQ","RGTI",
  // Crypto
  "BTC","ETH","SOL","XRP","DOGE","ADA","AVAX","LINK","MATIC","DOT",
  // Major ETFs
  "SPY","QQQ","VOO","VTI","IWM","DIA","ARKK","SCHD","VYM","GLD","SOXX","XLF","XLE","XLK","TLT",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const statics: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: now, changeFrequency: "daily", priority: 1.0 },
    { url: `${BASE}/x-ray`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
  ];
  const tickers: MetadataRoute.Sitemap = TICKERS.map((t) => ({
    url: `${BASE}/x-ray/${t}`,
    lastModified: now,
    changeFrequency: "daily",
    priority: 0.7,
  }));
  return [...statics, ...tickers];
}
