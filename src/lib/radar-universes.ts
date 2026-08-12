import { createClient } from "@supabase/supabase-js";

// Curated radar universes — the deliberate small-cap lists the Hidden Gem Radar scans alongside the
// screeners. Persisted in Supabase Storage (no DDL needed) and editable in-app by the owner. This
// in-code list is the seed/fallback so the radar works before anything is saved.
export type Universe = { slug: string; label: string; tickers: string[] };

export const DEFAULT_UNIVERSES: Universe[] = [
  { slug: "junior-miners", label: "Junior gold/silver", tickers: ["NG", "THM", "GORO", "MUX", "USAS", "GATO", "MAG", "SVM", "EXK", "AG"] },
  { slug: "clinical-biotech", label: "Clinical-stage biotech", tickers: ["VKTX", "CRVS", "RXRX", "ANAB", "CRNX", "RVMD", "KYMR", "NUVL", "ARWR", "SAVA"] },
  { slug: "quantum-ai", label: "Quantum / AI small-caps", tickers: ["IONQ", "RGTI", "QBTS", "QUBT", "ARQQ", "LAES", "QSI", "BBAI", "SOUN", "AEVA"] },
  { slug: "uranium-critical", label: "Uranium / critical minerals", tickers: ["UEC", "DNN", "UUUU", "NXE", "URG", "LEU", "MP", "TMC", "UROY", "EU"] },
];

const BUCKET = "plainview-state";
const KEY = "_radar/universes.json";

function storageAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

/** Read the owner-saved universes from Storage. Returns null if none saved (radar then uses defaults). */
export async function readSavedUniverses(): Promise<Universe[] | null> {
  try {
    const { data, error } = await storageAdmin().storage.from(BUCKET).download(KEY);
    if (error || !data) return null;
    const parsed = JSON.parse(await data.text());
    return Array.isArray(parsed) ? (parsed as Universe[]) : null;
  } catch {
    return null;
  }
}

export async function writeSavedUniverses(list: Universe[]): Promise<void> {
  const blob = new Blob([JSON.stringify(list)], { type: "application/json" });
  await storageAdmin().storage.from(BUCKET).upload(KEY, blob, { upsert: true, contentType: "application/json" });
}

/** Normalize/sanitize a universes payload from the editor. */
export function sanitizeUniverses(input: unknown): Universe[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((u): Universe => {
      const o = (u || {}) as Record<string, unknown>;
      const slug = String(o.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      const label = String(o.label || "").trim().slice(0, 60);
      const tickers = Array.isArray(o.tickers)
        ? Array.from(new Set(o.tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean))).slice(0, 60)
        : [];
      return { slug, label, tickers };
    })
    .filter((u) => u.slug && u.label && u.tickers.length)
    .slice(0, 20);
}
