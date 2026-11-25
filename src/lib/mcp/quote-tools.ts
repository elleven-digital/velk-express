import "server-only";
import * as z from "zod";
import { getAppUrl } from "@/lib/app-url";
import type { TeamSession } from "@/lib/auth/session";
import { chargeFor } from "@/lib/core/charges";
import { archiveQuote, getQuote, listQuotes, QUOTES_PER_PAGE, saveQuote, sendQuote, type QuoteInput } from "@/lib/core/quotes";
import type { QuoteItemConfig } from "@/lib/db";
import { presentQuoteDetail, presentQuoteRow } from "@/lib/mcp/present-money";
import {
  dictFor,
  PEOPLE_TEXT,
  READ_ONLY,
  recordWrite,
  refused,
  teamTool,
  toolData,
  writeAnnotations,
  written,
  type ToolRegistrar,
} from "@/lib/mcp/tools";

/**
 * Quotes, the owner's as in the panel: list, read, create, edit (while draft
 * or sent), send (marks it sent and e-mails the client the public link) and
 * archive. Executing ("close and execute") and deleting stay in the panel.
 * Amounts are cents, as `saveQuote` takes them.
 */

export const QUOTE_TOOLS = ["list_quotes", "get_quote", "create_quote", "update_quote", "send_quote", "archive_quote"] as const;

const QUOTE_ID = z.string().describe("The quote id (from list_quotes).");
const STATUS = z.enum(["draft", "sent", "accepted", "executed", "archived"]);

const NEW_SITE = z.object({ name: z.string().min(1).max(200), url: z.string().max(500).optional() });

const ITEM = z.object({
  kind: z
    .enum(["site_creation", "maintenance", "support"])
    .describe(
      "site_creation: building a new site (one-time). maintenance: a job on an existing or new site (one-time). support: the monthly support plan (monthly).",
    ),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  amount_cents: z.number().int().min(0).describe("Price in cents of the agency's currency (monthly for support)."),
  new_site: NEW_SITE.optional().describe("site_creation, or maintenance on a site that doesn't exist yet."),
  site_id: z.string().optional().describe("maintenance on an existing site of the client (ids from get_client)."),
  site_ids: z.array(z.string()).max(50).optional().describe("support: the client's existing sites covered by the plan."),
  new_sites: z.array(NEW_SITE).max(20).optional().describe("support: sites to create and cover."),
  track_hours: z.boolean().optional().describe("support: keep the time spent (default false). The options below need it."),
  show_hours_to_client: z.boolean().optional().describe("support: the client sees the hours in the portal."),
  included_minutes_per_month: z
    .number()
    .int()
    .min(0)
    .max(100000)
    .nullable()
    .optional()
    .describe("support: included minutes per month, with a balance; null or left out for none. Informative: nothing is blocked."),
  extra_hour_cents: z.number().int().min(0).nullable().optional().describe("support, with included minutes: the price of one extra hour, in cents."),
  client_can_buy_hours: z
    .boolean()
    .optional()
    .describe("support: the client buys extra hours in the portal (needs show_hours_to_client, included minutes and an extra hour price)."),
});

type ItemArg = z.infer<typeof ITEM>;

/**
 * The tool's item into the builder's `QuoteItemConfig`, by kind, as the panel's
 * builder does (`parseQuotePayload`). Ids go through as given: the core refuses
 * a site that isn't the client's with the panel's sentence.
 */
