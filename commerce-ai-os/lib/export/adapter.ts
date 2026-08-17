// INT.2A — the generic export adapter contract (PURE types).
//
// A narrow, platform-agnostic interface every destination adapter implements.
// INT.2A ships the CONTRACT only: foundation adapters return NOT_IMPLEMENTED for
// generation/publish. Business logic must never depend on platform-specific UI.

import type { ExportCapability } from "./destinations.ts";
import type { ExportValidationItem } from "./validation.ts";
import type { ExportPreview } from "./preview.ts";

/** Sentinel for foundation stages that are declared but not yet built. */
export const NOT_IMPLEMENTED = "NOT_IMPLEMENTED" as const;
export type NotImplemented = typeof NOT_IMPLEMENTED;

export type ExportPackageResult =
  | { status: NotImplemented }
  | { status: "ready"; files: readonly string[] };

export type ExportPublishResult =
  | { status: NotImplemented }
  | { status: "ok"; published: number }
  | { status: "error"; reason: string };

/**
 * The generic export adapter. `validate` and `preview` are the read-only
 * foundations; `generatePackage`/`publish` are future stages that return
 * NOT_IMPLEMENTED in INT.2A.
 */
export interface ExportAdapter {
  key: string;
  displayName: string;
  capabilities: readonly ExportCapability[];
  /** Read-only validation of the caller-supplied candidate rows. */
  validate(input: ExportAdapterInput): Promise<readonly ExportValidationItem[]>;
  /** Read-only preview at the destination's grain. */
  preview(input: ExportAdapterInput): Promise<ExportPreview>;
  /** Future: build the downloadable package. INT.2A ⇒ NOT_IMPLEMENTED. */
  generatePackage(input: ExportAdapterInput): Promise<ExportPackageResult>;
  /** Future: publish to a live API. INT.2A ⇒ NOT_IMPLEMENTED. */
  publish(input: ExportAdapterInput): Promise<ExportPublishResult>;
}

/** What an adapter is asked to operate on — caller supplies the candidate ids. */
export interface ExportAdapterInput {
  destination: string;
  /** internal product ids the caller wants validated/previewed (never a scan here). */
  productIds?: readonly string[];
}

/** Foundation base returning NOT_IMPLEMENTED for the future stages (§4). */
export const notImplementedPackage = (): ExportPackageResult => ({ status: NOT_IMPLEMENTED });
export const notImplementedPublish = (): ExportPublishResult => ({ status: NOT_IMPLEMENTED });
