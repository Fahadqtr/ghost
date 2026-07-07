import { listSocialPosts } from "./actions";
import SocialClient from "./SocialClient";
import SocialInsights from "./SocialInsights";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // AI image restyle takes 20–40s (same as /staff)

export default async function SocialPage() {
  const { error, pending, recent, configured } = await listSocialPosts();
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <>
          <SocialClient pending={pending} recent={recent} configured={configured} />
          <SocialInsights configured={configured.instagram} />
        </>
      )}
    </div>
  );
}
