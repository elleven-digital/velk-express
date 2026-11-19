import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDb } from "@/test/db";
import type { Db } from "@/lib/db/client";
import { agency, files, users, type User } from "@/lib/db";
import type { TeamSession } from "@/lib/auth/session";
import { diskStorage, type Storage } from "@/lib/storage";
import { readConfig } from "@/lib/config";
import { getProviders } from "@/lib/payments";
import { getPaymentSettings, removeAgencyLogo, setAgencyLogo, updateAgency, updateDefaultPaymentProvider } from "./settings";

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

let db: Db;
let storage: Storage;
let root: string;
let owner: TeamSession;
let collaborator: TeamSession;

const asTeam = (user: User): TeamSession => ({ userType: "agency", user });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

const pad = (head: Buffer, size = 64) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 1)]);
const upload = (bytes: Buffer, name = "logo.png", type = "image/png") => new File([new Uint8Array(bytes)], name, { type });
const deps = () => ({ db, storage });

beforeEach(async () => {
  if (db) await db.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
  db = await resetTestDb();
  root = await mkdtemp(path.join(tmpdir(), "velk-settings-"));
  storage = diskStorage(root);
  await db.insert(agency).values({ id: 1, name: "Studio Acme", currency: "BRL", locale: "en" });
  const [o] = await db.insert(users).values({ name: "Ana", email: "ana@x.com", role: "owner" }).returning();
  const [c] = await db.insert(users).values({ name: "Cy", email: "cy@x.com", role: "collaborator" }).returning();
  owner = asTeam(o);
  collaborator = asTeam(c);
});

afterAll(async () => {
  await db?.$client.end();
  if (root) await rm(root, { recursive: true, force: true });
});

const row = async () => (await db.select().from(agency))[0];

describe("updateAgency", () => {
  it("is forbidden for a collaborator and changes nothing", async () => {
    const res = await updateAgency(collaborator, { name: "Hacked", currency: "USD", locale: "pt", timeZone: "Asia/Tokyo" }, deps());
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(await row()).toMatchObject({ name: "Studio Acme", currency: "BRL", locale: "en", timeZone: "America/Sao_Paulo" });
  });

  it("saves a trimmed name, the currency, the language and the time zone for the owner", async () => {
    const res = await updateAgency(owner, { name: "  Nova Agencia ", currency: "EUR", locale: "es", timeZone: "Europe/Lisbon" }, deps());
    expect(res.ok).toBe(true);
    expect(await row()).toMatchObject({ name: "Nova Agencia", currency: "EUR", locale: "es", timeZone: "Europe/Lisbon" });
  });

  it("an existing agency starts in São Paulo", async () => {
    expect((await row()).timeZone).toBe("America/Sao_Paulo");
  });

  it("refuses a forged time zone with its own error and stores nothing", async () => {
    for (const timeZone of ["Mars/Base", "", "+03:00", "america/sao_paulo", "x".repeat(5000)]) {
      const res = await updateAgency(owner, { name: "Changed", currency: "EUR", locale: "es", timeZone }, deps());
      expect(res).toEqual({ ok: false, error: "invalidTimeZone" });
    }
    expect(await row()).toMatchObject({ name: "Studio Acme", currency: "BRL", timeZone: "America/Sao_Paulo" });
  });

  it("rejects an empty or too long name and unknown values", async () => {
    for (const input of [
      { name: "   ", currency: "BRL", locale: "en", timeZone: "UTC" },
      { name: "x".repeat(121), currency: "BRL", locale: "en", timeZone: "UTC" },
      { name: "Ok", currency: "JPY", locale: "en", timeZone: "UTC" },
      { name: "Ok", currency: "BRL", locale: "fr", timeZone: "UTC" },
    ]) {
      const res = await updateAgency(owner, input as never, deps());
      expect(res).toEqual({ ok: false, error: "invalid" });
    }
    expect((await row()).name).toBe("Studio Acme");
  });
});

describe("setAgencyLogo", () => {
  it("is forbidden for a collaborator", async () => {
    const res = await setAgencyLogo(collaborator, upload(pad(PNG)), deps());
    expect(res).toEqual({ ok: false, error: "forbidden" });
  });

  it("rejects a 3 MB logo as invalid and stores nothing", async () => {
    const res = await setAgencyLogo(owner, upload(pad(PNG, 3 * 1024 * 1024)), deps());
    expect(res).toEqual({ ok: false, error: "invalid" });
    expect(await db.select().from(files)).toHaveLength(0);
    expect((await row()).logoFileId).toBeNull();
  });

  it("rejects an empty file and a file that only claims to be an image", async () => {
    expect(await setAgencyLogo(owner, upload(Buffer.alloc(0)), deps())).toEqual({ ok: false, error: "invalid" });
    const fake = upload(Buffer.from("this is plain text, not a png"), "logo.png", "image/png");
    expect(await setAgencyLogo(owner, fake, deps())).toEqual({ ok: false, error: "invalid" });
    const svg = upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "logo.svg", "image/svg+xml");
    expect(await setAgencyLogo(owner, svg, deps())).toEqual({ ok: false, error: "invalid" });
    expect(await db.select().from(files)).toHaveLength(0);
  });

  it("stores a PNG, a JPEG and a WebP by their real bytes, whatever the declared type", async () => {
    const cases: [Buffer, string][] = [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ];
    for (const [head, mime] of cases) {
      const res = await setAgencyLogo(owner, upload(pad(head), "logo.bin", "application/octet-stream"), deps());
      expect(res.ok).toBe(true);
      const [f] = await db.select().from(files).where(eq(files.id, (await row()).logoFileId!));
      expect(f).toMatchObject({ mime, uploadedByType: "agency", uploadedById: owner.user.id });
      expect(f.storageKey.startsWith("logos/")).toBe(true);
      expect((await readFile(path.join(root, f.storageKey))).length).toBe(f.sizeBytes);
    }
  });

  it("replacing the logo removes the previous object and row", async () => {
    await setAgencyLogo(owner, upload(pad(PNG)), deps());
    const [first] = await db.select().from(files);
    await setAgencyLogo(owner, upload(pad(JPEG), "b.jpg", "image/jpeg"), deps());

    const all = await db.select().from(files);
    expect(all).toHaveLength(1);
    expect(all[0].id).not.toBe(first.id);
    expect((await row()).logoFileId).toBe(all[0].id);
    expect(await storage.get(first.storageKey)).toBeNull();
    expect(await storage.get(all[0].storageKey)).not.toBeNull();
  });

  it("removeAgencyLogo clears the logo, the row and the object; collaborators cannot", async () => {
    await setAgencyLogo(owner, upload(pad(PNG)), deps());
    const [f] = await db.select().from(files);

    expect(await removeAgencyLogo(collaborator, deps())).toEqual({ ok: false, error: "forbidden" });
    expect((await row()).logoFileId).toBe(f.id);

    expect((await removeAgencyLogo(owner, deps())).ok).toBe(true);
    expect((await row()).logoFileId).toBeNull();
    expect(await db.select().from(files)).toHaveLength(0);
    expect(await storage.get(f.storageKey)).toBeNull();
    expect((await removeAgencyLogo(owner, deps())).ok).toBe(true);
  });
});