export function itemConfig(item: ItemArg): QuoteItemConfig {
  const site = (s: { name: string; url?: string }) => {
    const url = s.url?.trim();
    return url ? { name: s.name.trim(), url } : { name: s.name.trim() };
  };
  if (item.kind === "site_creation") return item.new_site ? { newSite: site(item.new_site) } : {};
  if (item.kind === "maintenance") {
    if (item.site_id) return { siteId: item.site_id };
    return item.new_site ? { newSite: site(item.new_site) } : {};
  }
  const newSites = (item.new_sites ?? []).filter((s) => s.name.trim()).map(site);
  return {
    ...(item.site_ids?.length ? { siteIds: item.site_ids } : {}),
    ...(newSites.length ? { newSites } : {}),
    hours: {
      tracked: item.track_hours ?? false,
      visible: item.show_hours_to_client ?? false,
      limited: item.included_minutes_per_month != null,
      includedMinutes: item.included_minutes_per_month ?? 0,
      extraHourCents: item.extra_hour_cents ?? null,
      purchasable: item.client_can_buy_hours ?? false,
    },
  };
}

const QUOTE_FIELDS = {
  title: z.string().min(1).max(200),
  client_id: z.string().optional().describe("An existing client (from list_clients). Leave it out for a prospect."),
  prospect_name: z.string().max(200).optional().describe("The prospect's name, when there's no client yet."),
  prospect_email: z.string().max(254).optional(),
  notes: z.string().max(10000).optional().describe("Shown to the client on the quote's page."),
  items: z.array(ITEM).min(1).max(50),
};

type QuoteArgs = {
  quote_id?: string;
  title: string;
  client_id?: string;
  prospect_name?: string;
  prospect_email?: string;
  notes?: string;
  items: ItemArg[];
};

/** The tool's arguments into `saveQuote`'s input; `quote_id` (editing) goes inside, as the core takes it. */
export function quoteInput(args: QuoteArgs): QuoteInput {
  const clientId = args.client_id?.trim() || null;
  return {
    ...(args.quote_id ? { quoteId: args.quote_id } : {}),
    clientId,
    ...(clientId ? {} : { prospectName: args.prospect_name, prospectEmail: args.prospect_email }),
    title: args.title,
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
    items: args.items.map((item) => ({
      kind: item.kind,
      title: item.title,
      ...(item.description !== undefined ? { description: item.description } : {}),
      amountCents: item.amount_cents,
      config: itemConfig(item),
    })),
  };
}

/** The quote as its page shows it, with its charge; null when it is gone. */
async function quoteDetail(actor: TeamSession, quoteId: string) {
  const found = await getQuote(actor, quoteId);
  if (!found.ok) return found;
  const [charge, appUrl] = await Promise.all([chargeFor(actor, { source: "quote", sourceId: found.value.quote.id }), getAppUrl()]);
  return { ok: true as const, value: presentQuoteDetail(found.value, appUrl, charge.ok ? charge.value : null) };
}

