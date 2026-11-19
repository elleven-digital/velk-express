import "server-only";
import { getUserDict } from "@/lib/i18n/server";

/** The text for a charge error code in the viewer's language; an unknown code is the generic one. */
export async function chargeErrorText(code: string): Promise<string> {
  const { t } = await getUserDict();
  const known = t.charges.errors as Record<string, string>;
  return known[code] ?? t.charges.errors.generic;
}
