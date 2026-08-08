// Malikas V2 — TickTick Project Browser (read-only). PURE: no I/O, no clock, no
// secrets. Shapes the TickTick Open API `GET /project` response into the small,
// safe row the owner-only browser page renders, and orchestrates the three
// display states (not connected / error / ok) over an INJECTED read function.
//
// This is a display helper only — it carries NO Malikas business logic and never
// creates, updates, or completes a task. The injected reader is expected to be a
// GET-only call; nothing here can perform a write.
//
// The one runtime dependency (the error normalizer) is loaded with a dynamic
// import inside the handler so this module's static imports stay type-only and it
// loads directly under node:test — mirroring adapter.ts.

/** One TickTick list (project) as shown in the browser table. Only these four
 *  public fields ever cross to the browser — never a token or a raw API object. */
export interface TickTickProjectSummary {
  /** the TickTick project id (safe to display/copy — it is not a secret) */
  id: string;
  /** project name (falls back to a fixed Arabic placeholder when missing) */
  name: string;
  /** true when the list is archived/closed in TickTick */
  closed: boolean;
  /** e.g. "list" | "kanban" | "timeline" — absent when TickTick omits it */
  viewMode?: string;
}

/** The three states the owner-only page renders. `error` carries ONLY a fixed
 *  Arabic message (never a raw API body / URL / token / stack). */
export type ProjectBrowserState =
  | { state: "not_connected" }
  | { state: "error"; message: string }
  | { state: "ok"; projects: TickTickProjectSummary[] };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Normalize the raw `GET /project` payload (an array of project objects) into
 *  safe rows. Non-array input → []; malformed entries and entries without an id
 *  are dropped; only the four public fields are kept (nothing else passes
 *  through, so no stray/sensitive field can leak). */
export function normalizeProjects(raw: unknown): TickTickProjectSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: TickTickProjectSummary[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!id) continue;
    out.push({
      id,
      name: str(o.name) ?? "(بدون اسم)",
      closed: o.closed === true,
      viewMode: str(o.viewMode),
    });
  }
  return out;
}

/** Dependencies for {@link loadProjectBrowser}. `listProjects` is a read-only
 *  call injected by the caller (the real client passes a GET /project reader;
 *  tests pass a fake) — this module therefore does no I/O itself. */
export interface ProjectBrowserDeps {
  /** whether a TickTick access token is configured server-side */
  configured: boolean;
  /** read-only fetch of the raw project list (GET /project) */
  listProjects: () => Promise<unknown>;
  /** error → fixed Arabic message. Injected in tests; lazily bound to the real
   *  pure normalizer in production (keeps static imports type-only for node:test). */
  toSafeMessage?: (err: unknown) => string;
}

/** Orchestrate the browser state:
 *  - not configured           → { state: "not_connected" }  (no call made)
 *  - reader succeeds          → { state: "ok", projects }    (empty list stays ok)
 *  - reader throws / fails    → { state: "error", message }  (fixed Arabic only)
 *  Never throws; never surfaces a raw error. */
export async function loadProjectBrowser(deps: ProjectBrowserDeps): Promise<ProjectBrowserState> {
  if (!deps.configured) return { state: "not_connected" };
  try {
    const raw = await deps.listProjects();
    return { state: "ok", projects: normalizeProjects(raw) };
  } catch (err) {
    const toSafeMessage = deps.toSafeMessage ?? (await import("./errors")).toSafeMessage;
    return { state: "error", message: toSafeMessage(err) };
  }
}
