"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/lib/auth/guards";
import { addHourPurchase, deleteHourPurchase } from "@/lib/core/hours";
import { formValues } from "@/lib/form-values";
import { getUserDict } from "@/lib/i18n/server";
import type { ClientState } from "../../client-state";

/*
 * The client's Hours tab. The client id is bound on the page (`.bind(null, clientId)`); the core
 * checks again that the person is staff. Neither action redirects: the page keeps its `?cycle=`
 * and shows what changed after the refresh.
 */

const PURCHASE_KEYS = ["duration", "price", "note"] as const;

function refresh(clientId: string) {
  revalidatePath(`/admin/clients/${clientId}`, "layout");
}

async function errorText(code: string): Promise<string> {
  const { t } = await getUserDict();
  const known = t.hours.errors as Record<string, string>;
  return known[code] ?? t.hours.errors.generic;
}

export async function addPurchaseAction(clientId: string, _prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const res = await addHourPurchase(actor, clientId, {
    duration: String(formData.get("duration") ?? ""),
    cycle: String(formData.get("cycle") ?? ""),
    price: String(formData.get("price") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!res.ok) return { error: await errorText(res.error), values: formValues(formData, PURCHASE_KEYS) };
  refresh(clientId);
  return { ok: "1" };
}

export async function deletePurchaseAction(clientId: string, purchaseId: string): Promise<{ error?: string }> {
  const actor = await requireTeam(["owner", "manager"]);
  const res = await deleteHourPurchase(actor, clientId, purchaseId);
  if (!res.ok) {
    // a missing or pending purchase means the page is out of date
    refresh(clientId);
    return { error: await errorText(res.error) };
  }
  refresh(clientId);
  return {};
}
