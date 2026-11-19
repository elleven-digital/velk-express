import { describe, expect, it } from "vitest";
import { canEditMessage, canModifyMessage, isOwnMessage, viewerOf, type MessageViewer } from "./message-rules";
import type { TicketActor } from "@/lib/core/tickets";

const owner: MessageViewer = { type: "agency", id: "o", role: "owner" };
const manager: MessageViewer = { type: "agency", id: "m", role: "manager" };
const collab: MessageViewer = { type: "agency", id: "c", role: "collaborator" };
const client: MessageViewer = { type: "client", id: "p" };

const by = (authorType: "agency" | "client", authorId: string, authorRole?: "owner" | "manager" | "collaborator" | null) => ({
  authorType,
  authorId,
  authorRole,
});

describe("message rules", () => {
  it("everyone edits and deletes their own", () => {
    expect(canModifyMessage(owner, by("agency", "o", "owner"))).toBe(true);
    expect(canModifyMessage(manager, by("agency", "m", "manager"))).toBe(true);
    expect(canModifyMessage(collab, by("agency", "c", "collaborator"))).toBe(true);
    expect(canModifyMessage(client, by("client", "p"))).toBe(true);
    expect(isOwnMessage(client, by("agency", "p"))).toBe(false);
  });

  it("the owner moderates managers and collaborators", () => {
    expect(canModifyMessage(owner, by("agency", "m", "manager"))).toBe(true);
    expect(canModifyMessage(owner, by("agency", "c", "collaborator"))).toBe(true);
  });

  it("a manager moderates collaborators and former members, not the owner or managers", () => {
    expect(canModifyMessage(manager, by("agency", "c", "collaborator"))).toBe(true);
    expect(canModifyMessage(manager, by("agency", "gone", null))).toBe(true);
    expect(canModifyMessage(manager, by("agency", "o", "owner"))).toBe(false);
    expect(canModifyMessage(manager, by("agency", "m2", "manager"))).toBe(false);
  });

  it("a collaborator only touches their own", () => {
    expect(canModifyMessage(collab, by("agency", "c2", "collaborator"))).toBe(false);
    expect(canModifyMessage(collab, by("agency", "m", "manager"))).toBe(false);
  });

  it("nobody on the team touches a client's message, and a client only their own", () => {
    for (const v of [owner, manager, collab]) expect(canModifyMessage(v, by("client", "p"))).toBe(false);
    expect(canModifyMessage(client, by("client", "p2"))).toBe(false);
    expect(canModifyMessage(client, by("agency", "o", "owner"))).toBe(false);
  });

  it("a deleted message cannot be edited", () => {
    expect(canEditMessage(owner, { ...by("agency", "o", "owner"), deletedAt: new Date() })).toBe(false);
    expect(canEditMessage(owner, { ...by("agency", "o", "owner"), deletedAt: null })).toBe(true);
  });

  it("viewerOf maps a session to a viewer", () => {
    const team = { userType: "agency", user: { id: "c", role: "collaborator" } } as unknown as TicketActor;
    const portal = { userType: "client", user: { id: "p" } } as unknown as TicketActor;
    expect(viewerOf(team)).toEqual(collab);
    expect(viewerOf(portal)).toEqual(client);
  });
});
