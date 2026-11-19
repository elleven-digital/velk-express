import { sql } from "drizzle-orm";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { db as appDb, agency, instance, users, type Db } from "@/lib/db";
import { ensureInstance } from "@/boot/instance";
import { normalizeAppUrl } from "@/lib/app-url";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { LOCALES, type Locale } from "@/lib/i18n";
import { fail, ok, type Result } from "./result";

export type InstallInput = {
  agencyName: string;
  ownerName: string;
  ownerEmail: string;
  password: string;
  currency: "BRL" | "USD" | "EUR";
  locale: Locale;
  appUrl: string;
};

const name = z.string().trim().min(1).max(120);

const schema = z.object({
  agencyName: name,
  ownerName: name,
  ownerEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().refine((p) => passwordProblem(p) === null),
  currency: z.enum(["BRL", "USD", "EUR"]),
  locale: z.enum(LOCALES),
  appUrl: z.string().transform((v, ctx) => {
    const url = normalizeAppUrl(v);
    if (!url) ctx.addIssue({ code: "custom", message: "invalid url" });
    return url as string;
  }),
});

function isConflict(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
}

/**
 * Creates the agency and its owner, once. Serialized with an advisory lock so
 * two simultaneous installs cannot both win; the loser gets "alreadyInstalled".
 */
export async function installAgency(
  input: InstallInput,
  db: Db = appDb,
): Promise<Result<{ ownerId: string }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const data = parsed.data;
  const passwordHash = await hashPassword(data.password);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('velk:install'))`);
      await ensureInstance(tx as unknown as Db);

      const existing = await tx.select({ id: agency.id }).from(agency);
      if (existing.length > 0) return fail("alreadyInstalled");

      await tx.insert(agency).values({ id: 1, name: data.agencyName, currency: data.currency, locale: data.locale });
      const [owner] = await tx
        .insert(users)
        .values({
          name: data.ownerName,
          email: data.ownerEmail,
          passwordHash,
          role: "owner",
          // locale stays null: the agency language applies until the user picks their own.
        })
        .returning({ id: users.id });
      // APP_URL, when set, is the source of truth and the row stays untouched.
      if (!getConfig().appUrl) await tx.update(instance).set({ appUrl: data.appUrl });
      return ok({ ownerId: owner.id });
    });
  } catch (err) {
    if (isConflict(err)) return fail("alreadyInstalled");
    throw err;
  }
}

let installed = false;

/** True once the agency row exists. Only `true` is cached: before install it re-checks. */
export async function isInstalled(): Promise<boolean> {
  if (installed) return true;
  const rows = await appDb.select({ id: agency.id }).from(agency).limit(1);
  installed = rows.length > 0;
  return installed;
}
