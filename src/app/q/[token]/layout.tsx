import { AgencyTimeZoneProvider } from "@/components/agency-time-zone";
import { getAgency } from "@/lib/agency";
import { DEFAULT_TIME_ZONE } from "@/lib/time-zone";

/** The public quote page shows its times in the agency's zone until the browser swaps in the visitor's. */
export default async function PublicQuoteLayout({ children }: { children: React.ReactNode }) {
  const agency = await getAgency();
  return <AgencyTimeZoneProvider timeZone={agency?.timeZone ?? DEFAULT_TIME_ZONE}>{children}</AgencyTimeZoneProvider>;
}
