// Compliance Checker (Agent #9) — public surface.
export * from "./types";
export { runChecks, DEFAULT_RULES } from "./checker";
export {
  assertPublishAllowed,
  guardedPublish,
  PublishBlockedError,
} from "./publishGate";
export {
  runComplianceAgent,
  parseVerdict,
  failClosedVerdict,
  COMPLIANCE_SYSTEM_PROMPT,
  COMPLIANCE_MODEL,
  type AgentDeps,
} from "./agent";
export {
  createSupabaseComplianceClient,
  assembleRules,
  COMPLIANCE_LOOP_KEY,
  COMPLIANCE_AGENT_KEY,
} from "./complianceClient";
export {
  buildPlatformPrices,
  withPlatformPrices,
  type ChannelPriceRow,
} from "./priceContext";
