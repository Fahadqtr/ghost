// SUPABASE RESUMABLE (TUS) UPLOAD PORTS — one implementation, any bucket.
//
// STEP 90C. These three calls were written for the Rafeeq artifact object and
// were bound to its bucket by a constant. Email B's image package needs exactly
// the same three calls against a different bucket, so they are parameterised
// here rather than copied: two implementations of a resumable upload protocol
// would be two places for an off-by-one offset to hide.
//
// Service-role credentials are read from the environment at call time and never
// returned, logged, or embedded in anything this module produces.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { StreamedAssemblyPorts } from "@/lib/export/artifact-stream";
import {
  tusEndpoint, tusUploadHeaders, tusUploadMetadata, TUS_PATCH_CONTENT_TYPE,
} from "@/lib/storage/tus-protocol";

function supabaseStorageEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

/** The TUS subset of the streaming ports, bound to one bucket. */
export type TusTransportPorts = Omit<StreamedAssemblyPorts, "readPart">;

export function makeTusPorts(bucket: string, contentType = "application/zip"): TusTransportPorts {
  /**
   * STEP RAFEEQ 05 — the header set moved to lib/storage/tus-protocol.ts.
   *
   * It is unchanged for this caller: Authorization and apikey both carry the
   * service-role key, tus-resumable is 1.0.0, and x-upsert is on every request
   * (STEP 85J — Storage defers the duplicate check to the write, so creating
   * returned 201 while every PATCH came back 409). The reason it moved is that
   * the browser upload added in STEP RAFEEQ 03 wrote its own header set and
   * omitted Authorization entirely, which Storage answers with 403. One
   * contract, two sets of credentials.
   */
  const uploadHeaders = (key: string): Record<string, string> =>
    tusUploadHeaders({ authToken: key, apiKey: key });

  return {
    async tusCreate(objectPath: string, totalBytes: number): Promise<string | null> {
      const env = supabaseStorageEnv();
      if (!env) return null;
      try {
        const res = await fetch(tusEndpoint(env.url), {
          method: "POST",
          headers: {
            ...uploadHeaders(env.key),
            "upload-length": String(totalBytes),
            "upload-metadata": tusUploadMetadata({ bucket, objectPath, contentType }),
          },
        });
        if (res.status !== 201) return null;
        const location = res.headers.get("location");
        if (!location) return null;
        return location.startsWith("http") ? location : `${env.url}${location}`;
      } catch {
        return null;
      }
    },

    async tusPatch(uploadUrl: string, offset: number, chunk: Uint8Array): Promise<number | null> {
      const env = supabaseStorageEnv();
      if (!env) return null;
      try {
        const res = await fetch(uploadUrl, {
          method: "PATCH",
          headers: {
            ...uploadHeaders(env.key),
            "upload-offset": String(offset),
            "Content-Type": TUS_PATCH_CONTENT_TYPE,
          },
          body: new Uint8Array(chunk),
        });
        if (res.status !== 204) return null;
        const next = Number.parseInt(res.headers.get("upload-offset") ?? "", 10);
        return Number.isInteger(next) ? next : null;
      } catch {
        return null;
      }
    },

    /**
     * STEP 85G — how many bytes the server already holds for this upload.
     *
     * A TUS HEAD is the only authority on that: the caller's own idea of where
     * it stopped is exactly what a killed request loses. null means the
     * resource is gone or unreadable, and the caller must not treat a stored
     * upload URL as resumable on faith.
     */
    async tusOffset(uploadUrl: string): Promise<number | null> {
      const env = supabaseStorageEnv();
      if (!env) return null;
      try {
        const res = await fetch(uploadUrl, {
          method: "HEAD",
          headers: uploadHeaders(env.key),
        });
        if (res.status !== 200 && res.status !== 204) return null;
        const at = Number.parseInt(res.headers.get("upload-offset") ?? "", 10);
        return Number.isInteger(at) && at >= 0 ? at : null;
      } catch {
        return null;
      }
    },

    async statObject(objectPath: string): Promise<number | null> {
      const admin = createAdminClient();
      const dir = objectPath.slice(0, objectPath.lastIndexOf("/"));
      const name = objectPath.slice(objectPath.lastIndexOf("/") + 1);
      const { data, error } = await admin.storage.from(bucket).list(dir, { limit: 100 });
      if (error || !data) return null;
      const row = data.find((o: { name: string; metadata?: { size?: number } | null }) => o.name === name);
      const size = row?.metadata?.size;
      return typeof size === "number" ? size : null;
    },
  };
}
