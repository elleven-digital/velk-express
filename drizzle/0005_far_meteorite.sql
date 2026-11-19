CREATE TYPE "public"."charge_kind" AS ENUM('one_time', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."charge_source" AS ENUM('ticket', 'support', 'hours', 'quote', 'none');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('pending', 'paid', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stripe', 'mercadopago');--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"source" charge_source NOT NULL,
	"kind" charge_kind NOT NULL,
	"status" charge_status DEFAULT 'pending' NOT NULL,
	"provider" "payment_provider",
	"label" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"ticket_id" uuid,
	"hour_purchase_id" uuid,
	"quote_id" uuid,
	"pay_token" text NOT NULL,
	"external_checkout_id" text,
	"external_payment_id" text,
	"external_subscription_id" text,
	"document_file_id" uuid,
	"paid_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charges_pay_token_unique" UNIQUE("pay_token"),
	CONSTRAINT "charges_amount_positive" CHECK ("charges"."amount_cents" > 0),
	CONSTRAINT "charges_ticket_source" CHECK ("charges"."ticket_id" is null or "charges"."source" = 'ticket'),
	CONSTRAINT "charges_hours_source" CHECK ("charges"."hour_purchase_id" is null or "charges"."source" = 'hours'),
	CONSTRAINT "charges_subscription_source" CHECK ("charges"."kind" = 'one_time' or "charges"."source" in ('support', 'none'))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "default_payment_provider" "payment_provider";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "quote_item_id" uuid;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_hour_purchase_id_hour_purchases_id_fk" FOREIGN KEY ("hour_purchase_id") REFERENCES "public"."hour_purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_document_file_id_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_ticket_live_idx" ON "charges" USING btree ("ticket_id") WHERE "charges"."status" <> 'canceled';--> statement-breakpoint
CREATE UNIQUE INDEX "charges_hour_purchase_live_idx" ON "charges" USING btree ("hour_purchase_id") WHERE "charges"."status" <> 'canceled';--> statement-breakpoint
CREATE UNIQUE INDEX "charges_quote_live_idx" ON "charges" USING btree ("quote_id") WHERE "charges"."status" <> 'canceled';--> statement-breakpoint
CREATE UNIQUE INDEX "charges_support_live_idx" ON "charges" USING btree ("client_id") WHERE "charges"."source" = 'support' and "charges"."status" <> 'canceled';--> statement-breakpoint
CREATE INDEX "charges_client_created_idx" ON "charges" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "charges_external_subscription_idx" ON "charges" USING btree ("external_subscription_id");--> statement-breakpoint
CREATE INDEX "charges_external_checkout_idx" ON "charges" USING btree ("external_checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_idx" ON "payment_events" USING btree ("provider","event_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_quote_item_id_quote_items_id_fk" FOREIGN KEY ("quote_item_id") REFERENCES "public"."quote_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_quote_item_id_idx" ON "tickets" USING btree ("quote_item_id");--> statement-breakpoint
UPDATE "tickets" SET "quote_item_id" = (entry->>'itemId')::uuid
FROM "quotes", jsonb_array_elements("quotes"."execution_log") AS entry
WHERE "quotes"."status" = 'executed'
  AND entry->>'action' = 'ticket'
  AND entry->>'itemId' IS NOT NULL
  AND "tickets"."id" = (entry->>'id')::uuid
  AND EXISTS (SELECT 1 FROM "quote_items" WHERE "quote_items"."id" = (entry->>'itemId')::uuid);
