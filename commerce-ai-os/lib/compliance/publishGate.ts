// Publish gate (malika-compliance-checker-spec.md §5 "Gate rule").
//
// Enforced in CODE, not just the agent prompt: any publish path MUST call
// assertPublishAllowed() / guardedPublish() first. It reads the LATEST
// compliance_log row for the SKU and refuses unless publish_allowed=true.
//
// Fail closed: if there is NO verdict on record for the SKU, publishing is
// refused (a product was never checked → never published).

import type { ComplianceClient, ComplianceLogRow } from "./types";

export class PublishBlockedError extends Error {
  readonly sku: string;
  readonly latest: ComplianceLogRow | null;
  constructor(sku: string, reason: string, latest: ComplianceLogRow | null = null) {
    super(`Publish blocked for ${sku}: ${reason}`);
    this.name = "PublishBlockedError";
    this.sku = sku;
    this.latest = latest;
  }
}

/** Throws PublishBlockedError unless the latest verdict allows publishing. */
export async function assertPublishAllowed(
  client: ComplianceClient,
  sku: string
): Promise<ComplianceLogRow> {
  const latest = await client.getLatestLog(sku);
  if (!latest) {
    throw new PublishBlockedError(sku, "no compliance verdict on record (fail-closed)");
  }
  if (!latest.publish_allowed) {
    throw new PublishBlockedError(
      sku,
      `latest verdict is ${latest.overall} (publish_allowed=false)`,
      latest
    );
  }
  return latest;
}

/** Wrap any real publish action so it cannot run when blocked. */
export async function guardedPublish<T>(
  client: ComplianceClient,
  sku: string,
  publish: () => Promise<T>
): Promise<T> {
  await assertPublishAllowed(client, sku);
  return publish();
}
