/**
 * Settings checks of the connector's end-to-end run (loaded by scripts/mcp-e2e.ts):
 * update_agency changes only what it is given, refuses an unknown time zone,
 * and is the owner's.
 */
import type { Ctx } from "./mcp-e2e";

export async function run({ restore, sql, call, data, sentence, check, section, collaborator, ownerToken, connect }: Ctx) {
  section("Settings — owner");
  const [before] = await sql`select name, currency, locale, time_zone from agency where id = 1`;
  restore(() => sql`update agency set time_zone = ${before.time_zone} where id = 1`);
  const zone = before.time_zone === "Europe/Lisbon" ? "America/Sao_Paulo" : "Europe/Lisbon";
  data(await call(ownerToken, "update_agency", { time_zone: zone }));
  const [after] = await sql`select name, currency, locale, time_zone from agency where id = 1`;
  check(
    "update_agency with only time_zone keeps the name, currency and language",
    after.time_zone === zone && after.name === before.name && after.currency === before.currency && after.locale === before.locale,
    after,
  );
  const bad = await call(ownerToken, "update_agency", { time_zone: "Mars/Base" });
  const [still] = await sql`select time_zone from agency where id = 1`;
  check("an unknown time zone gets the panel's sentence", bad.isError === true && sentence(bad) === "Pick a time zone from the list." && still.time_zone === zone, sentence(bad));

  section("Settings — collaborator");
  const collabToken = (await connect(collaborator.id)).access_token;
  const refused = await call(collabToken, "update_agency", { name: "E2E — not mine" });
  const [name] = await sql`select name from agency where id = 1`;
  check("a collaborator can't change the agency", refused.isError === true && name.name === before.name, sentence(refused));
}
