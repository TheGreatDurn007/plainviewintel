import { ImageResponse } from "next/og";

export const runtime = "edge";

const APP = process.env.NEXT_PUBLIC_APP_URL || "https://plainviewintel.com";

export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const ticker = symbol.toUpperCase();

  let score: number | null = null;
  let name: string | null = null;
  let sector: string | null = null;
  let profitability: number | null = null;
  let balanceSheet: number | null = null;
  let revenueScale: number | null = null;
  let price: string | null = null;
  let dayChange: string | null = null;
  let revenueTtm: string | null = null;
  let grossMargin: string | null = null;
  let epsVal: string | null = null;
  let revenueGrowth: string | null = null;

  try {
    const res = await fetch(`${APP}/api/xray/${ticker}?bg=1`);
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      score = (data.score as number) ?? null;
      name = (data.name as string) ?? null;
      sector = (data.sector as string) ?? null;
      const dims = data.dimensions as Record<string, number> | undefined;
      if (dims) {
        profitability = dims.profitability ?? null;
        balanceSheet = dims.balanceSheet ?? null;
        revenueScale = dims.revenueScale ?? null;
      }
      const q = data.quote as Record<string, unknown> | undefined;
      if (q) {
        const p = q.price as number | undefined;
        if (p) price = p.toLocaleString("en-US", { style: "currency", currency: "USD" });
        const ch = q.changePercent as number | undefined;
        if (ch != null) dayChange = `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`;
      }
      const sec = data.sec as Record<string, unknown> | undefined;
      if (sec) {
        const rev = sec.revenueTtm as number | undefined;
        if (rev) {
          if (rev >= 1e9) revenueTtm = `$${(rev / 1e9).toFixed(1)}B`;
          else if (rev >= 1e6) revenueTtm = `$${(rev / 1e6).toFixed(0)}M`;
          else revenueTtm = `$${rev.toLocaleString()}`;
        }
        const gm = sec.grossMargin as number | undefined;
        if (gm != null) grossMargin = `${(gm * 100).toFixed(1)}%`;
        const eps = sec.eps as number | undefined;
        if (eps != null) epsVal = `$${eps.toFixed(2)}`;
        const rg = sec.revGrowth as number | undefined;
        if (rg != null) revenueGrowth = `${rg >= 0 ? "+" : ""}${(rg * 100).toFixed(1)}%`;
      }
    }
  } catch { /* use defaults */ }

  const scoreColor = score != null
    ? score >= 7 ? "#00ff88" : score >= 5 ? "#ffaa00" : "#ff4444"
    : "#666";

  const barColor = (val: number | null) =>
    val != null ? (val >= 7 ? "#00ff88" : val >= 5 ? "#ffaa00" : "#ff4444") : "#333";

  const hasFundamentals = revenueTtm || grossMargin || epsVal;

  return new ImageResponse(
    (
      <div style={{
        display: "flex", flexDirection: "column", width: "100%", height: "100%",
        background: "linear-gradient(135deg, #0a0a0a 0%, #111 50%, #0a1a0f 100%)",
        padding: "40px 48px 32px", fontFamily: "sans-serif", color: "white",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <span style={{ fontSize: "48px", fontWeight: 800, color: "#00ff88", letterSpacing: "-1px" }}>
                ${ticker}
              </span>
              {price && (
                <span style={{ fontSize: "30px", color: "#ccc" }}>{price}</span>
              )}
              {dayChange && (
                <span style={{ fontSize: "26px", color: dayChange.startsWith("+") ? "#00ff88" : "#ff4444" }}>
                  {dayChange}
                </span>
              )}
            </div>
            {name && <span style={{ fontSize: "20px", color: "#888", marginTop: "2px" }}>{name}</span>}
            {sector && <span style={{ fontSize: "15px", color: "#555", marginTop: "1px" }}>{sector}</span>}
          </div>

          {/* Score circle */}
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            width: "120px", height: "120px", borderRadius: "60px",
            border: `4px solid ${scoreColor}`, background: "rgba(0,0,0,0.5)",
          }}>
            <span style={{ fontSize: "44px", fontWeight: 800, color: scoreColor }}>
              {score != null ? score.toFixed(1) : "—"}
            </span>
            <span style={{ fontSize: "13px", color: "#888" }}>/10</span>
          </div>
        </div>

        {/* Middle section: bars + financials side by side */}
        <div style={{ display: "flex", gap: "40px", marginTop: "24px", flex: 1 }}>
          {/* Dimension bars */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1 }}>
            {([
              ["Profitability", profitability],
              ["Balance Sheet", balanceSheet],
              ["Revenue & Scale", revenueScale],
            ] as [string, number | null][]).map(([label, val]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "16px", color: "#aaa", width: "150px" }}>{label}</span>
                <div style={{
                  display: "flex", flex: 1, height: "20px", background: "#1a1a1a",
                  borderRadius: "10px", overflow: "hidden",
                }}>
                  <div style={{
                    width: `${(val ?? 0) * 10}%`, height: "100%",
                    background: barColor(val), borderRadius: "10px",
                  }} />
                </div>
                <span style={{ fontSize: "18px", fontWeight: 700, color: barColor(val), width: "36px", textAlign: "right" }}>
                  {val ?? "—"}
                </span>
              </div>
            ))}
          </div>

          {/* Financials grid */}
          {hasFundamentals && (
            <div style={{
              display: "flex", flexDirection: "column", gap: "8px",
              minWidth: "180px", padding: "8px 16px",
              background: "rgba(255,255,255,0.03)", borderRadius: "12px",
              border: "1px solid #222",
            }}>
              {revenueTtm && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "1px" }}>Revenue TTM</span>
                  <span style={{ fontSize: "22px", fontWeight: 700, color: "#fff" }}>{revenueTtm}</span>
                </div>
              )}
              {grossMargin && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "1px" }}>Gross Margin</span>
                  <span style={{ fontSize: "22px", fontWeight: 700, color: "#fff" }}>{grossMargin}</span>
                </div>
              )}
              {epsVal && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "1px" }}>EPS (TTM)</span>
                  <span style={{ fontSize: "22px", fontWeight: 700, color: "#fff" }}>{epsVal}</span>
                </div>
              )}
              {revenueGrowth && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "1px" }}>Rev Growth</span>
                  <span style={{ fontSize: "22px", fontWeight: 700, color: revenueGrowth.startsWith("+") ? "#00ff88" : "#ff4444" }}>{revenueGrowth}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          paddingTop: "16px", borderTop: "1px solid #222",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{
              width: "32px", height: "32px", borderRadius: "16px",
              background: "#00ff88", display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "18px", fontWeight: 800, color: "#000",
            }}>P</div>
            <span style={{ fontSize: "20px", fontWeight: 700, color: "#00ff88" }}>PLAINVIEW</span>
          </div>
          <span style={{ fontSize: "15px", color: "#666" }}>Scan any ticker free → plainviewintel.com</span>
        </div>
      </div>
    ),
    { width: 800, height: 418 }
  );
}
