import "server-only";
import { eq } from "drizzle-orm";
import { clients, type Db } from "@/lib/db";
import { hoursColumns, normalizeHoursPlan, type HoursPlan } from "@/lib/hours-plan";

/** A client's support plan as the support form and quote execution state it. */
export type SupportPlan = {
  supportActive: boolean;
  monthlyCents: number | null;
  /** Absent keeps the client's current value. */
  generalTickets?: boolean;
  hours: HoursPlan;
};

/**
 * Writes a support plan onto a client, with the normalization of the support form: without support
 * there is no monthly value, no general tickets and no hours; the hours plan is normalized (see
 * normalizeHoursPlan). It does not check who may do it (the caller does) and does not touch the
 * sites. Meant to run inside the caller's transaction.
 */
export async function applySupportPlan(tx: Db, clientId: string, plan: SupportPlan): Promise<void> {
  const { supportActive } = plan;
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
      ...hoursColumns(normalizeHoursPlan(plan.hours, supportActive)),
    })
    .where(eq(clients.id, clientId));
}
