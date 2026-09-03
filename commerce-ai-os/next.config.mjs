/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Snoonu Sync sends the parsed export (~1.6 MB+ with bilingual descriptions)
  // to a Server Action; the default body limit is 1 MB, so raise it.
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
  },
  // The Rafeeq direct-send route attaches the options reading guide as a real
  // MIME attachment, so its bytes must be traced into that serverless function
  // — `public/` is served statically and is NOT bundled with route handlers by
  // default. Without this the read fails in production and the send is blocked
  // (fail closed), rather than mailing a body that claims an absent attachment.
  outputFileTracingIncludes: {
    "/api/export/rafeeq/package/jobs/[jobId]/send": ["./public/Rafeeq-Options-Reading-Guide.png"],
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
