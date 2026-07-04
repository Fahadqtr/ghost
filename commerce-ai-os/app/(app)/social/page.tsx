import { listSocialPosts } from "./actions";
import SocialClient from "./SocialClient";

export const dynamic = "force-dynamic";

export default async function SocialPage() {
  const { error, pending, recent, configured } = await listSocialPosts();
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <SocialClient pending={pending} recent={recent} configured={configured} />
      )}
    </div>
  );
}
