import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getAppUrl } from "@/lib/app-url";
import type { TeamSession } from "@/lib/auth/session";
import { getConfig, type AppConfig } from "@/lib/config";
import { db as appDb, agency, files, type Db } from "@/lib/db";
import { LOCALES, type Locale } from "@/lib/i18n";
import { getProviders, type PaymentProvider, type ProviderName } from "@/lib/payments";
import { getStorage, newFileKey, storageStatus, type Storage } from "@/lib/storage";
import { canonicalTimeZone } from "@/lib/time-zone";
import { getLatestRelease, updateCheckEnabled, type Release } from "@/lib/update-check";
import { APP_VERSION } from "@/lib/version";
import { fail, ok, type Result } from "./result";

/** The agency's own settings and the read-only view of the installation. Owner only. */

export const CURRENCIES = ["BRL", "USD", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Test seams: the database and the file storage. */
type Deps = { db?: Db; storage?: Storage };

const isOwner = (actor: TeamSession) => actor.user.role === "owner";

const agencySchema = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.enum(CURRENCIES),
  locale: z.enum(LOCALES),
});

/**
 * The agency's name, currency, language and time zone (stored in the runtime's spelling). A zone
 * the runtime does not accept is "invalidTimeZone" and nothing is saved. A new zone moves only the
 * cycle boundaries from now on: time entries keep their day and purchases their cycle.
 */
export async function updateAgency(
  actor: TeamSession,
  input: { name: string; currency: Currency; locale: Locale; timeZone: string },
  deps: Deps = {},
): Promise<Result> {
  if (!isOwner(actor)) return fail("forbidden");
  const parsed = agencySchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const timeZone = canonicalTimeZone(input.timeZone);
  if (!timeZone) return fail("invalidTimeZone");
  const db = deps.db ?? appDb;
  await db
    .update(agency)
    .set({ ...parsed.data, timeZone })
    .where(eq(agency.id, 1));
  return ok();
}

/** The real image type from the first bytes: the declared type and the name are not trusted. */
function sniffImage(bytes: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

async function removeStored(storage: Storage, key: string | undefined): Promise<void> {
  if (!key) return;
  try {
    await storage.remove(key);
  } catch (err) {
    // An orphaned object is harmless; the database is already consistent.
    console.error("Could not remove a stored file:", err);
  }
}

/**
 * Sets the agency logo (PNG, JPEG or WebP, up to 2 MB). The new file is
 * stored first; the previous logo's row and object go once the agency points
 * at the new one.
 */
export async function setAgencyLogo(actor: TeamSession, file: File, deps: Deps = {}): Promise<Result<{ fileId: string }>> {
  if (!isOwner(actor)) return fail("forbidden");
  if (file.size <= 0 || file.size > MAX_LOGO_BYTES) return fail("invalid");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MAX_LOGO_BYTES) return fail("invalid");
  const mime = sniffImage(bytes);
  if (!mime) return fail("invalid");

  const db = deps.db ?? appDb;
  const storage = deps.storage ?? getStorage();
  const key = newFileKey("logos");
  await storage.put(key, bytes, mime);

  let previousKey: string | undefined;
  try {
    const fileId = await db.transaction(async (tx) => {
      const [current] = await tx.select({ logoFileId: agency.logoFileId }).from(agency).where(eq(agency.id, 1)).for("update");
      const [row] = await tx
        .insert(files)
        .values({
          storageKey: key,
          name: (file.name || "logo").slice(0, 255),
          mime,
          sizeBytes: bytes.length,
          uploadedByType: "agency",
          uploadedById: actor.user.id,
        })
        .returning({ id: files.id });
      await tx.update(agency).set({ logoFileId: row.id }).where(eq(agency.id, 1));
      if (current?.logoFileId) {
        const [old] = await tx.delete(files).where(eq(files.id, current.logoFileId)).returning({ storageKey: files.storageKey });
        previousKey = old?.storageKey;
      }
      return row.id;
    });
    await removeStored(storage, previousKey);
    return ok({ fileId });
  } catch (err) {
    await removeStored(storage, key);
    throw err;
  }
}

