CREATE TYPE "public"."hours_mode" AS ENUM('off', 'internal', 'package');--> statement-breakpoint
CREATE TABLE "hour_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	"cycle" text NOT NULL,
	"price_cents" integer,
	"pending" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hour_purchases_minutes_positive" CHECK ("hour_purchases"."minutes" > 0),
	CONSTRAINT "hour_purchases_cycle_format" CHECK ("hour_purchases"."cycle" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "hour_purchases_price_nonnegative" CHECK ("hour_purchases"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	"worked_on" date NOT NULL,
	"note" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_minutes_range" CHECK ("time_entries"."minutes" between 1 and 1440)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "hours_mode" "hours_mode" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "included_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "extra_hour_cents" integer;--> statement-breakpoint
ALTER TABLE "hour_purchases" ADD CONSTRAINT "hour_purchases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_purchases" ADD CONSTRAINT "hour_purchases_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hour_purchases_client_cycle_idx" ON "hour_purchases" USING btree ("client_id","cycle");--> statement-breakpoint
CREATE INDEX "time_entries_client_worked_on_idx" ON "time_entries" USING btree ("client_id","worked_on");--> statement-breakpoint
CREATE INDEX "time_entries_ticket_id_idx" ON "time_entries" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "messages_reply_to_id_idx" ON "messages" USING btree ("reply_to_id");--> statement-breakpoint
CREATE INDEX "ticket_reads_ticket_id_idx" ON "ticket_reads" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_status_last_message_idx" ON "tickets" USING btree ("status","last_message_at");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_included_minutes_nonnegative" CHECK ("clients"."included_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_extra_hour_nonnegative" CHECK ("clients"."extra_hour_cents" >= 0);--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_closed_at_matches_status" CHECK (("tickets"."status" = 'closed') = ("tickets"."closed_at" is not null));