"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Phase 1: this ONLY records the command. No AI, no external API is called.
export async function logAgentCommand(agentName: string, command: string) {
  const cmd = (command ?? "").trim();
  if (!cmd) return { error: "Enter a command first." };

  const supabase = createClient();
  const { error } = await supabase.from("agent_logs").insert({
    agent_name: agentName,
    command: cmd,
    result: "Logged (Phase 1 — no AI execution).",
  });

  if (error) return { error: error.message };
  revalidatePath("/agents");
  return { ok: true };
}
