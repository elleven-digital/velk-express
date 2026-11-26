import { eq } from "drizzle-orm";
import { getAgency } from "@/lib/agency";
import { db, files } from "@/lib/db";
import { getDict, isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { isPwaFile, pwaManifest, PWA_FILES } from "@/lib/pwa";
import { renderAppIcon } from "@/lib/pwa-icon";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Biggest logo read into memory for an icon (uploads are capped at 2 MB already). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The agency's logo bytes, or null without one (or when it can't be read). */
async function logoBytes(logoFileId: string | null): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!logoFileId) return null;
  try {
    const [file] = await db.select({ storageKey: files.storageKey, mime: files.mime }).from(files).where(eq(files.id, logoFileId));
    if (!file) return null;
    const object = await getStorage().get(file.storageKey);
    if (!object) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.stream) {
      total += chunk.length;
      if (total > MAX_LOGO_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), mime: file.mime };
  } catch {
    return null;
  }
}

/**
 * The installable apps' files: the portal's and the team's manifests and the app icons. Public on
 * purpose (browsers fetch them without the session); they show only the agency's name and logo,
 * which the login pages already show.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  if (!isPwaFile(file)) return new Response("Not found", { status: 404 });
  const agency = await getAgency();
  if (!agency) return new Response("Not found", { status: 404 });

  const entry = PWA_FILES[file];
  if (entry.kind === "manifest") {
    const locale = isLocale(agency.locale) ? agency.locale : DEFAULT_LOCALE;
    const t = await getDict(locale);
    const manifest = pwaManifest(entry.area, { name: agency.name, locale, logoFileId: agency.logoFileId }, t.auth.areaLabel);
    return new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }
  return renderAppIcon({ size: entry.size, maskable: entry.maskable, name: agency.name, logo: await logoBytes(agency.logoFileId) });
}
