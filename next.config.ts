import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Server actions default to 1 MB; the logo upload allows 2 MB plus form overhead.
    // Ticket attachments never go through a server action: they use POST /api/upload,
    // which the proxy does not see, so proxyClientMaxBodySize does not apply to them.
    serverActions: { bodySizeLimit: "2100kb" },
  },
};

export default nextConfig;
