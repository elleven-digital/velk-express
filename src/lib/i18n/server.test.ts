import { beforeEach, describe, expect, it, vi } from "vitest";

const store = { cookie: undefined as string | undefined, accept: null as string | null };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (store.cookie ? { value: store.cookie } : undefined) }),
  headers: async () => ({ get: () => store.accept }),
}));
vi.mock("@/lib/agency", () => ({ getAgency: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getPortalSession: vi.fn(), getTeamSession: vi.fn() }));

import { getAgency } from "@/lib/agency";
import { getPublicDict, getPublicLocale } from "./server";

const agencyWith = (locale: string) => ({ name: "Studio", logoFileId: null, locale, currency: "BRL", timeZone: "UTC" });

beforeEach(() => {
  store.cookie = undefined;
  store.accept = null;
  vi.mocked(getAgency).mockReset();
  vi.mocked(getAgency).mockResolvedValue(null);
});

describe("getPublicLocale", () => {
  it("falls back to en when nothing is given and there is no agency yet", async () => {
    expect(await getPublicLocale()).toBe("en");
  });

  it("falls back to the agency's language, after the cookie and the browser", async () => {
    vi.mocked(getAgency).mockResolvedValue(agencyWith("pt"));
    expect(await getPublicLocale()).toBe("pt");
    store.accept = "fr-FR,de;q=0.8";
    expect(await getPublicLocale()).toBe("pt");
    store.accept = "es-ES,es;q=0.9";
    expect(await getPublicLocale()).toBe("es");
    store.cookie = "en";
    expect(await getPublicLocale()).toBe("en");
  });

  it("falls back to en when the database can't be reached", async () => {
    vi.mocked(getAgency).mockRejectedValue(new Error("down"));
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
