import { createClient } from "@/lib/supabase/server";
import ChannelMatrix, {
  type MatrixChannel,
  type MatrixProduct,
} from "@/components/ChannelMatrix";

export const dynamic = "force-dynamic";

const PAGE = 1000; // PostgREST caps a single response — fetch in ranges.

// Fetch every row of a select across paged ranges.
async function fetchAll(
  supabase: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  order?: { column: string; ascending: boolean }
): Promise<{ data: any[]; error: { message: string } | null }> {
  const data: any[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (order) query = query.order(order.column, { ascending: order.ascending });
    const res = await query;
    if (res.error) return { data, error: res.error };
    const batch = res.data ?? [];
    data.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { data, error: null };
}

export default async function ChannelsPage() {
  const supabase = createClient();

  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, supports_variants")
    .order("name");

  const [{ data: products, error: pErr }, { data: links, error: lErr }] =
    await Promise.all([
      fetchAll(supabase, "products", "id, name_en, sku", { column: "created_at", ascending: false }),
      fetchAll(supabase, "channel_products", "product_id, channel_id, channel_status"),
    ]);
  const error = pErr ?? lErr;

  const initialStatuses: Record<string, string> = {};
  for (const l of links ?? []) {
    initialStatuses[`${(l as any).product_id}:${(l as any).channel_id}`] =
      (l as any).channel_status ?? "Not Listed";
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Per-channel publishing status. Each cell is independent — toggle Active / Draft / Not Listed.
      </p>
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Couldn’t load channel data: {error.message}. Make sure you’re signed in (RLS).
        </div>
      ) : (
        <ChannelMatrix
          products={(products ?? []) as MatrixProduct[]}
          channels={(channels ?? []) as MatrixChannel[]}
          initialStatuses={initialStatuses}
        />
      )}
    </div>
  );
}
