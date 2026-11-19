import "server-only";
import { eq } from "drizzle-orm";
import { clients, type Db, type HoursMode } from "@/lib/db";

/** A client's support plan as the support form and quote execution state it. */
export type SupportPlan = {
  supportActive: boolean;
  monthlyCents: number | null;
  /** Absent keeps the client's current value. */
  generalTickets?: boolean;
  hoursMode: HoursMode;
  includedMinutes: number;
  extraHourCents: number | null;
};

/**
 * Writes a support plan onto a client, with the normalization of the support form: without support
 * there is no monthly value, no general tickets and no hours; outside the package there is nothing
 * to include or charge. It does not check who may do it (the caller does) and does not touch the
 * sites. Meant to run inside the caller's transaction.
 */
export async function applySupportPlan(tx: Db, clientId: string, plan: SupportPlan): Promise<void> {
  const { supportActive } = plan;
  const hoursMode: HoursMode = supportActive ? plan.hoursMode : "off";
  const isPackage = hoursMode === "package";
  await tx
    .update(clients)
    .set({
      supportActive,
      supportMonthlyCents: supportActive ? plan.monthlyCents : null,
      ...(supportActive
        ? plan.generalTickets === undefined
          ? {}
          : { generalTicketsEnabled: plan.generalTickets }
        : { generalTicketsEnabled: false }),
      hoursMode,
      includedMinutes: isPackage ? plan.includedMinutes : 0,
      extraHourCents: isPackage ? plan.extraHourCents : null,
    })
    .where(eq(clients.id, clientId));
}
