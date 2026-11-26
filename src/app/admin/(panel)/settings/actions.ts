"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTeam } from "@/lib/auth/guards";
import { updateAutoAssign, updateCollabVisibility } from "@/lib/core/assignments";
import { createLabel, deleteLabel, updateLabel } from "@/lib/core/labels";
import {
  CURRENCIES,
  removeAgencyLogo,
  setAgencyLogo,
  updateAgency,
  updateDefaultPaymentProvider,
  updateSupportContact,
} from "@/lib/core/settings";
import { formValues, type FormValues } from "@/lib/form-values";
import { setAppUrl } from "@/lib/instance";
import { LOCALES } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { revokeConnection } from "@/lib/oauth/store";
import type { SettingsState } from "./settings-state";

const agencySchema = z.object({
  name: z.string().trim().min(1).max(120),
  currency: z.enum(CURRENCIES),
  locale: z.enum(LOCALES),
});

async function messages() {
  const { t } = await getUserDict();
  const known = t.settings.errors as Record<string, string>;
  return {
    t,
    error: (code: string, values?: FormValues): SettingsState => ({ error: known[code] ?? t.settings.errors.generic, ...(values ? { values } : {}) }),
  };
}

function done() {
  // The shell shows the agency's name and logo on every panel page.
  revalidatePath("/admin", "layout");
}

export async function saveAgencyAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const input = agencySchema.safeParse({
    name: String(formData.get("name") ?? ""),
    currency: String(formData.get("currency") ?? ""),
    locale: String(formData.get("locale") ?? ""),
  });
  const typed = formValues(formData, ["name", "currency", "locale", "timeZone"]);
  if (!input.success) return error("invalid", typed);
  // The core checks the zone against the runtime's list: a forged one is "invalidTimeZone".
  const res = await updateAgency(actor, { ...input.data, timeZone: String(formData.get("timeZone") ?? "") });
  if (!res.ok) return error(res.error, typed);
  done();
  return { ok: t.settings.saved };
}

/** The support e-mail and phone shown on the portal login; the portal login page reads them too. */
export async function saveSupportContactAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const typed = formValues(formData, ["supportEmail", "supportPhone"]);
  const res = await updateSupportContact(actor, {
    email: String(formData.get("supportEmail") ?? "").slice(0, 300),
    phone: String(formData.get("supportPhone") ?? "").slice(0, 100),
  });
  if (!res.ok) return error(res.error, typed);
  revalidatePath("/admin/settings");
  revalidatePath("/login");
  return { ok: t.settings.saved };
}

export async function uploadLogoAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return error("logoInvalid");
  const res = await setAgencyLogo(actor, file);
  if (!res.ok) return error(res.error === "invalid" ? "logoInvalid" : res.error);
  done();
  return { ok: t.settings.logoSaved };
}

export async function removeLogoAction(): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const res = await removeAgencyLogo(actor);
  if (!res.ok) return error(res.error);
  done();
  return { ok: t.settings.logoRemoved };
}

export async function saveAppUrlAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  await requireTeam(["owner"]);
  const { t, error } = await messages();
  const url = String(formData.get("appUrl") ?? "");
  const typed = formValues(formData, ["appUrl"]);
  if (url.length > 2048) return error("urlInvalid", typed);
  const res = await setAppUrl(url);
  if (!res.ok) return error(res.error === "invalid" ? "urlInvalid" : res.error, typed);
  done();
  return { ok: t.settings.saved };
}

export async function saveVisibilityAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const res = await updateCollabVisibility(actor, {
    clientScope: formData.get("clientScope") === "all" ? "all" : "assigned",
    ticketScope: formData.get("ticketScope") === "assigned" ? "assigned" : "all",
    seesUnassigned: formData.get("seesUnassigned") === "on",
  });
  if (!res.ok) return error(res.error, formValues(formData, ["clientScope", "ticketScope", "seesUnassigned"]));
  revalidatePath("/admin/settings");
  return { ok: t.settings.saved };
}

export async function saveAutoAssignAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const res = await updateAutoAssign(actor, {
    enabled: formData.get("enabled") === "on",
    userIds: formData.getAll("userIds").map(String),
  });
  if (!res.ok) return error(res.error);
  revalidatePath("/admin/settings");
  return { ok: t.settings.saved };
}

const labelsAllowed = ["owner", "manager"] as const;

/** Label errors the form can show; anything else reads as a generic failure. */
const labelError = (code: string) => (code === "invalid" ? "labelInvalid" : code);

export async function createLabelAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam([...labelsAllowed]);
  const { t, error } = await messages();
  const res = await createLabel(actor, {
    name: String(formData.get("name") ?? ""),
    color: String(formData.get("color") ?? ""),
  });
  if (!res.ok) return error(labelError(res.error), formValues(formData, ["name", "color"]));
  revalidatePath("/admin/settings");
  return { ok: t.settings.saved };
}

export async function updateLabelAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam([...labelsAllowed]);
  const { t, error } = await messages();
  const res = await updateLabel(actor, String(formData.get("labelId") ?? ""), {
    name: String(formData.get("name") ?? ""),
    color: String(formData.get("color") ?? ""),
  });
  if (!res.ok) return error(labelError(res.error), formValues(formData, ["name", "color"]));
  revalidatePath("/admin/settings");
  return { ok: t.settings.saved };
}

export async function deleteLabelAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam([...labelsAllowed]);
  const { error } = await messages();
  const res = await deleteLabel(actor, String(formData.get("labelId") ?? ""));
  if (!res.ok) return error(labelError(res.error));
  revalidatePath("/admin/settings");
  return null;
}

export async function saveDefaultProviderAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const value = String(formData.get("provider") ?? "");
  const provider = value === "stripe" || value === "mercadopago" ? value : null;
  const res = await updateDefaultPaymentProvider(actor, provider);
  if (!res.ok) return error(res.error, formValues(formData, ["provider"]));
  revalidatePath("/admin/settings");
  return { ok: t.settings.saved };
}

/**
 * Settings → AI connections → Revoke, open to every role. Only the person's
 * own connection: someone else's id (or a malformed one) changes nothing.
 * The app's tokens stop working on its next request.
 */
export async function revokeAiConnectionAction(connectionId: string): Promise<void> {
  const { user } = await requireTeam();
  await revokeConnection({ userId: user.id, connectionId: String(connectionId) });
  revalidatePath("/admin/settings");
}
