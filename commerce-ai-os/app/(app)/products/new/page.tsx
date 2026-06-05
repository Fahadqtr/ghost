import { createClient } from "@/lib/supabase/server";
import ProductForm from "@/components/ProductForm";
import type { Brand } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const supabase = createClient();
  const { data: brands } = await supabase.from("brands").select("id, name").order("name");

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h2 className="text-lg font-semibold text-ink">New product</h2>
      <ProductForm brands={(brands ?? []) as Brand[]} />
    </div>
  );
}
