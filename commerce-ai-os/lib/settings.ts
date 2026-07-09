import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// System-wide settings (app_settings key/value table). Every read is defensive:
// a missing table or unset key falls back to the safe default, so the app keeps
// working before supabase/app_settings.sql is run.

/**
 * Inventory mode for the whole system:
 *  - "quantities" — track exact stock numbers (default, current behaviour).
 *  - "simple"     — just In-stock / Out-of-stock per product, no numbers.
 */
export type InventoryMode = "quantities" | "simple";

const INVENTORY_MODE_KEY = "inventory_mode";

function adminOrNull(): any | null {
  try {
    return createAdminClient();
  } catch {
    return null;
  }
}

export async function getInventoryMode(): Promise<InventoryMode> {
  const admin = adminOrNull();
  if (!admin) return "quantities";
  try {
    const { data, error } = await admin
      .from("app_settings")
      .select("value")
      .eq("key", INVENTORY_MODE_KEY)
      .maybeSingle();
    if (error) return "quantities";
    return (data as any)?.value?.mode === "simple" ? "simple" : "quantities";
  } catch {
    return "quantities";
  }
}

export async function setInventoryMode(mode: InventoryMode): Promise<{ ok: boolean; error?: string }> {
  const admin = adminOrNull();
  if (!admin) return { ok: false, error: "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY)." };
  try {
    const { error } = await admin
      .from("app_settings")
      .upsert({ key: INVENTORY_MODE_KEY, value: { mode }, updated_at: new Date().toISOString() });
    if (error) {
      if ((error as any).code === "42P01") return { ok: false, error: "شغّل supabase/app_settings.sql أول." };
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل الحفظ" };
  }
}