/** Removes the agency logo; fine when there is none. */
export async function removeAgencyLogo(actor: TeamSession, deps: Deps = {}): Promise<Result> {
  if (!isOwner(actor)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const storage = deps.storage ?? getStorage();
  const key = await db.transaction(async (tx) => {
    const [current] = await tx.select({ logoFileId: agency.logoFileId }).from(agency).where(eq(agency.id, 1)).for("update");
    if (!current?.logoFileId) return undefined;
    await tx.update(agency).set({ logoFileId: null }).where(eq(agency.id, 1));
    const [old] = await tx.delete(files).where(eq(files.id, current.logoFileId)).returning({ storageKey: files.storageKey });
    return old?.storageKey;
  });
  await removeStored(storage, key);
  return ok();
}

/** Which provider the agency prefers for new charges: an active one, or null for none. */
export async function updateDefaultPaymentProvider(
  actor: TeamSession,
  provider: ProviderName | null,
  deps: { db?: Db; providers?: PaymentProvider[] } = {},
): Promise<Result> {
  if (!isOwner(actor)) return fail("forbidden");
  if (provider !== null) {
    const active = (deps.providers ?? getProviders()).map((p) => p.name);
    if (!active.includes(provider)) return fail("providerUnavailable");
  }
  const db = deps.db ?? appDb;
  await db.update(agency).set({ defaultPaymentProvider: provider }).where(eq(agency.id, 1));
  return ok();
}

/** What the owner needs to wire a provider: never a key, only the names of the variables that turn it on. */
export type PaymentProviderView = {
  name: ProviderName;
  active: boolean;
  envVars: string[];
  webhookUrl: string;
  events: string[];
};

export type PaymentSettings = { providers: PaymentProviderView[]; defaultProvider: ProviderName | null };

const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];
const MERCADO_PAGO_TOPICS = ["payment", "subscription_preapproval", "subscription_authorized_payment"];

/** The Payments section's data. Owner only; it carries no secret, only which providers are on. */
export async function getPaymentSettings(
  actor: TeamSession,
  deps: { db?: Db; config?: AppConfig; appUrl?: string } = {},
): Promise<Result<PaymentSettings>> {
  if (!isOwner(actor)) return fail("forbidden");
  const db = deps.db ?? appDb;
  const config = deps.config ?? getConfig();
  const appUrl = deps.appUrl ?? (await getAppUrl().catch(() => ""));
  const [row] = await db.select({ provider: agency.defaultPaymentProvider }).from(agency).where(eq(agency.id, 1));
  return ok({
    providers: [
      {
        name: "stripe",
        active: config.stripe !== null,
        envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
        webhookUrl: `${appUrl}/api/webhooks/stripe`,
        events: STRIPE_EVENTS,
      },
      {
        name: "mercadopago",
        active: config.mercadoPago !== null,
        envVars: ["MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET"],
        webhookUrl: `${appUrl}/api/webhooks/mercadopago`,
        events: MERCADO_PAGO_TOPICS,
      },
    ],
    defaultProvider: row?.provider ?? null,
  });
}

export type InstallationStatus = {
  appUrl: string;
  appUrlLockedByEnv: boolean;
  /** How e-mail is sent, or null when it is off. */
  mail: "smtp" | "resend" | null;
  storage: { mode: "disk" | "s3"; writable: boolean };
  payments: { stripe: boolean; mercadoPago: boolean };
  version: string;
  latest: Release | null;
  updateCheck: boolean;
};

/** What this install runs on, for the settings page. Reads only; secrets never leave the server. */
export async function getInstallationStatus(): Promise<InstallationStatus> {
  const config = getConfig();
  const [storage, latest, appUrl] = await Promise.all([
    storageStatus(),
    getLatestRelease(),
    getAppUrl().catch(() => ""),
  ]);
  return {
    appUrl,
    appUrlLockedByEnv: config.appUrl !== null,
    mail: config.mail?.provider ?? null,
    storage,
    payments: { stripe: config.stripe !== null, mercadoPago: config.mercadoPago !== null },
    version: APP_VERSION,
    latest,
    updateCheck: updateCheckEnabled(),
  };
}
