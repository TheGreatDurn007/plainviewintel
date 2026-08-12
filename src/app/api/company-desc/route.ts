import { NextResponse } from "next/server";
import { fetchCompanyDescription } from "@/lib/market-context";

// Lazy one-paragraph "what this company does" — fetched only when a user taps a ticker on the radar.
export const maxDuration = 15;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ ticker: "", description: null });
  const description = await fetchCompanyDescription(ticker);
  return NextResponse.json({ ticker, description });
}
