import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "manager", "collaborator"]);
export const actorType = pgEnum("actor_type", ["agency", "client"]);
export const authTokenPurpose = pgEnum("auth_token_purpose", ["invite", "reset"]);
export const clientRole = pgEnum("client_role", ["admin", "collaborator"]);
export const collabScope = pgEnum("collab_scope", ["all", "assigned"]);
export const ticketType = pgEnum("ticket_type", ["single", "support"]);
export const ticketStatus = pgEnum("ticket_status", ["open", "closed"]);
export const hoursMode = pgEnum("hours_mode", ["off", "internal", "package"]);
export const quoteStatus = pgEnum("quote_status", ["draft", "sent", "accepted", "executed", "archived"]);
export const quoteItemKind = pgEnum("quote_item_kind", ["site_creation", "maintenance", "support"]);
export const chargeKind = pgEnum("charge_kind", ["one_time", "subscription"]);
export const chargeStatus = pgEnum("charge_status", ["pending", "paid", "active", "past_due", "canceled"]);
export const chargeSource = pgEnum("charge_source", ["ticket", "support", "hours", "quote", "none"]);
export const paymentProvider = pgEnum("payment_provider", ["stripe", "mercadopago"]);
export const oauthClientKind = pgEnum("oauth_client_kind", ["registered", "metadata_document"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Single-row table: one install holds exactly one instance. */
export const instance = pgTable(
  "instance",
  {
    id: integer("id").primaryKey().default(1),
    secretKey: text("secret_key").notNull(),
    appUrl: text("app_url"),
    createdAt: createdAt(),
  },
  (t) => [check("instance_single_row", sql`${t.id} = 1`)],
);

/** Single-row table: one install serves exactly one agency. */
export const agency = pgTable(
  "agency",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name").notNull(),
    logoFileId: uuid("logo_file_id"),
    currency: text("currency").notNull().default("BRL"),
    locale: text("locale").notNull().default("en"),
    // IANA zone of the hours cycles, "today" and server-rendered times (see src/lib/time-zone.ts).
    timeZone: text("time_zone").notNull().default("America/Sao_Paulo"),
    // How a client who can't get in reaches the agency, shown on the portal login; null = not set.
    supportEmail: text("support_email"),
    supportPhone: text("support_phone"),
    // Team visibility for collaborators (owner and manager always see everything).
    collabClientScope: collabScope("collab_client_scope").notNull().default("assigned"),
    collabTicketScope: collabScope("collab_ticket_scope").notNull().default("all"),
    collabSeesUnassigned: boolean("collab_sees_unassigned").notNull().default(true),
    // General round robin for new tickets.
    autoAssign: boolean("auto_assign").notNull().default(false),
    autoAssignLastUserId: uuid("auto_assign_last_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    // Last ticket number handed out (tickets are numbered per install).
    ticketCounter: integer("ticket_counter").notNull().default(0),
    // Preferred provider for new charges, used when it fits the charge; null means none.
    defaultPaymentProvider: paymentProvider("default_payment_provider"),
    createdAt: createdAt(),
  },
  (t) => [check("agency_single_row", sql`${t.id} = 1`)],
);

/** Agency team members. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Always stored lowercase (enforced by the check below).
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    role: userRole("role").notNull().default("collaborator"),
    locale: text("locale"),
    createdAt: createdAt(),
  },
  (t) => [check("users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    // sha256 hex of the cookie token
    tokenHash: text("token_hash").primaryKey(),
    userType: actorType("user_type").notNull(),
    userId: uuid("user_id").notNull(),
    clientId: uuid("client_id").references((): AnyPgColumn => clients.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    supportActive: boolean("support_active").notNull().default(false),
    supportMonthlyCents: integer("support_monthly_cents"),
    // Deprecated: written from the four hours flags (see legacyHoursMode) so the previous release
    // still reads a matching plan after a rollback, and never read. Drop it in the next release.
    hoursMode: hoursMode("hours_mode").notNull().default("off"),
    // The hours plan (see src/lib/hours-plan.ts): time is kept, the client sees it in the portal,
    // there are included hours per month, and the client can buy extra hours in the portal.
    hoursTracked: boolean("hours_tracked").notNull().default(false),
    hoursVisible: boolean("hours_visible").notNull().default(false),
    hoursLimited: boolean("hours_limited").notNull().default(false),
    hoursPurchasable: boolean("hours_purchasable").notNull().default(false),
    // Included minutes per month; 0 without included hours.
    includedMinutes: integer("included_minutes").notNull().default(0),
    // Price of one extra hour, in the agency currency; only kept with included hours.
    extraHourCents: integer("extra_hour_cents"),
    generalTicketsEnabled: boolean("general_tickets_enabled").notNull().default(false),
    autoAssign: boolean("auto_assign").notNull().default(false),
    autoAssignLastUserId: uuid("auto_assign_last_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    check("clients_support_monthly_nonnegative", sql`${t.supportMonthlyCents} >= 0`),
    check("clients_included_minutes_nonnegative", sql`${t.includedMinutes} >= 0`),
    check("clients_extra_hour_nonnegative", sql`${t.extraHourCents} >= 0`),
    check("clients_hours_need_support", sql`${t.supportActive} or ${t.hoursMode} = 'off'`),
    // The hours flags get their checks in the next release, with hours_mode gone: the previous
    // release still writes hours_mode alone, and those writes must keep passing after a rollback.
  ],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url"),
    notes: text("notes"),
    includedInSupport: boolean("included_in_support").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("sites_client_id_idx").on(t.clientId)],
);

/** Client portal people. Separate from `users`: the same email may exist in both. */
export const clientUsers = pgTable(
  "client_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Always stored lowercase (enforced by the check below).
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    locale: text("locale"),
    createdAt: createdAt(),
  },
  (t) => [check("client_users_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

/** Which companies a portal person belongs to, and their role in each. */
export const clientMemberships = pgTable(
  "client_memberships",
  {
    clientUserId: uuid("client_user_id")
      .notNull()
      .references(() => clientUsers.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    role: clientRole("role").notNull().default("collaborator"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.clientUserId, t.clientId] }),
    index("client_memberships_client_id_idx").on(t.clientId),
  ],
);

/** Team members responsible for a client. */
export const clientAssignments = pgTable(
  "client_assignments",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.userId] }),
    index("client_assignments_user_id_idx").on(t.userId),
  ],
);

