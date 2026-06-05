// Agent stubs — Phase 1 placeholders ONLY.
//
// There is NO AI logic and NO external API here. These exports exist so the
// folder structure and future wiring are in place. In Phase 2, each agent gets
// a real implementation (Claude API, channel exporters, etc.).
//
// The Agents page (UI) does not import logic from here yet; it only records a
// row in `agent_logs` when a command is issued.

export interface AgentStub {
  /** Stable key matching AGENTS in lib/constants.ts. */
  key: string;
  /** Phase-1 no-op. Throws to make accidental early use obvious. */
  run: (input?: unknown) => never;
}

function notImplemented(key: string): AgentStub["run"] {
  return () => {
    throw new Error(
      `Agent "${key}" is a Phase 1 stub — no logic is implemented yet.`
    );
  };
}

export const agentStubs: Record<string, AgentStub> = Object.fromEntries(
  [
    "product",
    "image",
    "inventory",
    "channel_sync",
    "variant_splitter",
    "snoonu",
    "talabat",
    "rafeeq",
    "shopify",
    "marketing",
    "customer_service",
    "finance",
    "ceo",
  ].map((key) => [key, { key, run: notImplemented(key) }])
);
