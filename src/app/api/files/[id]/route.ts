import { getPortalSession, getTeamSession } from "@/lib/auth/session";
import { serveFile } from "@/lib/core/file-serve";

export const dynamic = "force-dynamic";

/** Serves a stored file; the rules live in `serveFile`. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const download = new URL(req.url).searchParams.has("download");
  const [team, portal] = await Promise.all([getTeamSession(), getPortalSession()]);
  return serveFile(id, { download, viewers: { team, portal } });
}
