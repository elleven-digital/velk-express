CREATE TYPE "public"."ticket_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('single', 'support');--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#8f8f8f' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_color_hex" CHECK ("labels"."color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" "actor_type" NOT NULL,
	"author_id" uuid NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"reply_to_id" uuid,
	"edited_at" timestamp with time zone,
	"edited_by_type" "actor_type",
	"edited_by_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by_type" "actor_type",
	"deleted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_assignments" (
	"ticket_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_assignments_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_labels" (
	"ticket_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_labels_ticket_id_label_id_pk" PRIMARY KEY("ticket_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_reads" (
	"user_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_reads_user_id_ticket_id_pk" PRIMARY KEY("user_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"client_id" uuid NOT NULL,
	"site_id" uuid,
	"type" "ticket_type" NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"value_cents" integer,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_value_nonnegative" CHECK ("tickets"."value_cents" is null or "tickets"."value_cents" >= 0),
	CONSTRAINT "tickets_value_single_only" CHECK ("tickets"."type" = 'single' or "tickets"."value_cents" is null)
);
--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "ticket_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "inline" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reads" ADD CONSTRAINT "ticket_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reads" ADD CONSTRAINT "ticket_reads_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_name_lower_idx" ON "labels" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "messages_ticket_created_idx" ON "messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_assignments_user_id_idx" ON "ticket_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_labels_label_id_idx" ON "ticket_labels" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_idx" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_client_id_idx" ON "tickets" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "tickets_site_id_idx" ON "tickets" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_ticket_id_idx" ON "files" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "files_message_id_idx" ON "files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "files_uploaded_by_idx" ON "files" USING btree ("uploaded_by_type","uploaded_by_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_message_needs_ticket" CHECK ("files"."message_id" is null or "files"."ticket_id" is not null);