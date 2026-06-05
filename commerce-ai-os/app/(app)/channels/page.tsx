import { createClient } from "@/lib/supabase/server";
import ChannelMatrix, {
  type MatrixChannel,
  type MatrixProduct,
} from "@/components/ChannelMatrix";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const supabase = createClient();

  const [{ data: products }, { data: channels }, { data: links, error }] =
    await Promise.all([
      supabase
        .from("products")
        .select("id, name_en, sku")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase.from("channels").select("id, name, supports_variants").order("name"),
      supabase.from("channel_products").select("product_id, channel_id, channel_status"),
    ]);

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
