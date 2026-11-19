import { NextResponse, type NextRequest } from "next/server";
import { AREA_HEADER, areaFor } from "@/lib/area";
import { isInstalled } from "@/lib/core/install";

let warned = false;

/** Paths that stay reachable before the install: the install page, the health check, assets. */
function isOpenBeforeInstall(path: string): boolean {
  return (
    path === "/install" ||
    path.startsWith("/install/") ||
    path === "/api/health" ||
    path.startsWith("/_next/") ||
    path === "/favicon.ico" ||
    /\.[a-z0-9]+$/i.test(path)
  );
}

/** Cookie of the first builds, before team and portal sessions were split; it is only ever removed. */
export const LEGACY_SESSION_COOKIE = "vx_session";

export async function proxy(request: NextRequest) {
  const response = await route(request);
  if (request.cookies.has(LEGACY_SESSION_COOKIE)) response.cookies.delete(LEGACY_SESSION_COOKIE);
  return response;
}

async function route(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always overwrite the area header, so a client can never pick its own area.
  const headers = new Headers(request.headers);
  headers.set(AREA_HEADER, areaFor(pathname));
  const pass = () => NextResponse.next({ request: { headers } });

  let installed: boolean;
  try {
    installed = await isInstalled();
  } catch (err) {
    // The database is unreachable: let the request through so the page can
    // show its own error, and log it once instead of on every request.
    if (!warned) {
      warned = true;
      console.error("Install check failed; letting requests through:", err);
    }
    return pass();
  }
  warned = false;

  if (installed) {
    if (pathname === "/install" || pathname.startsWith("/install/")) {
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
    return pass();
  }

  if (isOpenBeforeInstall(pathname)) return pass();
  return NextResponse.redirect(new URL("/install", request.url));
}

export const config = {
  // /api/upload is excluded on purpose: when the proxy runs, Next clones and buffers the request
  // body in memory (10 MB by default, silently truncated past that), which would corrupt a
  // 25 MB attachment. The upload route authenticates the request itself.
  // /api/webhooks too: the providers sign the raw body, which must reach the route untouched, and
  // a provider's POST must never be redirected. The routes verify the signature themselves.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/upload(?:/|$)|api/webhooks(?:/|$)).*)"],
};
