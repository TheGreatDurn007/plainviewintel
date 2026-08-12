import type { MetadataRoute } from "next";

// Crawl directives for Google et al. Allow the public surfaces (X-Ray funnel, pricing, landing), keep
// the API + owner Admin out of the index, and point crawlers at the sitemap so the per-ticker X-Ray
// pages get discovered. Must be reachable logged-out — middleware exempts /robots.txt + /sitemap.xml.
export default function robots(): MetadataRoute.Robots {
  const base = "https://plainviewintel.com";
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/api/", "/admin", "/login"] },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
