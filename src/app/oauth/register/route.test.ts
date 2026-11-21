import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkedRequest } from "@/test/chunked-request";

vi.mock("@/lib/oauth/store", () => ({ registerClient: vi.fn() }));

const store = await import("@/lib/oauth/store");
const { POST } = await import("./route");

const URL_ = "https://agency.test/oauth/register";
let ip = 0;

function post(body: BodyInit, headers: Record<string, string> = {}) {
  // A fresh address each time, so the per-address limit never gets in the way.
  ip += 1;
  return new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${ip}`, ...headers },
    body,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /oauth/register", () => {
  it("registers a client", async () => {
    vi.mocked(store.registerClient).mockResolvedValue({
      clientId: "vxc_1",
      name: "App",
      redirectUris: ["https://app.example/cb"],
    } as never);
    const res = await POST(post(JSON.stringify({ client_name: "App", redirect_uris: ["https://app.example/cb"] })));
    expect(res.status).toBe(201);
    expect((await res.json()).client_id).toBe("vxc_1");
  });

  it("stops reading a chunked body past the cap and refuses it", async () => {
    const { request, pulled } = chunkedRequest(URL_, 1024, 1000);
    request.headers.set("X-Forwarded-For", "198.51.100.7");
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
    expect(pulled.cancelled).toBe(true);
    expect(pulled.chunks).toBeLessThan(30);
    expect(store.registerClient).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    const res = await POST(post("{"));
    expect(res.status).toBe(400);
    expect(store.registerClient).not.toHaveBeenCalled();
  });
});
