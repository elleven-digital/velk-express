CREATE TYPE "public"."quote_item_kind" AS ENUM('site_creation', 'maintenance', 'support');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'sent', 'accepted', 'executed', 'archived');--> statement-breakpoint
CREATE TABLE "quote_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"kind" "quote_item_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"monthly" boolean NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_approved" boolean DEFAULT false NOT NULL,
	"executed" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quote_items_amount_nonnegative" CHECK ("quote_items"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"prospect_name" text,
	"prospect_email" text,
	"title" text NOT NULL,
	"notes" text,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"token" text NOT NULL,
	"currency" text NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"execution_log" jsonb,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_items_quote_position_idx" ON "quote_items" USING btree ("quote_id","position");--> statement-breakpoint
CREATE INDEX "quotes_status_idx" ON "quotes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quotes_client_id_idx" ON "quotes" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_hours_need_support" CHECK ("clients"."support_active" or "clients"."hours_mode" = 'off');--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_package_fields" CHECK ("clients"."hours_mode" = 'package' or ("clients"."included_minutes" = 0 and "clients"."extra_hour_cents" is null));