/** Round-robin members. A null client_id means the agency-wide (general) rotation. */
export const autoAssignUsers = pgTable(
  "auto_assign_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auto_assign_users_client_user_idx")
      .on(t.clientId, t.userId)
      .where(sql`${t.clientId} is not null`),
    uniqueIndex("auto_assign_users_general_user_idx")
      .on(t.userId)
      .where(sql`${t.clientId} is null`),
  ],
);

export const authTokens = pgTable("auth_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  purpose: authTokenPurpose("purpose").notNull(),
  userType: actorType("user_type").notNull(),
  userId: uuid("user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    // Null means a general ticket (also what a ticket becomes when its site is deleted).
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    type: ticketType("type").notNull(),
    status: ticketStatus("status").notNull().default("open"),
    title: text("title").notNull(),
    valueCents: integer("value_cents"),
    // A project (a new site, say): the portal lists it under Projects, not among the tickets.
    isProject: boolean("is_project").notNull().default(false),
    // Quote item that created this ticket (set by quote execution); null when it was made by hand.
    quoteItemId: uuid("quote_item_id").references((): AnyPgColumn => quoteItems.id, { onDelete: "set null" }),
    createdByType: actorType("created_by_type").notNull(),
    createdById: uuid("created_by_id").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("tickets_number_idx").on(t.number),
    index("tickets_client_id_idx").on(t.clientId),
    index("tickets_site_id_idx").on(t.siteId),
    index("tickets_status_idx").on(t.status),
    index("tickets_quote_item_id_idx").on(t.quoteItemId),
    index("tickets_status_last_message_idx").on(t.status, t.lastMessageAt),
    check("tickets_closed_at_matches_status", sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
    check("tickets_value_nonnegative", sql`${t.valueCents} is null or ${t.valueCents} >= 0`),
    check("tickets_value_single_only", sql`${t.type} = 'single' or ${t.valueCents} is null`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // No foreign key on the author: the row must outlive a removed team member or portal person.
    authorType: actorType("author_type").notNull(),
    authorId: uuid("author_id").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editedByType: actorType("edited_by_type"),
    editedById: uuid("edited_by_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByType: actorType("deleted_by_type"),
    deletedById: uuid("deleted_by_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_ticket_created_idx").on(t.ticketId, t.createdAt),
    index("messages_reply_to_id_idx").on(t.replyToId),
  ],
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storageKey: text("storage_key").notNull().unique(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    uploadedByType: actorType("uploaded_by_type").notNull(),
    uploadedById: uuid("uploaded_by_id").notNull(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    // True for images embedded in a message body, false for plain attachments.
    inline: boolean("inline").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("files_ticket_id_idx").on(t.ticketId),
    index("files_message_id_idx").on(t.messageId),
    index("files_uploaded_by_idx").on(t.uploadedByType, t.uploadedById),
    check("files_message_needs_ticket", sql`${t.messageId} is null or ${t.ticketId} is not null`),
  ],
);

/** Team members responsible for a ticket. */
export const ticketAssignments = pgTable(
  "ticket_assignments",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.userId] }),
    index("ticket_assignments_user_id_idx").on(t.userId),
  ],
);

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#8f8f8f"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("labels_name_lower_idx").on(sql`lower(${t.name})`),
    check("labels_color_hex", sql`${t.color} ~ '^#[0-9a-f]{6}$'`),
  ],
);

