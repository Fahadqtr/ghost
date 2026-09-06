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

function supabaseStorageEnv(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

/** The TUS subset of the streaming ports, bound to one bucket. */
export type TusTransportPorts = Omit<StreamedAssemblyPorts, "readPart">;

export function makeTusPorts(bucket: string, contentType = "application/zip"): TusTransportPorts {
  const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");

  return {
    async tusCreate(objectPath: string, totalBytes: number): Promise<string | null> {
      const env = supabaseStorageEnv();
      if (!env) return null;
      try {
        const res = await fetch(`${env.url}/storage/v1/upload/resumable`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.key}`,
            apikey: env.key,
            "tus-resumable": "1.0.0",
            "upload-length": String(totalBytes),
            "x-upsert": "true",
            "upload-metadata": [
              `bucketName ${b64(bucket)}`,
              `objectName ${b64(objectPath)}`,
              `contentType ${b64(contentType)}`,
              `cacheControl ${b64("3600")}`,
            ].join(","),
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
            Authorization: `Bearer ${env.key}`,
            apikey: env.key,
            "tus-resumable": "1.0.0",
            "upload-offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
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
