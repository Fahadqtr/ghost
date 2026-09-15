"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";

// Phase 1: this ONLY records the command. No AI, no external API is called.
export async function logAgentCommand(agentName: string, command: string) {
  const unauth = await requireUser();
  if (unauth) return { error: unauth.error };

  const cmd = (command ?? "").trim();
  if (!cmd) return { error: "Enter a command first." };

  // ACC-02B batch 2 — SYSTEM-SERVICE write: this row is bookkeeping for an
  // action the caller was already permitted to take, so the gate above is
  // unchanged (no widening, no narrowing) and only the client moves to the
  // service role. Who may call this is untouched; see the PR for the open
  // question of whether it should be tightened further.
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
