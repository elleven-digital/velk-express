import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { AUTHORIZE_PAGE_HEADERS } from "./page-headers";

describe("authorize page headers", () => {
  it("refuse framing of the consent page (RFC 9700 §4.16)", () => {
    const byKey = Object.fromEntries(AUTHORIZE_PAGE_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
  });

  it("are sent on /oauth/authorize by the app's config", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/oauth/authorize");
    expect(rule?.headers).toEqual(AUTHORIZE_PAGE_HEADERS);
  });
});