export const ticketLabels = pgTable(
  "ticket_labels",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.labelId] }),
    index("ticket_labels_label_id_idx").on(t.labelId),
  ],
);

/** Per team member, when they last opened each ticket (drives the unread dot). */
export const ticketReads = pgTable(
  "ticket_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.ticketId] }),
    index("ticket_reads_ticket_id_idx").on(t.ticketId),
  ],
);

/** Per client portal login, when they last opened each ticket (drives the portal's unread count). */
export const clientTicketReads = pgTable(
  "client_ticket_reads",
  {
    clientUserId: uuid("client_user_id")
      .notNull()
      .references(() => clientUsers.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clientUserId, t.ticketId] }),
    index("client_ticket_reads_ticket_id_idx").on(t.ticketId),
  ],
);

/** Time logged on a ticket. Only entries on support tickets count against the monthly hours. */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    // Denormalised from the ticket so balances never need a join to find the company.
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    minutes: integer("minutes").notNull(),
    // A calendar day, kept as YYYY-MM-DD so it never shifts with the time zone.
    workedOn: date("worked_on", { mode: "string" }).notNull(),
    note: text("note"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_entries_client_worked_on_idx").on(t.clientId, t.workedOn),
    index("time_entries_ticket_id_idx").on(t.ticketId),
    check("time_entries_minutes_range", sql`${t.minutes} between 1 and 1440`),
  ],
);

