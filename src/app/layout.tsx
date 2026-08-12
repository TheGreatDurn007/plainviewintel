import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://plainviewintel.com"),
  title: { default: "Plainview — Know Any Stock in Seconds", template: "%s | Plainview" },
  description: "X-Ray any stock with a 0–10 business-quality score built from SEC filings. Revenue, margins, cash, valuation, buy zones — free, no sign-up required.",
  openGraph: {
    type: "website",
    siteName: "Plainview",
    title: "Plainview — Know Any Stock in Seconds",
    description: "X-Ray any stock with a 0–10 business-quality score built from SEC filings. Revenue, margins, cash, valuation, buy zones — free.",
    url: "https://plainviewintel.com",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
