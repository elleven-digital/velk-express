ALTER TABLE "tickets" ADD COLUMN "is_project" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Tickets a quote made for building a site were projects all along.
UPDATE "tickets" SET "is_project" = true
WHERE "quote_item_id" IN (SELECT "id" FROM "quote_items" WHERE "kind" = 'site_creation');
