import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import { agency, clients, labels, ticketLabels, users, type Client, type Db, type User } from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { LABEL_MAX } from "@/lib/labels";
import { updateCollabVisibility } from "./assignments";
import { removeAgencyLogo, updateAgency } from "./settings";
import { addTicketLabel, createLabel, deleteLabel, labelsByTicket, listLabels, removeTicketLabel, updateLabel } from "./labels";
import { createTicket } from "./tickets";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let owner: TeamSession;
let manager: TeamSession;
let collab: TeamSession;
let acme: Client;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

async function makeUser(name: string, role: User["role"]): Promise<User> {
  const [u] = await db.insert(users).values({ name, email: `${name.toLowerCase()}@x.com`, role }).returning();
  return u;
}

beforeEach(async () => {
  if (db) await db.$client.end();
  db = await resetTestDb();
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en", collabClientScope: "all" });
  owner = asTeam(await makeUser("Ana", "owner"));
  manager = asTeam(await makeUser("Beto", "manager"));
  collab = asTeam(await makeUser("Cy", "collaborator"));
  [acme] = await db.insert(clients).values({ name: "Acme", supportActive: true, generalTicketsEnabled: true }).returning();
});

afterAll(async () => {
  await db?.$client.end();
});

async function ticket() {
  const r = await createTicket(owner, { clientId: acme.id, type: "support", title: "T" }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value.ticketId;
}

async function mkLabel(name: string, color = "") {
  const r = await createLabel(manager, { name, color }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.value.labelId;
}

describe("label management", () => {
  it("is staff only", async () => {
    expect(await createLabel(collab, { name: "Urgent", color: "" }, { db })).toEqual({ ok: false, error: "forbidden" });
    const id = await mkLabel("Urgent");
    expect(await updateLabel(collab, id, { name: "x" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteLabel(collab, id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect((await createLabel(owner, { name: "Owner's", color: "blue" }, { db })).ok).toBe(true);
  });

  it("stores a lowercase hex, gray when empty", async () => {
    const a = await mkLabel("A", "#0A72EF");
    const b = await mkLabel("B", "");
    const rows = await db.select().from(labels);
    expect(rows.find((l) => l.id === a)?.color).toBe("#0a72ef");
    expect(rows.find((l) => l.id === b)?.color).toBe("#8f8f8f");
    expect(await createLabel(manager, { name: "C", color: "x" }, { db })).toEqual({ ok: false, error: "labelColorInvalid" });
    expect(await updateLabel(manager, a, { color: "red;" }, { db })).toEqual({ ok: false, error: "labelColorInvalid" });
    expect(await createLabel(manager, { name: "   ", color: "" }, { db })).toEqual({ ok: false, error: "invalid" });
  });

  it("keeps names unique, ignoring case and spacing", async () => {
    await mkLabel("Urgent");
    expect(await createLabel(manager, { name: " urgent ", color: "" }, { db })).toEqual({ ok: false, error: "labelTaken" });
    const other = await mkLabel("Other");
    expect(await updateLabel(manager, other, { name: "URGENT" }, { db })).toEqual({ ok: false, error: "labelTaken" });
    expect((await updateLabel(manager, other, { name: "Other", color: "green" }, { db })).ok).toBe(true);
  });

  it("lets only one of two identical concurrent creates win", async () => {
    for (let i = 0; i < 10; i++) {
      const name = `Race ${i}`;
      const res = await Promise.allSettled([
        createLabel(manager, { name, color: "" }, { db }),
        createLabel(owner, { name, color: "" }, { db }),
      ]);
      for (const r of res) {
        if (r.status === "rejected") {
          const e = r.reason as { code?: string; cause?: { code?: string } };
          expect(e.code ?? e.cause?.code).not.toBe("40P01");
        }
      }
      const values = res.map((r) => (r.status === "fulfilled" ? r.value : null));
      expect(values.filter((v) => v?.ok).length).toBe(1);
      expect(values.filter((v) => v && !v.ok && v.error === "labelTaken").length).toBe(1);
    }
  });

  it("caps the count at LABEL_MAX", async () => {
    await db.insert(labels).values(Array.from({ length: LABEL_MAX }, (_, i) => ({ name: `L${i}` })));
    expect(await createLabel(manager, { name: "One more", color: "" }, { db })).toEqual({ ok: false, error: "labelLimit" });
  });

  it("deleting a label takes it off the tickets and counts usage", async () => {
    const t = await ticket();
    const id = await mkLabel("Gone");
    await addTicketLabel(owner, t, id, { db });
    expect((await listLabels(db)).find((l) => l.id === id)?.tickets).toBe(1);
    expect((await deleteLabel(manager, id, { db })).ok).toBe(true);
    expect(await db.select().from(ticketLabels).where(eq(ticketLabels.ticketId, t))).toHaveLength(0);
    expect(await deleteLabel(manager, id, { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("applying labels", () => {
  it("a collaborator applies on a visible ticket, twice does not duplicate, and removes", async () => {
    const t = await ticket();
    const id = await mkLabel("Waiting");
    expect((await addTicketLabel(collab, t, id, { db })).ok).toBe(true);
    expect((await addTicketLabel(collab, t, id, { db })).ok).toBe(true);
    expect(await db.select().from(ticketLabels).where(eq(ticketLabels.ticketId, t))).toHaveLength(1);
    expect((await labelsByTicket([t], db)).get(t)?.map((l) => l.name)).toEqual(["Waiting"]);
    expect((await removeTicketLabel(collab, t, id, { db })).ok).toBe(true);
    expect(await db.select().from(ticketLabels).where(eq(ticketLabels.ticketId, t))).toHaveLength(0);
    expect((await removeTicketLabel(collab, t, id, { db })).ok).toBe(true);
  });

  it("refuses a portal session", async () => {
    const t = await ticket();
    const id = await mkLabel("Internal");
    const portalActor = { userType: "client" } as unknown as TeamSession;
    expect(await addTicketLabel(portalActor, t, id, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await removeTicketLabel(portalActor, t, id, { db })).toEqual({ ok: false, error: "forbidden" });
  });

  it("is notFound outside the actor's scope and for unknown labels", async () => {
    const t = await ticket();
    const id = await mkLabel("Hidden");
    await updateCollabVisibility(owner, { clientScope: "all", ticketScope: "assigned", seesUnassigned: false }, { db });
    expect(await addTicketLabel(collab, t, id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await removeTicketLabel(collab, t, id, { db })).toEqual({ ok: false, error: "notFound" });
    expect(await addTicketLabel(owner, t, "00000000-0000-4000-8000-000000000000", { db })).toEqual({ ok: false, error: "notFound" });
    expect(await addTicketLabel(owner, t, "nope", { db })).toEqual({ ok: false, error: "notFound" });
  });
});

describe("settings stay owner-only now that managers open the page", () => {
  it("a manager calling an owner-only settings action is forbidden", async () => {
    expect(await updateAgency(manager, { name: "Hacked", currency: "USD", locale: "en" }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await updateCollabVisibility(manager, { clientScope: "all", ticketScope: "all", seesUnassigned: true }, { db })).toEqual({ ok: false, error: "forbidden" });
    expect(await removeAgencyLogo(manager, { db })).toEqual({ ok: false, error: "forbidden" });
    const [a] = await db.select().from(agency);
    expect(a.name).toBe("Studio Acme");
  });
});
