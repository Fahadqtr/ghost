// The Read -> Act -> Persist loop (malika-loop-state-spec.md §3).
//
// Every agent task goes through runAgentTask(). Order is fixed:
//   1. LOAD    state before acting (create a default idle row on cold start)
//   2. ACT     do the work with the carried-over context + resume pointer
//   3. PERSIST write state after acting — THIS is the memory
//   4. GATE    a run is not "done" until loop_state is persisted (fail closed)
//
// No Supabase import here on purpose: the helper talks to a LoopClient, so it
// runs under `node --test` with an in-memory fake. The real client lives in
// supabaseLoopClient.ts.

import type {
  LoopClient,
  LoopState,
  LoopStatus,
  WorkInput,
  WorkResult,
} from "./types";

/** randomUUID without importing node:crypto at module top (keeps strip-types
 *  happy + works in both the Edge/Node runtimes the app may use). */
function uuid(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback (non-crypto) — only hit in environments without WebCrypto.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raised when state could not be persisted after retries. A run that throws
 *  this did NOT happen — callers must not treat it as done. */
export class LoopPersistError extends Error {
  readonly agentKey: string;
  readonly loopKey: string;
  readonly reason?: string;
  constructor(agentKey: string, loopKey: string, reason?: string) {
    super(
      `loop_state persist failed for ${agentKey}/${loopKey}` +
        (reason ? `: ${reason}` : "")
    );
    this.name = "LoopPersistError";
    this.agentKey = agentKey;
    this.loopKey = loopKey;
    this.reason = reason;
  }
}

export interface RunOptions {
  /** Persist retries after the first attempt (spec: "retry x2"). Default 2. */
  persistRetries?: number;
  /** Base backoff between persist attempts, ms. Default 200. */
  backoffMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** LOAD step: read state; create a default idle row on cold start (run_count 0). */
export async function loadState(
  client: LoopClient,
  agentKey: string,
  loopKey: string,
  now: () => Date = () => new Date()
): Promise<LoopState> {
  const existing = await client.getState(agentKey, loopKey);
  if (existing) return existing;

  // Cold start — materialize the baseline row so the next run has memory.
  const seed = await client.upsertState({
    agent_key: agentKey,
    loop_key: loopKey,
    status: "idle",
    goal: null,
    last_task: null,
    last_result: null,
    next_action: null,
    context: {},
    run_count: 0,
    updated_at: now().toISOString(),
  });
  if (!seed.ok || !seed.data) {
    throw new LoopPersistError(agentKey, loopKey, seed.error ?? "cold-start seed failed");
  }
  return seed.data;
}

/** PERSIST step with the fail-closed gate. Retries, then throws on failure. */
async function persistState(
  client: LoopClient,
  prior: LoopState,
  result: WorkResult,
  opts: Required<Pick<RunOptions, "persistRetries" | "backoffMs" | "now">>
): Promise<LoopState> {
  const row = {
    agent_key: prior.agent_key,
    loop_key: prior.loop_key,
    status: result.status,
    last_task: result.task,
    last_result: result.summary,
    next_action: result.next,
    context: result.new_context,
    run_count: prior.run_count + 1,
    updated_at: opts.now().toISOString(),
    goal: prior.goal,
  };

  let lastErr: string | undefined;
  for (let attempt = 0; attempt <= opts.persistRetries; attempt++) {
    const res = await client.upsertState(row);
    if (res.ok && res.data) return res.data;
    lastErr = res.error ?? "unknown upsert error";
    if (attempt < opts.persistRetries) await sleep(opts.backoffMs * (attempt + 1));
  }
  throw new LoopPersistError(prior.agent_key, prior.loop_key, lastErr);
}

/**
 * Run one agent task end to end (Read -> Act -> Persist -> Gate).
 *
 * @returns the persisted LoopState (status reflects the work result).
 * @throws  LoopPersistError if state could not be persisted — the run is then
 *          logged as 'error' (best effort) and is NOT considered done.
 */
export async function runAgentTask(
  client: LoopClient,
  agentKey: string,
  loopKey: string,
  doWork: (input: WorkInput) => Promise<WorkResult>,
  options: RunOptions = {}
): Promise<LoopState> {
  const now = options.now ?? (() => new Date());
  const opts = {
    persistRetries: options.persistRetries ?? 2,
    backoffMs: options.backoffMs ?? 200,
    now,
  };
  const run_id = uuid();

  // 1. LOAD
  const prior = await loadState(client, agentKey, loopKey, now);
  await client.insertLog({ agent_key: agentKey, loop_key: loopKey, event: "started", run_id });

  // 2. ACT
  let result: WorkResult;
  try {
    result = await doWork({ goal: prior.goal, context: prior.context, resume: prior.next_action });
  } catch (err) {
    // The work threw — record an error event, persist an 'error' snapshot so the
    // failure is durable, then rethrow. Still fail closed (never silently done).
    const message = err instanceof Error ? err.message : String(err);
    result = {
      status: "error",
      task: prior.last_task ?? "(unknown)",
      summary: `doWork threw: ${message}`,
      next: prior.next_action ?? "",
      new_context: prior.context,
    };
    const persisted = await safePersist(client, prior, result, opts, run_id);
    await client.insertLog({
      agent_key: agentKey,
      loop_key: loopKey,
      event: "error",
      detail: message,
      payload: { run_id, stage: "act" },
      run_id,
    });
    if (persisted) throw err;
    throw new LoopPersistError(agentKey, loopKey, message);
  }

  // 3. PERSIST + 4. GATE
  let persistedState: LoopState;
  try {
    persistedState = await persistState(client, prior, result, opts);
  } catch (e) {
    // Could not persist -> the run did NOT happen. Log error, fail closed.
    await client.insertLog({
      agent_key: agentKey,
      loop_key: loopKey,
      event: "error",
      detail: e instanceof Error ? e.message : String(e),
      payload: { run_id, stage: "persist" },
      run_id,
    });
    throw e;
  }

  // Completion event mirrors the persisted status (started/blocked/completed/...).
  const event =
    result.status === "blocked"
      ? "blocked"
      : result.status === "error"
        ? "error"
        : "completed";
  await client.insertLog({
    agent_key: agentKey,
    loop_key: loopKey,
    event,
    detail: result.summary,
    payload: { run_id, status: result.status },
    run_id,
  });

  return persistedState;
}

/** Best-effort persist used on the act-threw path; returns whether it stuck. */
async function safePersist(
  client: LoopClient,
  prior: LoopState,
  result: WorkResult,
  opts: Required<Pick<RunOptions, "persistRetries" | "backoffMs" | "now">>,
  _run_id: string
): Promise<boolean> {
  try {
    await persistState(client, prior, result, opts);
    return true;
  } catch {
    return false;
  }
}

/** Convenience: true only for a genuinely completed run. */
export function isDone(state: LoopState): boolean {
  return state.status === "done";
}

export type { LoopStatus };