/** Extra hours added to one monthly cycle ("YYYY-MM"). */
export const hourPurchases = pgTable(
  "hour_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    minutes: integer("minutes").notNull(),
    cycle: text("cycle").notNull(),
    priceCents: integer("price_cents"),
    // Bought from the portal and not paid yet: left out of the balance.
    pending: boolean("pending").notNull().default(false),
    note: text("note"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("hour_purchases_client_cycle_idx").on(t.clientId, t.cycle),
    check("hour_purchases_minutes_positive", sql`${t.minutes} > 0`),
    check("hour_purchases_cycle_format", sql`${t.cycle} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("hour_purchases_price_nonnegative", sql`${t.priceCents} >= 0`),
  ],
);

/** Shortcuts an item carries so executing the quote knows which sites to create or use. */
export type QuoteItemConfig = {
  siteId?: string;
  newSite?: { name: string; url?: string };
  siteIds?: string[];
  newSites?: { name: string; url?: string }[];
  /** A support item's hours plan (see src/lib/hours-plan.ts). Items saved before it only have the legacy keys. */
  hours?: {
    tracked: boolean;
    visible: boolean;
    limited: boolean;
    includedMinutes: number;
    extraHourCents: number | null;
    purchasable: boolean;
  };
  /** Legacy keys, still written alongside `hours` so the previous release reads the same plan. */
  hoursMode?: HoursMode;
  includedMinutes?: number;
  extraHourCents?: number | null;
};

/** One thing created (or changed) while executing a quote. */
export type QuoteLogEntry = {
  action: "client" | "clientUser" | "site" | "ticket" | "support";
  itemId: string | null;
  label: string;
  id: string;
  /** "linked": an existing login was only linked (no invite); "replaced": the support plan replaced an active one. */
  note?: "linked" | "replaced";
};

/** A proposal for an existing client (client_id) or a prospect (prospect_name). */
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    prospectName: text("prospect_name"),
    prospectEmail: text("prospect_email"),
    title: text("title").notNull(),
    notes: text("notes"),
    status: quoteStatus("status").notNull().default("draft"),
    // Public link secret; set once at creation.
    token: text("token").notNull().unique(),
    // Agency currency at creation time; later currency changes never rewrite the values.
    currency: text("currency").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionLog: jsonb("execution_log").$type<QuoteLogEntry[]>(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    // No trigger: the core sets it on every update.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quotes_status_idx").on(t.status), index("quotes_client_id_idx").on(t.clientId)],
);

export const quoteItems = pgTable(
  "quote_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    kind: quoteItemKind("kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // Derived from the kind when the quote is saved (support is monthly).
    monthly: boolean("monthly").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    config: jsonb("config").$type<QuoteItemConfig>().notNull().default({}),
    clientApproved: boolean("client_approved").notNull().default(false),
    executed: boolean("executed").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("quote_items_quote_position_idx").on(t.quoteId, t.position),
    check("quote_items_amount_nonnegative", sql`${t.amountCents} >= 0`),
  ],
);

/**
 * One amount to collect: a ticket, the support plan, extra hours, a quote or something free.
 * Kept when its source goes away (set null); the amount and currency are a snapshot at creation.
 */
export const charges = pgTable(
  "charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    source: chargeSource("source").notNull(),
    kind: chargeKind("kind").notNull(),
    status: chargeStatus("status").notNull().default("pending"),
    // Null is a manual record (marked as paid by hand).
    provider: paymentProvider("provider"),
    label: text("label").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    hourPurchaseId: uuid("hour_purchase_id").references(() => hourPurchases.id, { onDelete: "set null" }),
    quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    // Secret of the public payment link (/pay/[token]).
    payToken: text("pay_token").notNull().unique(),
    externalCheckoutId: text("external_checkout_id"),
    externalPaymentId: text("external_payment_id"),
    externalSubscriptionId: text("external_subscription_id"),
    documentFileId: uuid("document_file_id").references(() => files.id, { onDelete: "set null" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    // No trigger: the core sets it on every update.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live or paid charge per source. No CHECK requires quote_id for source = 'quote': the set
    // null foreign key clears it when the quote is deleted.
    uniqueIndex("charges_ticket_live_idx").on(t.ticketId).where(sql`${t.status} <> 'canceled'`),
    uniqueIndex("charges_hour_purchase_live_idx").on(t.hourPurchaseId).where(sql`${t.status} <> 'canceled'`),
    uniqueIndex("charges_quote_live_idx").on(t.quoteId).where(sql`${t.status} <> 'canceled'`),
    uniqueIndex("charges_support_live_idx")
      .on(t.clientId)
      .where(sql`${t.source} = 'support' and ${t.status} <> 'canceled'`),
    index("charges_client_created_idx").on(t.clientId, t.createdAt),
    index("charges_external_subscription_idx").on(t.externalSubscriptionId),
    index("charges_external_checkout_idx").on(t.externalCheckoutId),
    check("charges_amount_positive", sql`${t.amountCents} > 0`),
    // One direction only: a set null foreign key clears the id when the ticket or purchase is
    // deleted, so "source = 'ticket' needs ticket_id" would block those deletions (and a client's).
    check("charges_ticket_source", sql`${t.ticketId} is null or ${t.source} = 'ticket'`),
    check("charges_hours_source", sql`${t.hourPurchaseId} is null or ${t.source} = 'hours'`),
    check("charges_subscription_source", sql`${t.kind} = 'one_time' or ${t.source} in ('support', 'none')`),
  ],
);

/** Webhook events already handled, so a replayed delivery changes nothing. */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: paymentProvider("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payment_events_provider_event_idx").on(t.provider, t.eventId)],
);

// ------- AI connector login (OAuth) -------

/**
 * Apps that ask for access. `registered` = dynamic registration
 * (`/oauth/register`): the public client_id is the row id.
 * `metadata_document` = client ID metadata document: the client_id is the
 * document's https URL and the row caches what it said. Name and redirect
 * URIs are what the app itself said.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: oauthClientKind("kind").notNull(),
  clientId: text("client_id").notNull().unique(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  // Metadata documents only: until when the fetched copy is trusted.
  cacheExpiresAt: timestamp("cache_expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * One authorization given by a team member to an app, for one resource (the
 * install's `/mcp` URL when it was granted: changing the public address
 * leaves old connections unusable). Revoking sets `revokedAt`; its tokens stop
 * working on the next request. Goes away with the user.
 */
export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    createdAt: createdAt(),
    // Written at most once a minute, when a token is checked.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("oauth_connections_user_idx").on(t.userId)],
);

/**
 * Authorization code: born on "Authorize", valid 10 minutes, exchanged once.
 * Stored hashed. `connectionId` is the connection its exchange created;
 * replaying the code revokes it.
 */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    connectionId: uuid("connection_id").references(() => oauthConnections.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)],
);

/**
 * A connection's token pair: access (1 hour) and refresh (60 idle days),
 * stored hashed. Refreshing replaces the whole pair; the old row keeps
 * `replacedAt` so a replayed refresh token is recognised (and revokes the
 * connection) until it expires.
 */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => oauthConnections.id, { onDelete: "cascade" }),
    accessHash: text("access_hash").notNull().unique(),
    refreshHash: text("refresh_hash").notNull().unique(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_tokens_connection_idx").on(t.connectionId)],
);

export type User = typeof users.$inferSelect;
export type UserRole = User["role"];
export type Client = typeof clients.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type ClientUser = typeof clientUsers.$inferSelect;
export type ClientMembership = typeof clientMemberships.$inferSelect;
export type ClientRole = ClientMembership["role"];
export type CollabScope = (typeof collabScope.enumValues)[number];
export type Ticket = typeof tickets.$inferSelect;
export type TicketType = Ticket["type"];
export type TicketStatus = Ticket["status"];
export type Message = typeof messages.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type HoursMode = (typeof hoursMode.enumValues)[number];
export type TimeEntry = typeof timeEntries.$inferSelect;
export type HourPurchase = typeof hourPurchases.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type QuoteStatus = Quote["status"];
export type QuoteItem = typeof quoteItems.$inferSelect;
export type QuoteItemKind = QuoteItem["kind"];
export type Charge = typeof charges.$inferSelect;
export type ChargeKind = Charge["kind"];
export type ChargeStatus = Charge["status"];
export type ChargeSource = Charge["source"];
export type PaymentProvider = (typeof paymentProvider.enumValues)[number];
export type OAuthClientRow = typeof oauthClients.$inferSelect;
