import { asc } from "drizzle-orm";
import { getAgency } from "@/lib/agency";
import type { BuilderClient, BuilderSite } from "@/components/quote-builder";
import type { Currency } from "@/lib/core/settings";
import { clients, db, sites } from "@/lib/db";
import type { Dict } from "@/lib/i18n";

/** What the builder offers to pick: every client and every site (the owner sees all), and the agency's currency. */
export async function loadBuilderData(): Promise<{ clients: BuilderClient[]; sites: BuilderSite[]; currency: Currency }> {
  const [clientRows, siteRows, agency] = await Promise.all([
    db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name), asc(clients.id)),
    db.select({ id: sites.id, name: sites.name, clientId: sites.clientId }).from(sites).orderBy(asc(sites.name), asc(sites.id)),
    getAgency(),
  ]);
  return { clients: clientRows, sites: siteRows, currency: (agency?.currency ?? "BRL") as Currency };
}

/** The hours labels of the client support form, which the builder's support item reuses. */
export function hoursLabelsOf(t: Dict) {
  const c = t.clients;
  return {
    hoursMode: c.hoursMode,
    hoursTrack: c.hoursTrack,
    hoursTrackHint: c.hoursTrackHint,
    hoursVisible: c.hoursVisible,
    hoursVisibleHint: c.hoursVisibleHint,
    hoursLimit: c.hoursLimit,
    hoursLimitHint: c.hoursLimitHint,
    hoursPurchasable: c.hoursPurchasable,
    hoursPurchasableHint: c.hoursPurchasableHint,
    includedHours: c.includedHours,
    extraHourValue: c.extraHourValue,
    extraHourHint: c.extraHourHint,
  };
}
