import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkedRequest } from "@/test/chunked-request";

vi.mock("@/lib/oauth/store", () => ({
  isKnownClient: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const store = await import("@/lib/oauth/store");
const { handleTokenRequest } = await import("@/lib/oauth/token-endpoint");

function post(body: string, type = "application/x-www-form-urlencoded") {
  return new Request("https://agency.test/oauth/token", {
    method: "POST",
    headers: { "Content-Type": type },
    body,
  });
}

const TOKENS = { accessToken: "vat_a", refreshToken: "vrt_r", expiresIn: 3600, scope: "velk" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.isKnownClient).mockResolvedValue(true);
  vi.mocked(store.exchangeAuthorizationCode).mockResolvedValue({ ok: true, tokens: TOKENS, connectionId: "c" });
  vi.mocked(store.refreshAccessToken).mockResolvedValue({ ok: true, tokens: TOKENS, connectionId: "c" });
});

describe("POST /oauth/token", () => {
  it("exchanges a code, with no-store", async () => {
    const response = await handleTokenRequest(
      post("grant_type=authorization_code&client_id=x&code=vac_c&redirect_uri=https%3A%2F%2Fa%2Fcb&code_verifier=v")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      access_token: "vat_a",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "vrt_r",
      scope: "velk",
    });
  });

  it("refreshes", async () => {
    const response = await handleTokenRequest(post("grant_type=refresh_token&client_id=x&refresh_token=vrt_r"));
    expect(response.status).toBe(200);
    expect(store.refreshAccessToken).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "vrt_r" }));
  });

  it("refuses JSON bodies, missing or repeated fields and other grants", async () => {
    const error = async (r: Response) => [r.status, (await r.json()).error];
    expect(await error(await handleTokenRequest(post("{}", "application/json")))).toEqual([400, "invalid_request"]);
    expect(await error(await handleTokenRequest(post("grant_type=authorization_code&client_id=x")))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(
      await error(await handleTokenRequest(post("grant_type=refresh_token&client_id=x&client_id=y&refresh_token=r")))
    ).toEqual([400, "invalid_request"]);
    expect(await error(await handleTokenRequest(post("grant_type=password&client_id=x")))).toEqual([
      400,
      "unsupported_grant_type",
    ]);
  });

  it("passes the given time to the store", async () => {
    const now = new Date("2026-11-21T12:00:00Z");
    await handleTokenRequest(post("grant_type=refresh_token&client_id=x&refresh_token=vrt_r"), now);
    expect(store.refreshAccessToken).toHaveBeenCalledWith(expect.objectContaining({ now }));
  });

  it("refuses a body over 16 KB", async () => {
    const response = await handleTokenRequest(post(`grant_type=refresh_token&client_id=x&refresh_token=${"r".repeat(17 * 1024)}`));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    expect(store.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("stops reading a chunked body past 16 KB", async () => {
    const { request, pulled } = chunkedRequest("https://agency.test/oauth/token", 1024, 1000);
    request.headers.set("Content-Type", "application/x-www-form-urlencoded");
    const response = await handleTokenRequest(request);
    expect(response.status).toBe(400);
    expect(pulled.cancelled).toBe(true);
    expect(pulled.chunks).toBeLessThan(30);
  });

  it("never fetches anything for an unknown app: invalid_client", async () => {
    vi.mocked(store.isKnownClient).mockResolvedValueOnce(false);
    const response = await handleTokenRequest(post("grant_type=refresh_token&client_id=x&refresh_token=vrt_r"));
    expect((await response.json()).error).toBe("invalid_client");
    expect(store.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("passes the store's refusal through, and hides unexpected errors as server_error", async () => {
    vi.mocked(store.refreshAccessToken).mockResolvedValueOnce({ ok: false, error: "invalid_grant" });
    expect((await (await handleTokenRequest(post("grant_type=refresh_token&client_id=x&refresh_token=r"))).json()).error).toBe(
      "invalid_grant"
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(store.refreshAccessToken).mockRejectedValueOnce(new TypeError("db said secret things"));
    const response = await handleTokenRequest(post("grant_type=refresh_token&client_id=x&refresh_token=r"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret things");
    log.mockRestore();
  });
});
