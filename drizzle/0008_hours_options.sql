ALTER TABLE "clients" DROP CONSTRAINT "clients_package_fields";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "hours_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "hours_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "hours_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "hours_purchasable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The old single choice becomes the four flags: "internal" kept time for the team; "package" was
-- visible, had included hours, and was bought in the portal when an extra hour had a price.
UPDATE "clients" SET
  "hours_tracked" = "hours_mode" <> 'off',
  "hours_visible" = "hours_mode" = 'package',
  "hours_limited" = "hours_mode" = 'package',
  "hours_purchasable" = "hours_mode" = 'package' AND coalesce("extra_hour_cents", 0) > 0;--> statement-breakpoint
-- Support items of quotes get the same plan under "hours"; the legacy keys stay for the previous release.
UPDATE "quote_items" SET "config" = "config" || jsonb_build_object('hours', jsonb_build_object(
  'tracked', coalesce("config"->>'hoursMode', 'off') <> 'off',
  'visible', coalesce("config"->>'hoursMode', 'off') = 'package',
  'limited', coalesce("config"->>'hoursMode', 'off') = 'package',
  'includedMinutes', CASE WHEN coalesce("config"->>'hoursMode', 'off') = 'package' THEN coalesce(("config"->>'includedMinutes')::int, 0) ELSE 0 END,
  'extraHourCents', CASE WHEN coalesce("config"->>'hoursMode', 'off') = 'package' THEN "config"->'extraHourCents' ELSE 'null'::jsonb END,
  'purchasable', coalesce("config"->>'hoursMode', 'off') = 'package' AND coalesce(("config"->>'extraHourCents')::int, 0) > 0
))
WHERE "kind" = 'support' AND NOT ("config" ? 'hours');
