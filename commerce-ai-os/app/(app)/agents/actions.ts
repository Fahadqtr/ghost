"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireWriterGate } from "@/lib/auth/requireUser";

// Phase 1: this ONLY records the command. No AI, no external API is called.
//
// ACC-02B batch 3 — OWNER DECISION: the writer gate, not "any signed-in
// account". The row itself is inert (agent_name + free-text command + a fixed
// result string; nothing downstream reads it to act), but agent_name is
// unvalidated free text on an unbounded-growth table, and every other mutating
// action in (app) already sits on this boundary. The owner is always in the
// writer set, so no existing user loses access.
export async function logAgentCommand(agentName: string, command: string) {
  const denied = await requireWriterGate();
  if (denied) return { error: denied.error };

  const cmd = (command ?? "").trim();
  if (!cmd) return { error: "Enter a command first." };

  // Service-role write (ACC-02B batch 2); the gate above has already run.
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_logs").insert({
    agent_name: agentName,
    command: cmd,
    result: "Logged (Phase 1 — no AI execution).",
  });

  if (error) return { error: error.message };
  revalidatePath("/agents");
  return { ok: true };
}
