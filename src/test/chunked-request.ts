/** A chunked body: no Content-Length, `count` chunks of `size` bytes, counting how many were pulled. */
export function chunkedRequest(url: string, size: number, count: number) {
  const pulled = { chunks: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.chunks === count) return controller.close();
      pulled.chunks += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      pulled.cancelled = true;
    },
  });
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { request, pulled };
}
