// Live Memory Layer — public surface.
// Agents use runAgentTask(); the manager uses the planning/briefing helpers.
export * from "./types";
export {
  runAgentTask,
  loadState,
  isDone,
  LoopPersistError,
  type RunOptions,
} from "./loopState";
export {
  sortBoard,
  decideDispatch,
  planCycle,
  renderBriefing,
  getBoard,
  type DispatchAction,
  type DispatchDecision,
  type DispatchContext,
} from "./manager";
export { createSupabaseLoopClient } from "./supabaseLoopClient";
