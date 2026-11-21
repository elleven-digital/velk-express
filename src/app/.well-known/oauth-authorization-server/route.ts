import { authorizationServerMetadata, metadataResponse } from "@/lib/oauth/metadata";

/** Authorization server metadata (RFC 8414), built from the public address on each request. */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return metadataResponse(request, await authorizationServerMetadata());
}

export async function OPTIONS(request: Request): Promise<Response> {
  return metadataResponse(request, {});
}
