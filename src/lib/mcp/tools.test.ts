import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/en";
import { pt } from "@/lib/i18n/pt";

vi.mock("@/lib/mcp/context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mcp/context")>();
  return { ...real, actorForUser: vi.fn(), agencyLocale: vi.fn(async () => "en") };
});

const { actorForUser, agencyLocale } = await import("@/lib/mcp/context");
const { teamTool, refused } = await import("@/lib/mcp/tools");

const SCOPE = { userId: "u1", connectionId: "c1", clientId: "https://app.test/meta.json", clientName: "App", rateLimited: false };

function actor(role: "owner" | "manager" | "collaborator", locale: string | null = "en") {
  return {
    userType: "agency" as const,
    user: { id: "u1", role, name: "Ana", email: "ana@x.com", locale },
  } as never;
}

const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));

beforeEach(() => {
  handler.mockClear();
  vi.mocked(agencyLocale).mockResolvedValue("en");
});

describe("teamTool", () => {
  it("runs the handler for an allowed role", async () => {
    vi.mocked(actorForUser).mockResolvedValue(actor("manager"));
    const result = await teamTool(SCOPE, "x", "staff", handler)({});
    expect(result.content[0]).toEqual({ type: "text", text: "ran" });
  });

  it("gates by role exactly as the panel: staff and owner tools refuse collaborators", async () => {
    vi.mocked(actorForUser).mockResolvedValue(actor("collaborator"));
    const staff = await teamTool(SCOPE, "x", "staff", handler)({});
    expect(staff).toEqual({ isError: true, content: [{ type: "text", text: en.mcp.staffOnly }] });
    vi.mocked(actorForUser).mockResolvedValue(actor("manager"));
    const owner = await teamTool(SCOPE, "x", "owner", handler)({});
    expect(owner).toEqual({ isError: true, content: [{ type: "text", text: en.mcp.ownerOnly }] });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses in the person's language, falling back to the agency's", async () => {
    vi.mocked(actorForUser).mockResolvedValue(actor("collaborator", "pt"));
    expect((await teamTool(SCOPE, "x", "owner", handler)({})).content[0]).toEqual({ type: "text", text: pt.mcp.ownerOnly });
    vi.mocked(actorForUser).mockResolvedValue(actor("collaborator", null));
    vi.mocked(agencyLocale).mockResolvedValue("pt");
    expect((await teamTool(SCOPE, "x", "owner", handler)({})).content[0]).toEqual({ type: "text", text: pt.mcp.ownerOnly });
  });

  it("refuses a person no longer in the team", async () => {
    vi.mocked(actorForUser).mockResolvedValueOnce(null);
    expect(await teamTool(SCOPE, "x", "member", handler)({})).toEqual({
      isError: true,
      content: [{ type: "text", text: en.mcp.noAccess }],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers the limit sentence over the rate limit, without running", async () => {
    vi.mocked(actorForUser).mockResolvedValue(actor("owner"));
    const result = await teamTool({ ...SCOPE, rateLimited: true }, "x", "member", handler)({});
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: en.mcp.rateLimited }] });
    expect(handler).not.toHaveBeenCalled();
  });

  it("turns an unexpected error into the generic sentence and logs ids and the error's name only", async () => {
    vi.mocked(actorForUser).mockResolvedValue(actor("owner"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await teamTool(SCOPE, "x", "member", async () => {
      throw new Error("relation users: secret row data");
    })({});
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: en.mcp.failed }] });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret row data");
    expect(log.mock.calls[0][1]).toEqual({ userId: "u1", connectionId: "c1", clientId: SCOPE.clientId, tool: "x", error: "Error" });
    log.mockRestore();
  });

  it("answers the generic sentence when the person can't even be read", async () => {
    vi.mocked(actorForUser).mockRejectedValueOnce(new Error("connection refused"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await teamTool(SCOPE, "x", "member", handler)({})).toEqual({
      isError: true,
      content: [{ type: "text", text: en.mcp.failed }],
    });
    log.mockRestore();
  });
});

describe("refused", () => {
  it("answers the panel's sentence for the core's error key, in the person's language", () => {
    expect(refused(actor("owner"), "lastOwner", "team")).toEqual({
      isError: true,
      content: [{ type: "text", text: en.team.errors.lastOwner }],
    });
    expect(refused(actor("owner", "pt"), "labelTaken", "settings")).toEqual({
      isError: true,
      content: [{ type: "text", text: pt.settings.errors.labelTaken }],
    });
  });

  it("reads ticket sentences by default and falls back to the area's generic sentence", () => {
    expect(refused(actor("owner"), "closed").content[0]).toEqual({ type: "text", text: en.tickets.errors.closed });
    expect(refused(actor("owner"), "somethingNew", "settings").content[0]).toEqual({
      type: "text",
      text: en.settings.errors.generic,
    });
    expect(refused(actor("owner"), "constructor").content[0]).toEqual({ type: "text", text: en.tickets.errors.generic });
  });
});
