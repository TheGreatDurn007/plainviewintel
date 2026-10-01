import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Reliable crypto data: fetched SERVER-SIDE from CoinGecko (no flaky browser CORS proxies, which is why
// BTC/XLM intermittently came back "missing"). Cached at the edge + in-memory; serves stale on a miss.
export const maxDuration = 20;

const mem = new Map<string, { data: unknown; ts: number }>();
const TTL = 5 * 60 * 1000;

// On-chain TVL (DeFiLlama, free) = a real "is this network actually used" utility signal. Cached 1h.
// Maps a CoinGecko id to its DeFiLlama chain. Coins without a smart-contract chain (BTC, payment coins,
// memes) simply have no TVL — that's expected, and the score treats TVL as additive credit, not a penalty.
const CG_TO_LLAMA: Record<string, string> = {
  ethereum: "Ethereum", solana: "Solana", "binancecoin": "BSC", tron: "Tron", "avalanche-2": "Avalanche",
  "matic-network": "Polygon", "polygon-ecosystem-token": "Polygon", cardano: "Cardano", near: "Near",
  aptos: "Aptos", sui: "Sui", "the-open-network": "TON", polkadot: "Polkadot", "internet-computer": "ICP",
  cosmos: "CosmosHub", arbitrum: "Arbitrum", optimism: "Optimism", "immutable-x": "Immutable", sei: "Sei",
  celestia: "Celestia", injective: "Injective", "injective-protocol": "Injective", "ethereum-classic": "EthereumClassic",
  hedera: "Hedera", "hedera-hashgraph": "Hedera", algorand: "Algorand", "fantom": "Fantom", kaspa: "Kaspa",
  "flare-networks": "Flare", stellar: "Stellar", ripple: "XRPL", "xdce-crowd-sale": "XDC",
};
let _llamaCache: { at: number; byChain: Record<string, number> } | null = null;
async function chainTvl(cgId: string): Promise<number | null> {
  const chain = CG_TO_LLAMA[cgId];
  if (!chain) return null;
  try {
    if (!_llamaCache || Date.now() - _llamaCache.at > 60 * 60 * 1000) {
      const r = await fetch("https://api.llama.fi/v2/chains", { next: { revalidate: 3600 } });
      if (!r.ok) return _llamaCache ? (_llamaCache.byChain[chain] ?? null) : null;
      const rows = (await r.json()) as Array<{ name?: string; tvl?: number }>;
      const byChain: Record<string, number> = {};
      for (const row of rows) if (row.name && Number.isFinite(row.tvl)) byChain[row.name] = row.tvl as number;
      _llamaCache = { at: Date.now(), byChain };
    }
    return _llamaCache.byChain[chain] ?? null;
  } catch { return _llamaCache ? (_llamaCache.byChain[chain] ?? null) : null; }
}

// CoinGecko search cache (15 min) — so repeated searches for the same symbol are instant.
const _searchCache = new Map<string, { data: unknown; ts: number }>();
const SEARCH_TTL = 15 * 60 * 1000;

// ── Rate limit (shared table with X-Ray): per-IP cap + a GLOBAL hourly ceiling. Fail-open. ──────
// The global key is a hard circuit breaker across ALL anonymous traffic — even a distributed flood
// from many IPs can't run up unbounded serverless compute (no paid AI is reachable here, but each
// scan is still a function invocation + CPU). Both buckets reset each clock hour.
const IP_CAP_PER_HOUR = 100;
const GLOBAL_CAP_PER_HOUR = 2000;
async function isRateLimited(req: Request): Promise<boolean> {
  try {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const hour = new Date().toISOString().slice(0, 13);
    const gkey = `GLOBAL|${hour}`;
    const { data: g } = await sb.from("xray_rate_limits").select("count").eq("key", gkey).maybeSingle();
    const gcount = (g?.count as number | undefined) ?? 0;
    if (gcount >= GLOBAL_CAP_PER_HOUR) return true;
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    if (ip) {
      const key = `${ip}|${hour}`;
      const { data } = await sb.from("xray_rate_limits").select("count").eq("key", key).maybeSingle();
      const count = (data?.count as number | undefined) ?? 0;
      if (count >= IP_CAP_PER_HOUR) return true;
      await sb.from("xray_rate_limits").upsert({ key, count: count + 1, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }
    await sb.from("xray_rate_limits").upsert({ key: gkey, count: gcount + 1, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return false;
  } catch { return false; }
}

// ── Crypto card builder (ported from the command center so /x-ray renders the same shape) ──
const CRYPTO_ETF = new Set(["bitcoin", "ethereum", "solana", "ripple", "litecoin"]);
function fmtM(n: number): string { const a = Math.abs(n); if (a >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T"; if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B"; if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"; return "$" + Math.round(n).toLocaleString("en"); }
function pctS(v: number | undefined | null): string { return (v == null || !Number.isFinite(v)) ? "n/a" : ((v >= 0 ? "+" : "") + (v as number).toFixed(1) + "%"); }
/* eslint-disable @typescript-eslint/no-explicit-any */
function cryptoScoreC(md: any, coin: any) {
  const rank = coin.market_cap_rank || 999;
  const volRatio = md.market_cap?.usd ? (md.total_volume?.usd || 0) / md.market_cap.usd * 100 : 0;
  const tvl = Number.isFinite(coin._tvl) ? coin._tvl : null;
  const clamp2 = (v: number) => Math.max(0, Math.min(2, v));
  const sizeRaw = clamp2(2 - (rank - 1) * 0.06);
  const liqRaw = clamp2(volRatio * 0.5);
  const supplyRaw = md.max_supply ? clamp2(0.8 + ((md.circulating_supply || 0) / md.max_supply) * 1.2) : 0.8;
  const etfRaw = CRYPTO_ETF.has(coin.id) ? 1 : 0;
  const tvlTier = tvl == null ? 0 : tvl > 1e10 ? 1 : tvl > 2e9 ? 0.85 : tvl > 3e8 ? 0.6 : tvl > 3e7 ? 0.4 : tvl > 3e6 ? 0.2 : 0;
  const utilRaw = Math.max(tvlTier, etfRaw ? 0.5 : 0);
  const score = Math.round(Math.max(0, Math.min(10, sizeRaw * 0.75 + liqRaw * 0.6 + supplyRaw * 0.75 + etfRaw * 2.5 + utilRaw * 3.5)) * 10) / 10;
  const sc = (v: number, max: number) => Math.round((v / max) * 100) / 10;
  return { score, components: [
    { label: "Size & rank", value: sc(sizeRaw, 2) },
    { label: "Liquidity (vol/mcap)", value: sc(liqRaw, 2) },
    { label: "Supply discipline", value: sc(supplyRaw, 2) },
    { label: "ETF / institutional access", value: etfRaw ? 10 : 0 },
    { label: "On-chain utility (TVL)", value: sc(utilRaw, 1) },
  ] };
}
function buildCryptoCard(symbol: string, coin: any) {
  const md = coin.market_data;
  const current = md.current_price?.usd, ath = md.ath?.usd, atl = md.atl?.usd;
  const athDrop = md.ath_change_percentage?.usd, atlGain = md.atl_change_percentage?.usd;
  const circ = md.circulating_supply, max = md.max_supply;
  const supplyPct = max ? circ / max * 100 : NaN;
  const volRatio = md.market_cap?.usd ? (md.total_volume?.usd || 0) / md.market_cap.usd * 100 : NaN;
  const cs = cryptoScoreC(md, coin);
  const rank = coin.market_cap_rank;
  const metrics = [
    { label: "Current Price", value: Number.isFinite(current) ? "$" + current.toLocaleString("en", { maximumFractionDigits: current < 1 ? 4 : 2 }) : "n/a", status: "watch" },
    { label: "Market Cap / Rank", value: fmtM(md.market_cap?.usd || 0) + " / #" + (rank || "n/a"), status: rank <= 10 ? "good" : rank <= 50 ? "watch" : "bad" },
    { label: "24h / 7d / 30d", value: pctS(md.price_change_percentage_24h) + " / " + pctS(md.price_change_percentage_7d) + " / " + pctS(md.price_change_percentage_30d), status: (md.price_change_percentage_7d || 0) >= 0 ? "good" : "bad" },
    { label: "1Y Change", value: pctS(md.price_change_percentage_1y), status: (md.price_change_percentage_1y || 0) >= 0 ? "good" : "bad" },
    { label: "ATH Distance", value: Number.isFinite(ath) ? "$" + ath.toFixed(ath < 1 ? 4 : 2) + " / " + pctS(athDrop) : "n/a", status: Math.abs(athDrop || 0) > 70 ? "good" : Math.abs(athDrop || 0) > 30 ? "watch" : "bad" },
    { label: "ATL Recovery", value: Number.isFinite(atl) ? "$" + atl.toFixed(atl < 1 ? 4 : 2) + " / " + pctS(atlGain) : "n/a", status: "watch" },
    { label: "Supply", value: Number.isFinite(supplyPct) ? supplyPct.toFixed(0) + "% of max supply" : "No fixed max supply", status: Number.isFinite(supplyPct) ? (supplyPct > 80 ? "good" : "watch") : "bad" },
    { label: "Volume / MCap", value: Number.isFinite(volRatio) ? volRatio.toFixed(2) + "%" : "n/a", status: Number.isFinite(volRatio) ? (volRatio > 1 ? "good" : volRatio > .1 ? "watch" : "bad") : "watch" },
    { label: "ETF Access", value: CRYPTO_ETF.has(coin.id) ? "Spot ETF available" : "No spot ETF yet", status: CRYPTO_ETF.has(coin.id) ? "good" : "watch" },
    { label: "On-chain TVL", value: (Number.isFinite(coin._tvl) && coin._tvl > 0) ? fmtM(coin._tvl) + " locked" : "n/a (not a DeFi chain)", status: (Number.isFinite(coin._tvl) && coin._tvl > 1e9) ? "good" : (Number.isFinite(coin._tvl) && coin._tvl > 1e8) ? "watch" : "bad" },
    { label: "Exchange Listings", value: Array.isArray(coin.tickers) ? coin.tickers.length + " markets" : "n/a", status: Array.isArray(coin.tickers) && coin.tickers.length > 50 ? "good" : "watch" },
  ];
  const valuation = [
    { label: "ATH Recovery", value: Number.isFinite(athDrop) ? Math.max(0, 100 + athDrop).toFixed(0) + "% of ATH" : "n/a", status: Math.abs(athDrop || 0) > 70 ? "good" : "watch", context: "Full bar means price is back near its all-time high" },
    { label: "Supply Inflation Risk", value: Number.isFinite(supplyPct) ? supplyPct.toFixed(0) + "% circulating" : "No max supply", status: Number.isFinite(supplyPct) ? (supplyPct > 80 ? "good" : "watch") : "bad", context: Number.isFinite(supplyPct) ? "Higher circulation means less future supply pressure" : "Uncapped supply risk" },
    { label: "Liquidity", value: Number.isFinite(volRatio) ? volRatio.toFixed(2) + "% volume/mcap" : "n/a", status: Number.isFinite(volRatio) ? (volRatio > 1 ? "good" : volRatio > .1 ? "watch" : "bad") : "watch", context: "Higher volume means easier exits" },
  ];
  return { symbol, name: coin.name, assetType: "crypto", scoreKind: "crypto" as const, score: cs.score, scoreLabel: cs.score >= 7 ? "Strong" : cs.score >= 4 ? "Mixed" : "Weak", scoreComponents: cs.components, sector: "Cryptocurrency", industry: (coin.categories || []).filter(Boolean)[0] || "Digital asset", metrics, valuation };
}

export async function GET(request: Request) {
  if (await isRateLimited(request)) return NextResponse.json({ error: "Rate limit reached — try again shortly." }, { status: 429 });
  const { searchParams } = new URL(request.url);

  // ?card=SYMBOL — resolve a ticker (BTC-USD, XRP-CAD, BTC) to a full X-Ray-shaped crypto card.
  const cardQ = (searchParams.get("card") || "").trim().toUpperCase();
  if (cardQ) {
    const base = cardQ.replace(/-(USD|CAD|USDT)$/, "").toLowerCase();
    try {
      const sr = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(base)}`, { headers: { Accept: "application/json", "User-Agent": "Plainview/1.0" }, next: { revalidate: 900 } });
      if (!sr.ok) return NextResponse.json({ error: "resolve failed" }, { status: 502 });
      const sd = await sr.json() as { coins?: Array<{ id: string; symbol: string }> };
      const coins = sd.coins || [];
      const match = coins.find(c => c.symbol?.toLowerCase() === base) || coins[0];
      if (!match) return NextResponse.json({ error: "not a known crypto" }, { status: 404 });
      const id = match.id;
      let coin: any = mem.get(id)?.data;
      const fresh = mem.get(id) && Date.now() - (mem.get(id) as { ts: number }).ts < TTL;
      if (!coin || !fresh) {
        const r = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=true&sparkline=false`, { headers: { Accept: "application/json", "User-Agent": "Plainview/1.0" }, next: { revalidate: 300 } });
        if (r.ok) { coin = await r.json(); if (coin?.market_data) { coin._tvl = await chainTvl(id); mem.set(id, { data: coin, ts: Date.now() }); } }
      }
      if (!coin?.market_data) return NextResponse.json({ error: "no market data" }, { status: 502 });
      return NextResponse.json(buildCryptoCard(cardQ, coin));
    } catch { return NextResponse.json({ error: "crypto card failed" }, { status: 502 }); }
  }


  // ?search=SYMBOL — resolve a ticker symbol to a CoinGecko id. Returns {id,name,symbol} or 404.
  const searchQ = (searchParams.get("search") || "").trim().toLowerCase();
  if (searchQ) {
    const sc = _searchCache.get(searchQ);
    if (sc && Date.now() - sc.ts < SEARCH_TTL) return NextResponse.json(sc.data);
    try {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(searchQ)}`,
        { headers: { Accept: "application/json", "User-Agent": "Plainview/1.0" }, next: { revalidate: 900 } }
      );
      if (r.ok) {
        const d = await r.json() as { coins?: Array<{ id: string; name: string; symbol: string; market_cap_rank?: number }> };
        const coins = d.coins || [];
        // Prefer exact symbol match, then the top-ranked result
        const exact = coins.find(c => c.symbol?.toLowerCase() === searchQ);
        const match = exact || coins[0];
        if (match) {
          const result = { id: match.id, name: match.name, symbol: match.symbol?.toUpperCase(), market_cap_rank: match.market_cap_rank };
          _searchCache.set(searchQ, { data: result, ts: Date.now() });
          return NextResponse.json(result);
        }
      }
    } catch { /* fall through */ }
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const id = (searchParams.get("id") || "").trim().toLowerCase();
  if (!id || !/^[a-z0-9-]+$/.test(id)) return NextResponse.json({ error: "valid coin id required" }, { status: 400 });

  const cached = mem.get(id);
  if (cached && Date.now() - cached.ts < TTL) return NextResponse.json(cached.data);

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=true&sparkline=false`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Plainview/1.0" }, next: { revalidate: 300 } });
    if (!r.ok) {
      if (cached) return NextResponse.json(cached.data); // serve stale rather than fail
      return NextResponse.json({ error: `coingecko ${r.status}` }, { status: 502 });
    }
    const data = await r.json();
    if (data && data.market_data) {
      data._tvl = await chainTvl(id); // on-chain TVL utility signal (null if the coin has no DeFi chain)
      mem.set(id, { data, ts: Date.now() });
    }
    return NextResponse.json(data);
  } catch {
    if (cached) return NextResponse.json(cached.data);
    return NextResponse.json({ error: "crypto fetch failed" }, { status: 502 });
  }
}
