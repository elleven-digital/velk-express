CREATE TYPE "public"."client_role" AS ENUM('admin', 'collaborator');--> statement-breakpoint
CREATE TYPE "public"."collab_scope" AS ENUM('all', 'assigned');--> statement-breakpoint
CREATE TABLE "auto_assign_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_assignments" (
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_assignments_client_id_user_id_pk" PRIMARY KEY("client_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "client_memberships" (
	"client_user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role" "client_role" DEFAULT 'collaborator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_memberships_client_user_id_client_id_pk" PRIMARY KEY("client_user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "client_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"locale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_users_email_unique" UNIQUE("email"),
	CONSTRAINT "client_users_email_lowercase" CHECK ("client_users"."email" = lower("client_users"."email"))
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"notes" text,
	"support_active" boolean DEFAULT false NOT NULL,
	"support_monthly_cents" integer,
	"general_tickets_enabled" boolean DEFAULT false NOT NULL,
	"auto_assign" boolean DEFAULT false NOT NULL,
	"auto_assign_last_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_support_monthly_nonnegative" CHECK ("clients"."support_monthly_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"notes" text,
	"included_in_support" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "collab_client_scope" "collab_scope" DEFAULT 'assigned' NOT NULL;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "collab_ticket_scope" "collab_scope" DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "collab_sees_unassigned" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "auto_assign" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agency" ADD COLUMN "auto_assign_last_user_id" uuid;--> statement-breakpoint
ALTER TABLE "auto_assign_users" ADD CONSTRAINT "auto_assign_users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_assign_users" ADD CONSTRAINT "auto_assign_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_assignments" ADD CONSTRAINT "client_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_memberships" ADD CONSTRAINT "client_memberships_client_user_id_client_users_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_memberships" ADD CONSTRAINT "client_memberships_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_auto_assign_last_user_id_users_id_fk" FOREIGN KEY ("auto_assign_last_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_assign_users_client_user_idx" ON "auto_assign_users" USING btree ("client_id","user_id") WHERE "auto_assign_users"."client_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_assign_users_general_user_idx" ON "auto_assign_users" USING btree ("user_id") WHERE "auto_assign_users"."client_id" is null;--> statement-breakpoint
CREATE INDEX "client_assignments_user_id_idx" ON "client_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "client_memberships_client_id_idx" ON "client_memberships" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "sites_client_id_idx" ON "sites" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "agency" ADD CONSTRAINT "agency_auto_assign_last_user_id_users_id_fk" FOREIGN KEY ("auto_assign_last_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;