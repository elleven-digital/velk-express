import type { QuoteItemConfig, QuoteItemKind } from "@/lib/db/schema";
import { parseMoney } from "@/lib/format";

/**
 * What the quote builder posts in its hidden field: the typed values as the person left them (money
 * and hours are still text). This turns them into the input `saveQuote` takes, defensively: the
 * field is user-controlled, so anything off the shape is refused, never trusted.
 */

export type PayloadErrorCode =
  | "invalidPayload"
  | "required"
  | "quoteNeedsClient"
  | "invalidMoney"
  | "invalidHours"
  | "invalidExtraHour";

export type ParsedQuote = {
  clientId: string | null;
  prospectName?: string;
  prospectEmail?: string;
  title: string;
  notes?: string;
  items: { kind: QuoteItemKind; title: string; description?: string; amountCents: number; config: QuoteItemConfig }[];
};

/** `item` is the position of the offending item, when the error is in one, and `itemTitle` the title typed on it. */
export type PayloadResult = { ok: true; value: ParsedQuote } | { ok: false; error: PayloadErrorCode; item?: number; itemTitle?: string };

const MAX_PAYLOAD_CHARS = 500_000;
const MAX_ITEMS = 200;
const MAX_ROWS = 200;
/** The most minutes a support plan stores (the core refuses more). */
const MAX_INCLUDED_MINUTES = 100_000;
const KINDS: readonly QuoteItemKind[] = ["site_creation", "maintenance", "support"];
const HOURS_MODES = ["off", "internal", "package"] as const;

const bad = (error: PayloadErrorCode, item?: number, itemTitle?: string): PayloadResult =>
  item === undefined ? { ok: false, error } : { ok: false, error, item, itemTitle: itemTitle ?? "" };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Whole or decimal hours ("10", "7,5", "7.5") as minutes; empty is zero, anything else is null. */
function hoursToMinutes(raw: string): number | null {
  const value = raw.trim();
  if (!value) return 0;
  if (!/^\d{1,6}([.,]\d{1,4})?$/.test(value)) return null;
  const minutes = Math.round(Number(value.replace(",", ".")) * 60);
  return minutes > MAX_INCLUDED_MINUTES ? null : minutes;
}

type NewSite = { name: string; url?: string };

/** The filled "new site" rows; null when one has an address but no name. */
function newSiteRows(rows: unknown[]): NewSite[] | null {
  const out: NewSite[] = [];
  for (const row of rows.slice(0, MAX_ROWS)) {
    const name = isRecord(row) ? str(row.name).trim() : "";
    const url = isRecord(row) ? str(row.url).trim() : "";
    if (!name && !url) continue;
    if (!name) return null;
    out.push(url ? { name, url } : { name });
  }
  return out;
}

export function parseQuotePayload(raw: unknown): PayloadResult {
  if (typeof raw !== "string" || raw.length > MAX_PAYLOAD_CHARS) return bad("invalidPayload");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return bad("invalidPayload");
  }
  if (!isRecord(data) || !Array.isArray(data.items) || data.items.length > MAX_ITEMS) return bad("invalidPayload");
  if (data.mode !== "client" && data.mode !== "prospect") return bad("invalidPayload");
  const forClient = data.mode === "client";

  const clientId = str(data.clientId).trim();
  if (forClient && !clientId) return bad("quoteNeedsClient");

  const items: ParsedQuote["items"] = [];
  for (const [index, item] of data.items.entries()) {
    if (!isRecord(item)) return bad("invalidPayload");
    const kind = KINDS.find((k) => k === item.kind);
    if (!kind) return bad("invalidPayload");

    const amountText = str(item.amount).trim();
    const amountCents = amountText ? parseMoney(amountText) : 0;
    if (amountCents === null) return bad("invalidMoney", index, str(item.title).trim());

    const config: QuoteItemConfig = {};
    const name = str(item.newSiteName).trim();
    const url = str(item.newSiteUrl).trim();
    if (kind === "site_creation" || kind === "maintenance") {
      const siteId = forClient && kind === "maintenance" ? str(item.siteId).trim() : "";
      if (siteId) config.siteId = siteId;
      else if (name) config.newSite = url ? { name, url } : { name };
      else if (url) return bad("required", index, str(item.title).trim());
    } else {
      if (forClient && Array.isArray(item.siteIds)) {
        const ids = item.siteIds.filter((id): id is string => typeof id === "string" && id !== "");
        if (ids.length > 0) config.siteIds = ids.slice(0, MAX_ROWS);
      }
      const rows = newSiteRows(Array.isArray(item.newSites) ? item.newSites : []);
      if (!rows) return bad("required", index, str(item.title).trim());
      if (rows.length > 0) config.newSites = rows;

      const mode = HOURS_MODES.find((m) => m === item.hoursMode);
      if (!mode) return bad("invalidPayload");
      config.hoursMode = mode;
      config.includedMinutes = 0;
      config.extraHourCents = null;
      if (mode === "package") {
        const minutes = hoursToMinutes(str(item.includedHours));
        if (minutes === null) return bad("invalidHours", index, str(item.title).trim());
        const extraText = str(item.extraHourPrice).trim();
        const extra = extraText ? parseMoney(extraText) : null;
        if (extraText && extra === null) return bad("invalidExtraHour", index, str(item.title).trim());
        config.includedMinutes = minutes;
        config.extraHourCents = extra;
      }
    }

    items.push({
      kind,
      title: str(item.title),
      description: str(item.description) || undefined,
      amountCents,
      config,
    });
  }

  return {
    ok: true,
    value: {
      clientId: forClient ? clientId : null,
      prospectName: forClient ? undefined : str(data.prospectName) || undefined,
      prospectEmail: forClient ? undefined : str(data.prospectEmail) || undefined,
      title: str(data.title),
      notes: str(data.notes) || undefined,
      items,
    },
  };
}

/**
 * The text for a refused payload: the item-specific wording when the error names an item (its
 * number on the screen and its title), the plain one otherwise. `errors` is the dictionary's
 * `quotes.errors`; `generic` stands for a code it does not know.
 */
export function payloadErrorText(
  errors: Record<string, string>,
  result: { error: PayloadErrorCode; item?: number; itemTitle?: string },
  fmt: (template: string, vars: Record<string, string | number>) => string,
): string {
  const code = result.error === "invalidPayload" ? "generic" : result.error;
  if (result.item === undefined) return errors[code] ?? errors.generic;
  const vars = { n: result.item + 1, title: result.itemTitle?.trim() || "—" };
  if (code === "invalidMoney") return fmt(errors.invalidItemMoney, vars);
  const base = errors[code] ?? errors.generic;
  return `${fmt(errors.inItem, vars)} ${base}`;
}
