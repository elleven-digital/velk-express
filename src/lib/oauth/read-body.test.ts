import { describe, expect, it } from "vitest";
import { chunkedRequest } from "@/test/chunked-request";
import { readCappedBody } from "./read-body";

describe("readCappedBody", () => {
  it("reads a body up to the cap", async () => {
    const request = new Request("https://agency.test/x", { method: "POST", body: "hello" });
    expect(await readCappedBody(request, 5)).toBe("hello");
  });

  it("refuses a declared length past the cap without reading", async () => {
    const request = new Request("https://agency.test/x", {
      method: "POST",
      headers: { "Content-Length": "100" },
      body: "x",
    });
    expect(await readCappedBody(request, 10)).toBeNull();
  });

  it("stops reading a chunked body as soon as it passes the cap", async () => {
    const { request, pulled } = chunkedRequest("https://agency.test/x", 1024, 1000);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readCappedBody(request, 4 * 1024)).toBeNull();
    expect(pulled.cancelled).toBe(true);
    expect(pulled.chunks).toBeLessThan(10);
  });

  it("an empty body is an empty string", async () => {
    expect(await readCappedBody(new Request("https://agency.test/x", { method: "POST" }), 10)).toBe("");
  });
});
