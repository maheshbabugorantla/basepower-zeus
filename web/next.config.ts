import type { NextConfig } from "next";

// M0-D1: minimal config. Later tickets (M0-W0, M0-W2, …) add image domains,
// redirects, etc. as needed — do not add anything speculative here.
//
// Static art under /public (the Zeus mark in /brand, the intro reel's scene
// art in /intro, the MapLibre worker in /maplibre) is served from Vercel's
// CDN. Vercel's default Cache-Control for /public is max-age=0 (the browser
// re-checks every load); these file names are not content-hashed, so give
// browsers a day and let them keep a stale copy for a week while they
// revalidate in the background. A changed file reaches everyone within a day.
const LONG_LIVED = "public, max-age=86400, stale-while-revalidate=604800";

const nextConfig: NextConfig = {
  async headers() {
    return ["/brand/:path*", "/intro/:path*", "/maplibre/:path*"].map((source) => ({
      source,
      headers: [{ key: "Cache-Control", value: LONG_LIVED }],
    }));
  },
};

export default nextConfig;