export const registerQuoteTools: ToolRegistrar = (server, scope) => {
  server.registerTool(
    "list_quotes",
    {
      description:
        "Owners: the agency's quotes, newest first, in pages of 50 — status (draft, sent, accepted, executed, archived), client or prospect, totals (one-time and monthly, in cents) and dates. status and client_id filter the page asked for (total counts every quote; has_more says there is a next page)." +
        PEOPLE_TEXT,
      inputSchema: z.object({
        status: STATUS.optional(),
        client_id: z.string().optional(),
        page: z.number().int().min(1).optional().describe("Page number, from 1 (default)."),
      }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "list_quotes", "owner", async (actor, args) => {
      const page = args.page ?? 1;
      const res = await listQuotes(actor, {}, page);
      if (!res.ok) return refused(actor, res.error, "quotes");
      const appUrl = await getAppUrl();
      const rows = res.value.rows.filter(
        (r) => (!args.status || r.status === args.status) && (!args.client_id || r.clientId === args.client_id),
      );
      return toolData({
        quotes: rows.map((r) => presentQuoteRow(r, appUrl)),
        page,
        total: res.value.total,
        has_more: page * QUOTES_PER_PAGE < res.value.total,
      });
    }),
  );

  server.registerTool(
    "get_quote",
    {
      description:
        "Owners: one quote — status and dates, client or prospect, notes, items (kind, billing, price, sites, hours) with what the client approved and what was executed, totals, the client's sites, whether it can still be edited, the client's public link (once sent) and its charge." +
        PEOPLE_TEXT,
      inputSchema: z.object({ quote_id: QUOTE_ID }),
      annotations: READ_ONLY,
    },
    teamTool(scope, "get_quote", "owner", async (actor, args) => {
      const detail = await quoteDetail(actor, args.quote_id);
      if (!detail.ok) return refused(actor, detail.error, "quotes");
      return toolData({ quote: detail.value });
    }),
  );

  server.registerTool(
    "create_quote",
    {
      description:
        "Owners: creates a draft quote for a client (client_id) or a prospect (prospect_name, optional prospect_email), with at least one item, in the agency's currency. It isn't sent: use send_quote after the person reviews it.",
      inputSchema: z.object(QUOTE_FIELDS),
      annotations: writeAnnotations({ destructive: false }),
    },
    teamTool(scope, "create_quote", "owner", async (actor, args) => {
      const result = await saveQuote(actor, quoteInput(args));
      if (!result.ok) return refused(actor, result.error, "quotes");
      recordWrite(scope, actor, "create_quote");
      const detail = await quoteDetail(actor, result.value.id);
      return written({ quote: detail.ok ? detail.value : { id: result.value.id, status: "draft" } });
    }),
  );

  server.registerTool(
    "update_quote",
    {
      description:
        "Owners: replaces a quote's data and ALL its items (send the full list, as get_quote shows them). Only draft or sent quotes can be edited, as in the panel.",
      inputSchema: z.object({ quote_id: QUOTE_ID, ...QUOTE_FIELDS }),
      annotations: writeAnnotations({ destructive: false, idempotent: true }),
    },
    teamTool(scope, "update_quote", "owner", async (actor, args) => {
      const result = await saveQuote(actor, quoteInput(args));
      if (!result.ok) return refused(actor, result.error, "quotes");
      recordWrite(scope, actor, "update_quote");
      const detail = await quoteDetail(actor, result.value.id);
      return written({ quote: detail.ok ? detail.value : { id: result.value.id } });
    }),
  );

  server.registerTool(
    "send_quote",
    {
      description:
        "Owners: marks the quote as sent and e-mails the client (or prospect) the link to its page, where they approve it. Only draft or sent quotes (sending again re-sends the e-mail). The answer says whether an e-mail went out; when none did, the quote is sent all the same and public_url is the link to pass on. Only when the person asks.",
      inputSchema: z.object({ quote_id: QUOTE_ID }),
      annotations: writeAnnotations({ destructive: false, openWorld: true }),
    },
    teamTool(scope, "send_quote", "owner", async (actor, args) => {
      const result = await sendQuote(actor, args.quote_id);
      if (!result.ok) return refused(actor, result.error, "quotes");
      recordWrite(scope, actor, "send_quote");
      const detail = await quoteDetail(actor, args.quote_id);
      const quote = detail.ok ? detail.value : { id: args.quote_id, status: "sent" };
      const { emailedTo } = result.value;
      return written({
        quote,
        email_sent: emailedTo !== null,
        emailed_to: emailedTo,
        ...(emailedTo === null ? { notice: dictFor(actor).quotes.sentNoEmail } : {}),
      });
    }),
  );

  server.registerTool(
    "archive_quote",
    {
      description: "Owners: archives a quote that wasn't executed. Archiving an archived quote changes nothing (changed false).",
      inputSchema: z.object({ quote_id: QUOTE_ID }),
      annotations: writeAnnotations({ destructive: true, idempotent: true }),
    },
    teamTool(scope, "archive_quote", "owner", async (actor, args) => {
      const result = await archiveQuote(actor, args.quote_id);
      if (!result.ok) return refused(actor, result.error, "quotes");
      if (result.value.changed) recordWrite(scope, actor, "archive_quote");
      return written({ quote: { id: args.quote_id, status: "archived" }, changed: result.value.changed });
    }),
  );
};
