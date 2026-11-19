"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTeam } from "@/lib/auth/guards";
import { attachChargeDocument, cancelCharge, createCharge, markChargePaid, removeChargeDocument } from "@/lib/core/charges";
import { updateTicketValue } from "@/lib/core/tickets";
import { chargeErrorText } from "@/lib/charge-errors";
import { parseChargeForm, parseProviderField } from "@/lib/charge-form";
import { formValues } from "@/lib/form-values";
import { parseMoney } from "@/lib/format";
import { getUserDict } from "@/lib/i18n/server";
import type { ChargeState } from "./charge-state";

/*
 * Charge actions. The source is bound where the page renders (`.bind(null, source, id)`); the
 * viewer comes from the session and the cores decide who may do what (a quote's charge is the
 * owner's, collaborators never act). Every refusal comes back as translated text. A success
 * refreshes the whole panel: the charge shows on several screens.
 */

const FREE_KEYS = ["clientId", "label", "amount", "kind", "provider"] as const;
const SOURCES = ["ticket", "support", "hours", "quote"] as const;
type Source = (typeof SOURCES)[number];

function refresh() {
  revalidatePath("/admin", "layout");
}

/** "New charge": a charge with no source. Goes to the list on success. */
export async function createFreeChargeAction(_prev: ChargeState, formData: FormData): Promise<ChargeState> {
  const actor = await requireTeam(["owner", "manager"]);
  const values = formValues(formData, FREE_KEYS);
  const parsed = parseChargeForm({
    clientId: String(formData.get("clientId") ?? ""),
    label: String(formData.get("label") ?? ""),
    amount: String(formData.get("amount") ?? ""),
    kind: String(formData.get("kind") ?? ""),
    provider: String(formData.get("provider") ?? ""),
  });
  if (!parsed.ok) return { error: await chargeErrorText(parsed.error), values };
  const res = await createCharge(actor, {
    source: "none",
    clientId: parsed.value.clientId,
    label: parsed.value.label,
    amountCents: parsed.value.amountCents,
    kind: parsed.value.kind,
    provider: parsed.value.provider,
  });
  if (!res.ok) return { error: await chargeErrorText(res.error), values };
  refresh();
  redirect("/admin/charges?ok=1");
}

/**
 * "Create charge" for a ticket, the support plan (the id is the client's), an hour purchase or a
 * quote. A ticket's form also carries its agreed value (`amount`): it is saved first, and with the
 * "save" button (`intent=save`) nothing more happens.
 */
export async function createSourceChargeAction(
  source: Source,
  sourceId: string,
  _prev: ChargeState,
  formData: FormData,
): Promise<ChargeState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t } = await getUserDict();
  if (!SOURCES.includes(source)) return { error: await chargeErrorText("generic") };
  if (source === "ticket" && formData.has("amount")) {
    const raw = String(formData.get("amount") ?? "").trim();
    const cents = raw === "" ? null : parseMoney(raw);
    if (raw !== "" && cents === null) return { error: await chargeErrorText("invalidAmount"), values: formValues(formData, ["amount", "provider"]) };
    const saved = await updateTicketValue(actor, sourceId, cents === 0 ? null : cents);
    if (!saved.ok) return { error: await chargeErrorText(saved.error), values: formValues(formData, ["amount", "provider"]) };
    refresh();
    if (formData.get("intent") === "save") return { ok: t.charges.valueSaved };
  }
  const provider = parseProviderField(String(formData.get("provider") ?? ""));
  if (provider === undefined) return { error: await chargeErrorText("providerUnavailable") };
  const res = await createCharge(actor, { source, sourceId, provider });
  if (!res.ok) return { error: await chargeErrorText(res.error), values: formValues(formData, ["amount", "provider"]) };
  refresh();
  return { ok: t.charges.created };
}

export async function cancelChargeAction(chargeId: string): Promise<{ error?: string }> {
  const actor = await requireTeam(["owner", "manager"]);
  const res = await cancelCharge(actor, chargeId);
  // Whatever the answer, the page may be out of date.
  refresh();
  return res.ok ? {} : { error: await chargeErrorText(res.error) };
}

export async function markChargePaidAction(chargeId: string): Promise<{ error?: string }> {
  const actor = await requireTeam(["owner", "manager"]);
  const res = await markChargePaid(actor, chargeId);
  refresh();
  return res.ok ? {} : { error: await chargeErrorText(res.error) };
}

/** Attaches an uploaded fiscal document (the upload already stored it). */
export async function attachDocumentAction(chargeId: string, fileId: string): Promise<{ error?: string }> {
  const actor = await requireTeam(["owner", "manager"]);
  const res = await attachChargeDocument(actor, chargeId, fileId);
  if (res.ok) refresh();
  return res.ok ? {} : { error: await chargeErrorText(res.error) };
}

export async function removeDocumentAction(chargeId: string): Promise<{ error?: string }> {
  const actor = await requireTeam(["owner", "manager"]);
  const res = await removeChargeDocument(actor, chargeId);
  refresh();
  return res.ok ? {} : { error: await chargeErrorText(res.error) };
}
