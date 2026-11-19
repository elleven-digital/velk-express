import { cookies } from "next/headers";
import { isStaff } from "@/lib/access";
import { PORTAL_COOKIE, TEAM_COOKIE, resolvePortalSession, resolveTeamSession } from "@/lib/auth/session";
import { maybeSweepOrphans } from "@/lib/core/file-cleanup";
import { receiveUpload, type Uploader } from "@/lib/core/uploads";

export const dynamic = "force-dynamic";

/**
 * Raw-body upload: the body is the file, `x-file-name` its name (URI-encoded),
 * `Content-Length` is required. This route is outside the proxy matcher on
 * purpose, so Next never buffers the body.
 *
 * CSRF: there is no token. A cross-site page cannot send this request with the user's session:
 * the cookies are SameSite=Lax (not sent on a cross-site POST), and the request needs the custom
 * `x-file-name` header, which makes a cross-origin call preflighted (and this app answers no
 * CORS preflight). Keep both true when changing cookies or adding CORS.
 *
 * The side comes from the page (`side=team|portal`), because one browser can
 * hold both sessions. Only that side's cookie is looked at.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const side = url.searchParams.get("side");

  let uploader: Uploader | null = null;
  if (side === "team") {
    const session = await resolveTeamSession((await cookies()).get(TEAM_COOKIE)?.value);
    if (session) uploader = { type: "agency", id: session.user.id, staff: isStaff(session.user) };
  } else if (side === "portal") {
    const session = await resolvePortalSession((await cookies()).get(PORTAL_COOKIE)?.value);
    if (session) uploader = { type: "client", id: session.user.id };
  }

  const result = await receiveUpload({
    uploader,
    purpose: url.searchParams.get("purpose"),
    fileName: request.headers.get("x-file-name"),
    contentLength: request.headers.get("content-length"),
    body: request.body,
  });
  // Opportunistic clean-up of abandoned uploads (at most hourly); never delays or fails the response.
  maybeSweepOrphans();
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
