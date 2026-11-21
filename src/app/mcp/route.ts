import { serveMcp } from "@/lib/mcp/http";

/** The connector address (MCP, Streamable HTTP). See `serveMcp`. */

export async function POST(request: Request): Promise<Response> {
  return serveMcp(request);
}

export async function GET(request: Request): Promise<Response> {
  return serveMcp(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return serveMcp(request);
}
