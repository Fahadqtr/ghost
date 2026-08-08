import "server-only";
// Malikas V2 — TickTick Open API client (Phase UI.7.5). SERVER-ONLY I/O.
//
// Auth: a TickTick OAuth access token, provisioned ONCE by the owner (see the
// PR's OWNER SETUP), read from env server-side only. The token is NEVER sent to
// the browser and NEVER logged. Every failure is raised as a TickTickError with
// a fixed Arabic message — a raw API body / URL / token never leaks.
//
// Env:
//   TICKTICK_ACCESS_TOKEN            OAuth access token (server-side secret)
//   TICKTICK_PROJECT_PHOTOS_ID       list ids (no id → those tasks are skipped)
//   TICKTICK_PROJECT_REVIEW_ID
//   TICKTICK_PROJECT_NEWPRODUCTS_ID
//   TICKTICK_PROJECT_SHOPIFY_ID
//   TICKTICK_PROJECT_PURESOUL_ID
//   TICKTICK_PROJECT_TALABAT_ID
//   TICKTICK_PROJECT_RAFEEQ_ID
//   MALAKAS_APP_URL                  optional deep-link base (defaults to prod)

import { TickTickError, classifyHttpStatus } from "./errors";
import { DEFAULT_APP_URL } from "./mapper";
import { loadProjectBrowser, type ProjectBrowserState } from "./projects";
import type {
  TickTickClient,
  TickTickConnState,
  TickTickProjectMap,
  TickTickTaskPayload,
  TickTickTaskRecord,
} from "./types";

const API_BASE = "https://api.ticktick.com/open/v1";
const TIMEOUT_MS = 15_000;

function clean(v: string | undefined): string {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

function token(): string {
  return clean(process.env.TICKTICK_ACCESS_TOKEN);
}

export function ticktickConfigured(): boolean {
  return token() !== "";
}

/** Deep-link base for product URLs (never contains a secret). */
export function appBaseUrl(): string {
  return clean(process.env.MALAKAS_APP_URL) || DEFAULT_APP_URL;
}

/** Build the projectKey → id map from env. Unconfigured keys are simply absent
 *  (their tasks are skipped by the adapter — never dropped into the Inbox). */
export function projectMapFromEnv(): TickTickProjectMap {
  const map: TickTickProjectMap = {};
  const put = (k: keyof TickTickProjectMap, envName: string) => {
    const v = clean(process.env[envName]);
    if (v) map[k] = v;
  };
  put("photos", "TICKTICK_PROJECT_PHOTOS_ID");
  put("review", "TICKTICK_PROJECT_REVIEW_ID");
  put("new_products", "TICKTICK_PROJECT_NEWPRODUCTS_ID");
  put("shopify", "TICKTICK_PROJECT_SHOPIFY_ID");
  put("puresoul", "TICKTICK_PROJECT_PURESOUL_ID");
  put("talabat", "TICKTICK_PROJECT_TALABAT_ID");
  put("rafeeq", "TICKTICK_PROJECT_RAFEEQ_ID");
  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One authenticated request with a timeout and a single retry on 429/5xx. The
 *  Authorization header (the token) is never logged; only the status is. */
async function ttFetch(
  path: string,
  init: RequestInit,
  attempt = 0,
): Promise<{ status: number; json: unknown }> {
  const tok = token();
  if (!tok) throw new TickTickError("not_configured");
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers || {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") throw new TickTickError("timeout");
    throw new TickTickError("unavailable");
  }
  if (!res.ok) {
    // one bounded retry for transient throttling / server errors
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      await sleep(600);
      return ttFetch(path, init, attempt + 1);
    }
    // status only — never the body or the token
    console.error("[ticktick] HTTP", res.status);
    throw new TickTickError(classifyHttpStatus(res.status));
  }
  const text = await res.text();
  const json = ((): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } })();
  return { status: res.status, json };
}

function s(v: unknown): string | undefined { return typeof v === "string" && v !== "" ? v : undefined; }
function n(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }

function toRecord(raw: unknown): TickTickTaskRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = s(o.id);
  if (!id) return null;
  return {
    id,
    projectId: s(o.projectId),
    title: s(o.title),
    content: s(o.content),
    status: n(o.status),
    priority: n(o.priority),
    modifiedTime: s(o.modifiedTime),
    completedTime: s(o.completedTime),
  };
}

/** The real, server-only TickTick client (implements the injected interface). */
export function getTickTickClient(): TickTickClient {
  return {
    async listProjectTasks(projectIds) {
      const out: TickTickTaskRecord[] = [];
      for (const pid of projectIds) {
        const { json } = await ttFetch(`/project/${encodeURIComponent(pid)}/data`, { method: "GET" });
        const tasks = (json as { tasks?: unknown } | null)?.tasks;
        if (Array.isArray(tasks)) {
          for (const t of tasks) {
            const rec = toRecord(t);
            if (rec) out.push(rec.projectId ? rec : { ...rec, projectId: pid });
          }
        }
      }
      return out;
    },
    async createTask(payload: TickTickTaskPayload) {
      const { json } = await ttFetch(`/task`, { method: "POST", body: JSON.stringify(payload) });
      const rec = toRecord(json);
      if (!rec) throw new TickTickError("bad_response");
      return rec;
    },
    async updateTask(payload: TickTickTaskPayload & { id: string }) {
      const { json } = await ttFetch(`/task/${encodeURIComponent(payload.id)}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const rec = toRecord(json);
      // Some updates return an empty body on success — reflect the sent ids back.
      return rec ?? { id: payload.id, projectId: payload.projectId };
    },
    async completeTask(projectId: string, taskId: string) {
      await ttFetch(
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
        { method: "POST" },
      );
    },
  };
}

/** Owner-only TickTick Project Browser data (read-only). Composes the pure
 *  planner with a GET /project reader: no configured token → not_connected; a
 *  successful read → the normalized project rows; any failure → a fixed Arabic
 *  message. Only GET is ever issued — this never creates/updates/completes a
 *  task — and it never returns or logs the token. */
export function loadTickTickProjectBrowser(): Promise<ProjectBrowserState> {
  return loadProjectBrowser({
    configured: ticktickConfigured(),
    listProjects: () => ttFetch(`/project`, { method: "GET" }).then((r) => r.json),
  });
}

/** Connection status for the tasks UI — verifies the token can list projects.
 *  Returns a safe state; never throws, never leaks a token or raw error. */
export async function ticktickStatus(): Promise<{ state: TickTickConnState; detail?: string }> {
  if (!ticktickConfigured()) return { state: "not_connected", detail: "TICKTICK_ACCESS_TOKEN غير مضبوط." };
  try {
    await ttFetch(`/project`, { method: "GET" });
    return { state: "connected" };
  } catch (e) {
    if (e instanceof TickTickError) return { state: "error", detail: e.message };
    return { state: "error", detail: "تعذّر الوصول إلى TickTick." };
  }
}
