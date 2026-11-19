"use client";

import { createContext, useContext } from "react";
import { DEFAULT_TIME_ZONE } from "@/lib/time-zone";

const AgencyTimeZone = createContext<string>(DEFAULT_TIME_ZONE);

/** Hands the agency's time zone (read on the server) to the client components below it. */
export function AgencyTimeZoneProvider({ timeZone, children }: { timeZone: string; children: React.ReactNode }) {
  return <AgencyTimeZone.Provider value={timeZone}>{children}</AgencyTimeZone.Provider>;
}

/** The agency's time zone, or the default outside a provider. */
export function useAgencyTimeZone(): string {
  return useContext(AgencyTimeZone);
}
