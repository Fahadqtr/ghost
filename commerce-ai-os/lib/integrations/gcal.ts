import "server-only";
import crypto from "node:crypto";
import {
  taskToEvent, parseServiceAccount, buildJwtSigningInput,
  type GcalTaskLite,
} from "./gcal-compute";

// Google Calendar push via a SERVICE ACCOUNT. The app authenticates as the
// service account (signed-JWT → access token) and creates/updates/deletes events
// on ONE business calendar shared with that account.
// Env (Vercel):
//   GOOGLE_SERVICE_ACCOUNT_JSON  — the full downloaded service-account key JSON
//   GOOGLE_CALENDAR_ID           — the calendar to write to (share it with the
//                                  service-account email, "Make changes to events")
// Nothing is written in chat; the private key lives only in Vercel.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_BASE = "https://www.googleapis.com/calendar/v3";

function clean(v: string | undefined): string { return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim(); }
function calendarId(): string { return clean(process.env.GOOGLE_CALENDAR_ID); }
function serviceAccount() { return parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
export function gcalConfigured(): boolean { return !!serviceAccount() && !!calendarId(); }

// Cache the access token in module memory until shortly before it expires.
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const sa = serviceAccount();
  if (!sa) return { ok: false, error: "GOOGLE_SERVICE_ACCOUNT_JSON غير صالح أو غير مضبوط." };
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return { ok: true, token: tokenCache.token };
  try {
    const nowSec = Math.floor(now / 1000);
    const signingInput = buildJwtSigningInput(sa.clientEmail, nowSec);
    const sig = crypto.createSign("RSA-SHA256").update(signingInput).sign(sa.privateKey);
    const jwt = `${signingInput}.${sig.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt });
    const r = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(), cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    const t = await r.text();
    if (!r.ok) { console.error("[gcal] token HTTP", r.status, t.slice(0, 300)); return { ok: false, error: `فشل المصادقة مع Google (HTTP ${r.status}).` }; }
    const j = ((): any => { try { return JSON.parse(t); } catch { return null; } })();
    const token = j?.access_token;
    const expiresIn = Number(j?.expires_in) || 3600;
    if (!token) return { ok: false, error: "Google لم يرجع access_token." };
    tokenCache = { token, expiresAt: now + expiresIn * 1000 };
    return { ok: true, token };
  } catch (e: any) {
    console.error("[gcal] token threw", e?.message || e);
    return { ok: false, error: e?.message || "تعذّر المصادقة مع Google." };
  }
}

async function calFetch(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: string; json: any }> {
  const tok = await getAccessToken();
  if (!tok.ok) return { ok: false, status: 0, body: tok.error, json: null };
  const r = await fetch(`${CAL_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  const body = await r.text();
  const json = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
  return { ok: r.ok, status: r.status, body, json };
}

export type GcalConnState = "connected" | "not_connected" | "error";

/** Connection status for the settings/tasks UI — verifies auth AND calendar access. */
export async function gcalStatus(): Promise<{ state: GcalConnState; detail?: string; calendarId: string; email?: string }> {
  const sa = serviceAccount();
  const cid = calendarId();
  if (!sa) return { state: "not_connected", detail: "GOOGLE_SERVICE_ACCOUNT_JSON غير مضبوط أو غير صالح.", calendarId: cid };
  if (!cid) return { state: "not_connected", detail: "GOOGLE_CALENDAR_ID غير مضبوط.", calendarId: cid, email: sa.clientEmail };
  const r = await calFetch(`/calendars/${encodeURIComponent(cid)}`, { method: "GET" });
  if (r.ok) return { state: "connected", calendarId: cid, email: sa.clientEmail };
  if (r.status === 401 || r.status === 403) return { state: "error", detail: `لا صلاحية على التقويم — شارِك التقويم مع ${sa.clientEmail} بصلاحية تعديل. (HTTP ${r.status})`, calendarId: cid, email: sa.clientEmail };
  if (r.status === 404) return { state: "error", detail: "التقويم غير موجود — تأكد من GOOGLE_CALENDAR_ID.", calendarId: cid, email: sa.clientEmail };
  return { state: "error", detail: r.body?.slice(0, 160) || "تعذّر الوصول إلى التقويم.", calendarId: cid, email: sa.clientEmail };
}

export interface EventResult { ok: boolean; eventId?: string; error?: string }

/** Create or update the calendar event for a task. Returns the event id. */
export async function upsertTaskEvent(task: GcalTaskLite, existingEventId?: string | null): Promise<EventResult> {
  if (!gcalConfigured()) return { ok: false, error: "Google Calendar غير مهيأ." };
  const cid = encodeURIComponent(calendarId());
  const event = taskToEvent(task);
  const existing = String(existingEventId || "").trim();
  const r = existing
    ? await calFetch(`/calendars/${cid}/events/${encodeURIComponent(existing)}`, { method: "PUT", body: JSON.stringify(event) })
    : await calFetch(`/calendars/${cid}/events`, { method: "POST", body: JSON.stringify(event) });
  // A stale/missing event id (deleted in Google) → recreate once.
  if (!r.ok && existing && (r.status === 404 || r.status === 410)) {
    const c = await calFetch(`/calendars/${cid}/events`, { method: "POST", body: JSON.stringify(event) });
    if (!c.ok) return { ok: false, error: `Google HTTP ${c.status} — ${c.body.slice(0, 160)}` };
    return { ok: true, eventId: c.json?.id };
  }
  if (!r.ok) return { ok: false, error: `Google HTTP ${r.status} — ${r.body.slice(0, 160)}` };
  return { ok: true, eventId: r.json?.id || existing };
}

/** Delete a task's calendar event. Treats already-gone as success. */
export async function deleteTaskEvent(eventId: string): Promise<EventResult> {
  if (!gcalConfigured()) return { ok: false, error: "Google Calendar غير مهيأ." };
  const id = String(eventId || "").trim();
  if (!id) return { ok: true };
  const cid = encodeURIComponent(calendarId());
  const r = await calFetch(`/calendars/${cid}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (r.ok || r.status === 404 || r.status === 410) return { ok: true };
  return { ok: false, error: `Google HTTP ${r.status} — ${r.body.slice(0, 160)}` };
}
