"use server";

import { requireUser } from "@/lib/auth/requireUser";
import { getNotifications, type Notification } from "@/lib/notifications";

// Admin-only: the aggregated in-app notification feed for the topbar bell.
export async function fetchNotifications(): Promise<{ items: Notification[]; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { items: [], error: unauth.error };
  try {
    return await getNotifications();
  } catch {
    return { items: [] };
  }
}
