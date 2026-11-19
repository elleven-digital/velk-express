import { beforeEach, describe, expect, it, vi } from "vitest";

const store = { cookie: undefined as string | undefined, accept: null as string | null };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (store.cookie ? { value: store.cookie } : undefined) }),
  headers: async () => ({ get: () => store.accept }),
}));
vi.mock("@/lib/agency", () => ({ getAgency: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getPortalSession: vi.fn(), getTeamSession: vi.fn() }));

import { getPublicDict, getPublicLocale } from "./server";

beforeEach(() => {
  store.cookie = undefined;
  store.accept = null;
});

describe("getPublicLocale", () => {
  it("falls back to en when nothing is given", async () => {
    expect(await getPublicLocale()).toBe("en");
  });

  it("uses the given fallback only when there is no cookie and no supported Accept-Language", async () => {
    expect(await getPublicLocale("pt")).toBe("pt");
    store.accept = "fr-FR,de;q=0.8";
    expect(await getPublicLocale("pt")).toBe("pt");
    store.accept = "es-ES,es;q=0.9";
    expect(await getPublicLocale("pt")).toBe("es");
    store.cookie = "en";
    expect(await getPublicLocale("pt")).toBe("en");
  });

  it("getPublicDict follows the same rules", async () => {
    expect((await getPublicDict("pt")).locale).toBe("pt");
    expect((await getPublicDict()).locale).toBe("en");
  });
});
