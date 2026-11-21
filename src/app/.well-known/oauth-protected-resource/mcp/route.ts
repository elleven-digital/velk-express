import { metadataResponse, protectedResourceMetadata } from "@/lib/oauth/metadata";

/** Protected resource metadata for /mcp (RFC 9728); the /mcp 401 points here. */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return metadataResponse(request, await protectedResourceMetadata());
}

export async function OPTIONS(request: Request): Promise<Response> {
  return metadataResponse(request, {});
}
