import type { Client, HoursMode, QuoteItemConfig } from "@/lib/db/schema";

/**
 * A client's hours plan: whether time is kept, whether the client sees it in the portal, whether
 * there are included hours per month (with a balance), and whether the client can buy extra hours
 * in the portal. The balance is informative: nothing is ever blocked when it runs out.
 */
export type HoursPlan = {
  tracked: boolean;
  visible: boolean;
  limited: boolean;
  /** Included minutes per month; 0 without included hours. */
  includedMinutes: number;
  /** Price of one extra hour; null without included hours. */
  extraHourCents: number | null;
  purchasable: boolean;
};

export const NO_HOURS: HoursPlan = {
  tracked: false,
  visible: false,
  limited: false,
  includedMinutes: 0,
  extraHourCents: null,
  purchasable: false,
};

/**
 * The plan as it can be stored: no hours without support; nothing but tracking without it; no
 * included minutes or extra-hour price without included hours; buying in the portal only when the
 * client sees the hours, has included hours and an extra hour has a price.
 */
export function normalizeHoursPlan(plan: HoursPlan, supportActive = true): HoursPlan {
  if (!supportActive || !plan.tracked) return NO_HOURS;
  const limited = plan.limited;
  const extraHourCents = limited ? plan.extraHourCents : null;
  return {
    tracked: true,
    visible: plan.visible,
    limited,
    includedMinutes: limited ? plan.includedMinutes : 0,
    extraHourCents,
    purchasable: plan.purchasable && plan.visible && limited && (extraHourCents ?? 0) > 0,
  };
}

/** The old single choice that best matches a plan: what the previous release reads. */
export function legacyHoursMode(plan: HoursPlan): HoursMode {
  if (!plan.tracked) return "off";
  return plan.limited && plan.visible ? "package" : "internal";
}

/** A plan from the old single choice: the package was visible, and bought in the portal when priced. */
export function hoursPlanFromLegacy(
  mode: HoursMode | undefined,
  includedMinutes: number | undefined,
  extraHourCents: number | null | undefined,
): HoursPlan {
  if (mode === "internal") return { ...NO_HOURS, tracked: true };
  if (mode !== "package") return NO_HOURS;
  const extra = extraHourCents ?? null;
  return {
    tracked: true,
    visible: true,
    limited: true,
    includedMinutes: includedMinutes ?? 0,
    extraHourCents: extra,
    purchasable: (extra ?? 0) > 0,
  };
}

type HoursColumns = Pick<
  Client,
  "hoursTracked" | "hoursVisible" | "hoursLimited" | "hoursPurchasable" | "includedMinutes" | "extraHourCents"
>;

/** A client's stored plan. */
export function hoursPlanOf(client: HoursColumns): HoursPlan {
  return {
    tracked: client.hoursTracked,
    visible: client.hoursVisible,
    limited: client.hoursLimited,
    includedMinutes: client.includedMinutes,
    extraHourCents: client.extraHourCents,
    purchasable: client.hoursPurchasable,
  };
}

/** The client columns that store a (normalized) plan, the legacy mode included. */
export function hoursColumns(plan: HoursPlan): HoursColumns & { hoursMode: HoursMode } {
  return {
    hoursTracked: plan.tracked,
    hoursVisible: plan.visible,
    hoursLimited: plan.limited,
    hoursPurchasable: plan.purchasable,
    includedMinutes: plan.includedMinutes,
    extraHourCents: plan.extraHourCents,
    hoursMode: legacyHoursMode(plan),
  };
}

/** A quote item's plan; items saved before the plan existed only have the legacy keys. */
export function configHoursPlan(config: QuoteItemConfig): HoursPlan {
  if (config.hours) return config.hours;
  return hoursPlanFromLegacy(config.hoursMode, config.includedMinutes, config.extraHourCents);
}

/** The quote item config keys for a (normalized) plan, the legacy keys included. */
export function hoursConfig(plan: HoursPlan): Pick<QuoteItemConfig, "hours" | "hoursMode" | "includedMinutes" | "extraHourCents"> {
  return {
    hours: plan,
    hoursMode: legacyHoursMode(plan),
    includedMinutes: plan.includedMinutes,
    extraHourCents: plan.extraHourCents,
  };
}
