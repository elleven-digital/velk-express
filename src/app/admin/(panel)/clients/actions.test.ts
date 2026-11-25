import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSupport = vi.fn<(...args: unknown[]) => Promise<{ ok: true; value: undefined }>>(async () => ({ ok: true, value: undefined }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireTeam: vi.fn(async () => ({ userType: "agency", user: { id: "u", role: "owner" } })) }));
vi.mock("@/lib/core/clients", () => ({
  addSite: vi.fn(),
  createClient: vi.fn(),
  deleteSite: vi.fn(),
  getClient: vi.fn(),
  updateClient: vi.fn(),
  updateSite: vi.fn(),
  updateSupport: (...args: unknown[]) => updateSupport(...args),
}));
vi.mock("@/lib/core/assignments", () => ({ setClientAssignees: vi.fn(), updateClientAutoAssign: vi.fn() }));
vi.mock("@/lib/core/portal-users", () => ({
  createPortalResetLink: vi.fn(),
  invitePortalUser: vi.fn(),
  removePortalUser: vi.fn(),
  resendPortalInvite: vi.fn(),
  setPortalRole: vi.fn(),
}));
vi.mock("@/lib/i18n/server", () => ({
  getUserDict: vi.fn(async () => ({
    t: { clients: { saved: "Saved", errors: { invalidHours: "HOURS", generic: "GENERIC", invalidMoney: "MONEY", invalidExtraHour: "EXTRA" } } },
  })),
}));

import { updateSupportAction } from "./actions";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>) {
  const f = new FormData();
  f.set("clientId", CLIENT_ID);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => updateSupport.mockClear());

describe("updateSupportAction", () => {
  it("the support action shows invalidHours above 100000 minutes", async () => {
    // 2000 hours = 120000 minutes, past the stored limit.
    const res = await updateSupportAction(null, form({ supportActive: "on", hoursTracked: "on", hoursLimited: "on", includedHours: "2000" }));
    expect(res?.error).toBe("HOURS");
    expect(updateSupport).not.toHaveBeenCalled();
  });

  it("still accepts the largest allowed amount", async () => {
    const res = await updateSupportAction(null, form({ supportActive: "on", hoursTracked: "on", hoursLimited: "on", includedHours: "1666" }));
    expect(res?.error).toBeUndefined();
    expect(updateSupport).toHaveBeenCalledTimes(1);
  });
});

describe("updateSupportAction hours options", () => {
  it("sends the ticked options and drops the included-hours fields without included hours", async () => {
    await updateSupportAction(
      null,
      form({ supportActive: "on", hoursTracked: "on", hoursVisible: "on", includedHours: "10", extraHourValue: "150" }),
    );
    expect((updateSupport.mock.calls[0][2] as { hours: Record<string, unknown> }).hours).toEqual({
      tracked: true,
      visible: true,
      limited: false,
      includedMinutes: 0,
      extraHourCents: null,
      purchasable: false,
    });
  });

  it("reads the included hours, the price and buying in the portal", async () => {
    await updateSupportAction(
      null,
      form({
        supportActive: "on",
        hoursTracked: "on",
        hoursVisible: "on",
        hoursLimited: "on",
        hoursPurchasable: "on",
        includedHours: "7,5",
        extraHourValue: "150",
      }),
    );
    expect((updateSupport.mock.calls[0][2] as { hours: Record<string, unknown> }).hours).toMatchObject({ limited: true, includedMinutes: 450, purchasable: true });
    expect((updateSupport.mock.calls[0][2] as { hours: { extraHourCents: number } }).hours.extraHourCents).toBeGreaterThan(0);
  });
});
