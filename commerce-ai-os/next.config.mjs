/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Snoonu Sync sends the parsed export (~1.6 MB+ with bilingual descriptions)
  // to a Server Action; the default body limit is 1 MB, so raise it.
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
  },
  images: {
    // Allow product/variant images served from Supabase Storage.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/**",
      },
    ],
  },
  // Never let the browser cache the Malak page HTML. Its hashed JS chunks stay
  // cacheable (names change per build), but the document must always be
  // refetched so a new deploy is picked up immediately — kills the recurring
  // "stale old version" problem.
  async headers() {
    return [
      {
        source: "/malak",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
