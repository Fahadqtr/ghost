// INT.2F / INT.2F.2 — Legacy per-channel file export: FULLY RETIRED.
//
// The legacy export platform is retired in favour of the Export Center
// (/v2/export). INT.2F fenced Shopify / Snoonu / Rafeeq with a 410. INT.2F.2
// retires the LAST remaining branch — Talabat — now that its only unreplaced
// capability (persisting the channel_variant_mappings identity, the first rung of
// Talabat order-deduction) has been re-homed to the certified Talabat outbound
// flow (see lib/talabat/mapping-sync/catalog-sync.server, invoked from the
// writer-gated Talabat package route). No legacy CSV generation remains
// operator-reachable; every channel now returns 410 → the Export Center.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every retired legacy channel maps to its certified Export Center destination.
const RETIRED: Record<string, string> = {
  shopify: "/v2/export/shopify:malikas",
  snoonu: "/v2/export/snoonu:malikas",
  rafeeq: "/v2/export/rafeeq:malikas",
  talabat: "/v2/export/talabat:malikas",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ channel: string }> },
) {
  const channel = (await params).channel;
  const destination = RETIRED[channel];
  if (destination) {
    return new Response(
      `This export moved to the Export Center: ${destination}`,
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new Response("Unknown channel", { status: 400 });
}
