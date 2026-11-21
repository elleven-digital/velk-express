import "server-only";

/**
 * Reads a request body as text, giving up as soon as it passes `maxBytes`.
 * The declared length is checked first, but a chunked body declares none, so
 * the stream is counted as it arrives and cancelled past the cap: an open
 * endpoint never holds more than `maxBytes` of a caller's body in memory.
 * Null means too large.
 */
export async function readCappedBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
