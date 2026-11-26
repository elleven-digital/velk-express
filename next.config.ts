import type { NextConfig } from "next";
import { AUTHORIZE_PAGE_HEADERS } from "./src/lib/oauth/page-headers";

const nextConfig: NextConfig = {
  output: "standalone",
  // `next dev` only: other hosts allowed to load the dev scripts, e.g. this machine's address on the
  // local network to open the dev server from a phone (DEV_ALLOWED_ORIGINS=192.168.0.10,my-mac.local).
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  experimental: {
    // Server actions default to 1 MB; the logo upload allows 2 MB plus form overhead.
    // Ticket attachments never go through a server action: they use POST /api/upload,
    // which the proxy does not see, so proxyClientMaxBodySize does not apply to them.
    serverActions: { bodySizeLimit: "2100kb" },
  },
  async headers() {
    return [{ source: "/oauth/authorize", headers: AUTHORIZE_PAGE_HEADERS }];
  },
};

export default nextConfig;
