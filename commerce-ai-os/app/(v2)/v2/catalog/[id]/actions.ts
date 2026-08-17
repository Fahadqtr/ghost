"use server";

// OPS.8B — product-page lifecycle transition action. THIN wrapper: it forwards
// to the single approved lifecycle mutation boundary and returns its structured
// result. All authorization, current-state re-read, validation, the single
// lifecycle_state write, and the audit append happen inside the boundary — this
// file adds no logic and writes nothing itself.

import {
  transitionProductLifecycle,
  type TransitionInput,
  type TransitionResult,
} from "@/lib/lifecycle/transition.server";

export async function runLifecycleTransition(input: TransitionInput): Promise<TransitionResult> {
  return transitionProductLifecycle(input);
}
