CREATE TABLE "client_ticket_reads" (
	"client_user_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "client_ticket_reads_client_user_id_ticket_id_pk" PRIMARY KEY("client_user_id","ticket_id")
);
--> statement-breakpoint
ALTER TABLE "client_ticket_reads" ADD CONSTRAINT "client_ticket_reads_client_user_id_client_users_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_ticket_reads" ADD CONSTRAINT "client_ticket_reads_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_ticket_reads_ticket_id_idx" ON "client_ticket_reads" USING btree ("ticket_id");--> statement-breakpoint
-- Existing conversations start read: only what arrives after this update counts as unread.
INSERT INTO "client_ticket_reads" ("client_user_id", "ticket_id", "last_read_at")
SELECT cm."client_user_id", t."id", now()
FROM "client_memberships" cm JOIN "tickets" t ON t."client_id" = cm."client_id"
ON CONFLICT DO NOTHING;
