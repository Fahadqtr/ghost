// TEMPORARY diagnostic — returns booleans + a length, never the secret value.
// Remove after confirming the service-role key is visible at runtime.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    hasServiceKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    keyLen: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").length,
    hasUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  });
}