const SECRETS = {
  STRIPE_SECRET_KEY: "sk_test_fake_secret_value_123",
  STRIPE_WEBHOOK_SECRET: "whsec_fake_secret_value_456",
  MERCADOPAGO_ACCESS_TOKEN: "TEST-fake-access-token-789",
  MERCADOPAGO_WEBHOOK_SECRET: "fake-mp-webhook-secret-abc",
};
const baseEnv = { DATABASE_URL: "postgres://x@localhost/x", APP_URL: "https://painel.acme.com" };
const configWith = (keys: Partial<typeof SECRETS>) => readConfig({ ...baseEnv, ...keys });
const stripeOnly = () => configWith({ STRIPE_SECRET_KEY: SECRETS.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: SECRETS.STRIPE_WEBHOOK_SECRET });
const both = () => configWith(SECRETS);
const providersOf = (config: ReturnType<typeof configWith>) => getProviders(config, { fetch: (async () => new Response("{}")) as typeof fetch });

describe("updateDefaultPaymentProvider", () => {
  it("only the owner sets the default provider, and only to an active one", async () => {
    const providers = providersOf(stripeOnly());
    const d = () => ({ db, providers });
    expect(await updateDefaultPaymentProvider(collaborator, "stripe", d())).toEqual({ ok: false, error: "forbidden" });
    expect((await row()).defaultPaymentProvider).toBeNull();

    expect(await updateDefaultPaymentProvider(owner, "mercadopago", d())).toEqual({ ok: false, error: "providerUnavailable" });
    expect(await updateDefaultPaymentProvider(owner, "paypal" as never, d())).toEqual({ ok: false, error: "providerUnavailable" });
    expect((await row()).defaultPaymentProvider).toBeNull();

    expect((await updateDefaultPaymentProvider(owner, "stripe", d())).ok).toBe(true);
    expect((await row()).defaultPaymentProvider).toBe("stripe");

    expect((await updateDefaultPaymentProvider(owner, null, d())).ok).toBe(true);
    expect((await row()).defaultPaymentProvider).toBeNull();

    // With no provider at all, only "none" is accepted.
    expect(await updateDefaultPaymentProvider(owner, "stripe", { db, providers: [] })).toEqual({ ok: false, error: "providerUnavailable" });
  });
});

describe("getPaymentSettings", () => {
  it("the settings view never contains a key", async () => {
    const res = await getPaymentSettings(owner, { db, config: both(), appUrl: "https://painel.acme.com" });
    expect(res.ok).toBe(true);
    const json = JSON.stringify(res);
    for (const secret of Object.values(SECRETS)) expect(json).not.toContain(secret);
    // It does name the variables that turn each provider on, and the webhook addresses.
    expect(json).toContain("STRIPE_SECRET_KEY");
    expect(json).toContain("MERCADOPAGO_WEBHOOK_SECRET");
    if (!res.ok) return;
    expect(res.value.providers.map((p) => [p.name, p.active, p.webhookUrl])).toEqual([
      ["stripe", true, "https://painel.acme.com/api/webhooks/stripe"],
      ["mercadopago", true, "https://painel.acme.com/api/webhooks/mercadopago"],
    ]);
    expect(res.value.providers[0].events).toContain("checkout.session.completed");
    expect(res.value.providers[1].events).toEqual(["payment", "subscription_preapproval", "subscription_authorized_payment"]);
  });

  it("reports inactive providers, the current default, and is owner only", async () => {
    await db.update(agency).set({ defaultPaymentProvider: "stripe" });
    const res = await getPaymentSettings(owner, { db, config: configWith({}), appUrl: "https://painel.acme.com" });
    expect(res.ok && res.value.providers.map((p) => p.active)).toEqual([false, false]);
    expect(res.ok && res.value.defaultProvider).toBe("stripe");
    expect(await getPaymentSettings(collaborator, { db, config: both(), appUrl: "x" })).toEqual({ ok: false, error: "forbidden" });
  });
});
