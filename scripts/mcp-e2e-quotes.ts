/**
 * Quote and charge checks of the connector's end-to-end run (loaded by
 * scripts/mcp-e2e.ts): the owner creates, edits, sends and charges a quote and
 * makes a free charge; a manager (made for the run) and the collaborator get
 * the panel's refusals, and nothing they ask for is written.
 */
import type { Ctx } from "./mcp-e2e";

export async function run({ restore, sql, call, data, sentence, check, section, collaborator, ownerToken, connect }: Ctx) {
  section("Quotes — owner");
  const [client] = await sql`insert into clients (name, email) values ('E2E — Ateliê Jacarandá', 'oi@jacaranda.test') returning id`;
  restore(() => sql`delete from clients where id = ${client.id}`);
  const [manager] = await sql`
    insert into users (name, email, role, locale) values ('E2E Manager', 'e2e-manager@velk.test', 'manager', 'en') returning id`;
  restore(() => sql`delete from users where id = ${manager.id}`);

  const created = data(
    await call(ownerToken, "create_quote", {
      title: "E2E — new website",
      client_id: client.id,
      items: [
        { kind: "site_creation", title: "Website", amount_cents: 450000, new_site: { name: "Jacarandá", url: "jacaranda.test" } },
        { kind: "support", title: "Support", amount_cents: 60000, hours_mode: "package", included_minutes_per_month: 120 },
      ],
    }),
  );
  const quoteId = created.quote?.id;
  // Charges keep their quote id (set null on delete): take them first.
  restore(() => sql`delete from quotes where id = ${quoteId}`);
  restore(() => sql`delete from charges where quote_id = ${quoteId} or client_id = ${client.id}`);
  const [row] = await sql`select status, currency from quotes where id = ${quoteId}`;
  const items = await sql`select kind, monthly, amount_cents, config from quote_items where quote_id = ${quoteId} order by position`;
  check(
    "create_quote writes a draft with its items in cents",
    row?.status === "draft" && items.length === 2 && items[0].amount_cents === 450000 && items[1].monthly === true,
    { row, items },
  );
  check(
    "the support item keeps its hour package",
    items[1]?.config?.hoursMode === "package" && items[1].config.includedMinutes === 120,
    items[1]?.config,
  );

  data(
    await call(ownerToken, "update_quote", {
      quote_id: quoteId,
      title: "E2E — new website",
      client_id: client.id,
      items: [{ kind: "site_creation", title: "Website", amount_cents: 480000, new_site: { name: "Jacarandá" } }],
    }),
  );
  const [edited] = await sql`select count(*)::int as n, sum(amount_cents)::int as cents from quote_items where quote_id = ${quoteId}`;
  check("update_quote replaces every item", edited.n === 1 && edited.cents === 480000, edited);

  const sent = data(await call(ownerToken, "send_quote", { quote_id: quoteId }));
  const [afterSend] = await sql`select status from quotes where id = ${quoteId}`;
  check(
    "send_quote marks it sent and says whether an e-mail went out",
    afterSend?.status === "sent" && typeof sent.email_sent === "boolean" && (sent.email_sent || typeof sent.notice === "string"),
    sent,
  );
  const listed = data(await call(ownerToken, "list_quotes", { status: "sent", client_id: client.id }));
  check("list_quotes filters by status and client", listed.quotes?.length === 1 && listed.quotes[0].id === quoteId, listed.quotes);

  section("Charges — owner");
  const quoteCharge = data(await call(ownerToken, "create_charge", { source: "quote", id: quoteId }));
  const [qc] = await sql`select source, amount_cents, provider, status from charges where id = ${quoteCharge.charge?.id}`;
  check(
    "create_charge charges the quote's one-time items, with the default provider (manual without keys)",
    qc?.source === "quote" && qc.amount_cents === 480000 && qc.status === "pending" && qc.provider === null,
    qc,
  );
  check("the answer carries the payment page", /\/pay\/[A-Za-z0-9_-]+$/.test(quoteCharge.charge?.pay_url ?? ""), quoteCharge.charge);

  const free = data(
    await call(ownerToken, "create_charge", { source: "none", client_id: client.id, label: "E2E — domain", amount_cents: 9000 }),
  );
  data(await call(ownerToken, "mark_charge_paid", { charge_id: free.charge?.id }));
  const [paid] = await sql`select status, paid_at from charges where id = ${free.charge?.id}`;
  check("mark_charge_paid settles the manual record", paid?.status === "paid" && paid.paid_at !== null, paid);

  section("Quotes and charges — manager");
  const managerToken = (await connect(manager.id)).access_token;
  const mQuotes = await call(managerToken, "list_quotes");
  check("a manager can't list quotes (owners only)", mQuotes.isError === true && sentence(mQuotes).includes("owners"), sentence(mQuotes));
  const mQuoteCharge = await call(managerToken, "get_charge", { charge_id: quoteCharge.charge?.id });
  check("a quote's charge doesn't exist for a manager", mQuoteCharge.isError === true && sentence(mQuoteCharge).includes("no longer exists"), sentence(mQuoteCharge));
  const mCreate = await call(managerToken, "create_charge", { source: "quote", id: quoteId });
  const [quoteCharges] = await sql`select count(*)::int as n from charges where quote_id = ${quoteId}`;
  check(
    "a manager can't charge a quote, and nothing is written",
    mCreate.isError === true && sentence(mCreate).includes("owners") && quoteCharges.n === 1,
    sentence(mCreate),
  );
  const mList = data(await call(managerToken, "list_charges", { client_id: client.id }));
  check(
    "list_charges as a manager shows the free charge only",
    mList.charges?.length === 1 && mList.charges[0].id === free.charge?.id,
    mList.charges?.map((c: { id: string }) => c.id),
  );
  const noProvider = await call(managerToken, "create_charge", {
    source: "none",
    client_id: client.id,
    label: "E2E — via Stripe",
    amount_cents: 1000,
    provider: "stripe",
  });
  const [viaStripe] = await sql`select count(*)::int as n from charges where label = 'E2E — via Stripe'`;
  check(
    "a provider that isn't turned on gets the panel's sentence",
    noProvider.isError === true && sentence(noProvider).includes("not available") && viaStripe.n === 0,
    sentence(noProvider),
  );

  section("Quotes and charges — collaborator");
  const collabToken = (await connect(collaborator.id)).access_token;
  const cQuote = await call(collabToken, "create_quote", {
    title: "E2E — collaborator quote",
    client_id: client.id,
    items: [{ kind: "site_creation", title: "Site", amount_cents: 1 }],
  });
  const [cQuotes] = await sql`select count(*)::int as n from quotes where title = 'E2E — collaborator quote'`;
  check("a collaborator can't create quotes", cQuote.isError === true && cQuotes.n === 0, sentence(cQuote));
  const cCharges = await call(collabToken, "list_charges");
  check("a collaborator can't see charges", cCharges.isError === true && sentence(cCharges).includes("owners and managers"), sentence(cCharges));
}
