"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireTeam } from "@/lib/auth/guards";
import { setClientAssignees, updateClientAutoAssign } from "@/lib/core/assignments";
import {
  addSite,
  createClient,
  deleteSite,
  getClient,
  updateClient,
  updateSite,
  updateSupport,
} from "@/lib/core/clients";
import {
  createPortalResetLink,
  invitePortalUser,
  removePortalUser,
  resendPortalInvite,
  setPortalRole,
} from "@/lib/core/portal-users";
import type { LinkActionState } from "@/components/link-box";
import { formValues, type FormValues } from "@/lib/form-values";
import { parseMoney } from "@/lib/format";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import type { ClientState } from "./client-state";

const idSchema = z.object({ clientId: z.uuid() });
const siteIdSchema = idSchema.extend({ siteId: z.uuid() });

/** Text fields each form sends back with an error. */
const COMPANY_KEYS = ["name", "email", "phone", "notes"] as const;
const SITE_KEYS = ["name", "url", "notes", "includedInSupport"] as const;
const SUPPORT_KEYS = [
  "supportActive",
  "monthly",
  "generalTickets",
  "hoursTracked",
  "hoursVisible",
  "hoursLimited",
  "hoursPurchasable",
  "includedHours",
  "extraHourValue",
] as const;

async function messages() {
  const { t } = await getUserDict();
  const known = t.clients.errors as Record<string, string>;
  return {
    t,
    error: (code: string, values?: FormValues): ClientState => ({ error: known[code] ?? t.clients.errors.generic, ...(values ? { values } : {}) }),
  };
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");
const checked = (formData: FormData, key: string) => formData.get(key) === "on";

function companyFields(formData: FormData) {
  return { name: text(formData, "name"), email: text(formData, "email"), phone: text(formData, "phone"), notes: text(formData, "notes") };
}

function siteFields(formData: FormData) {
  return {
    name: text(formData, "name"),
    url: text(formData, "url"),
    notes: text(formData, "notes"),
    includedInSupport: checked(formData, "includedInSupport"),
  };
}

/** The pages under a client read the same data, so one refresh covers them all. */
function refresh() {
  revalidatePath("/admin/clients", "layout");
}

export async function createClientAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { error } = await messages();
  const res = await createClient(actor, companyFields(formData));
  if (!res.ok) return error(res.error, formValues(formData, COMPANY_KEYS));
  refresh();
  redirect(`/admin/clients/${res.value.clientId}`);
}

export async function updateClientAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = idSchema.safeParse({ clientId: text(formData, "clientId") });
  if (!ids.success) return error("notFound");
  const res = await updateClient(actor, ids.data.clientId, companyFields(formData));
  if (!res.ok) return error(res.error, formValues(formData, COMPANY_KEYS));
  refresh();
  return { ok: t.clients.saved };
}

/** The most minutes the plan stores (the core refuses more). */
const MAX_INCLUDED_MINUTES = 100_000;

/** Whole or decimal hours ("10", "7,5", "7.5") as minutes; empty is zero, anything else (or above the limit) is null. */
function hoursToMinutes(raw: string): number | null {
  const value = raw.trim();
  if (!value) return 0;
  if (!/^\d{1,6}([.,]\d{1,4})?$/.test(value)) return null;
  const minutes = Math.round(Number(value.replace(",", ".")) * 60);
  return minutes > MAX_INCLUDED_MINUTES ? null : minutes;
}

export async function updateSupportAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = idSchema.safeParse({ clientId: text(formData, "clientId") });
  if (!ids.success) return error("notFound");
  const rawMonthly = text(formData, "monthly").trim();
  const monthlyCents = rawMonthly ? parseMoney(rawMonthly) : null;
  // The ticked sites come back as one comma-joined value (ids hold no commas).
  const supportValues = () => ({ ...formValues(formData, SUPPORT_KEYS), siteIds: formData.getAll("siteIds").map(String).join(",") });
  if (rawMonthly && monthlyCents === null) return error("invalidMoney", supportValues());
  const tracked = checked(formData, "hoursTracked");
  const limited = tracked && checked(formData, "hoursLimited");
  // The included-hours fields only count with included hours; hidden leftovers elsewhere are ignored.
  const includedMinutes = limited ? hoursToMinutes(text(formData, "includedHours")) : 0;
  if (includedMinutes === null) return error("invalidHours", supportValues());
  const rawExtra = limited ? text(formData, "extraHourValue").trim() : "";
  const extraHourCents = rawExtra ? parseMoney(rawExtra) : null;
  if (rawExtra && extraHourCents === null) return error("invalidExtraHour", supportValues());
  const res = await updateSupport(actor, ids.data.clientId, {
    supportActive: checked(formData, "supportActive"),
    monthlyCents,
    generalTickets: checked(formData, "generalTickets"),
    siteIdsInPlan: formData.getAll("siteIds").map(String),
    hours: {
      tracked,
      visible: checked(formData, "hoursVisible"),
      limited,
      includedMinutes,
      extraHourCents,
      purchasable: checked(formData, "hoursPurchasable"),
    },
  });
  if (!res.ok) return error(res.error, supportValues());
  refresh();
  return { ok: t.clients.saved };
}

export async function addSiteAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = idSchema.safeParse({ clientId: text(formData, "clientId") });
  if (!ids.success) return error("notFound");
  const res = await addSite(actor, ids.data.clientId, siteFields(formData));
  if (!res.ok) return error(res.error, formValues(formData, SITE_KEYS));
  refresh();
  return { ok: t.clients.siteAdded };
}

export async function updateSiteAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = siteIdSchema.safeParse({ clientId: text(formData, "clientId"), siteId: text(formData, "siteId") });
  if (!ids.success) return error("notFound");
  const res = await updateSite(actor, ids.data.clientId, ids.data.siteId, siteFields(formData));
  if (!res.ok) return error(res.error, formValues(formData, SITE_KEYS));
  refresh();
  return { ok: t.clients.siteSaved };
}

export async function deleteSiteAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = siteIdSchema.safeParse({ clientId: text(formData, "clientId"), siteId: text(formData, "siteId") });
  if (!ids.success) return error("notFound");
  const res = await deleteSite(actor, ids.data.clientId, ids.data.siteId);
  if (!res.ok) return error(res.error);
  refresh();
  return { ok: t.clients.siteDeleted };
}

export async function setAssigneesAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = idSchema.safeParse({ clientId: text(formData, "clientId") });
  if (!ids.success) return error("notFound");
  const res = await setClientAssignees(actor, ids.data.clientId, formData.getAll("userIds").map(String));
  if (!res.ok) return error(res.error);
  refresh();
  return { ok: t.clients.saved };
}

export async function updateClientRotationAction(_prev: ClientState, formData: FormData): Promise<ClientState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await messages();
  const ids = idSchema.safeParse({ clientId: text(formData, "clientId") });
  if (!ids.success) return error("notFound");
  const res = await updateClientAutoAssign(actor, ids.data.clientId, {
    enabled: checked(formData, "enabled"),
    userIds: formData.getAll("userIds").map(String),
  });
  if (!res.ok) return error(res.error);
  refresh();
  return { ok: t.clients.saved };
}

/*
 * The client's Access tab. These take the client id as their first argument, bound by the page
 * (`action.bind(null, clientId)`), so the shared panel never chooses the company; the core
 * checks again that the team member may manage it.
 */

const personSchema = z.object({ clientUserId: z.uuid() });
const portalRoleSchema = z.enum(["admin", "collaborator"]);
const INVITE_KEYS = ["name", "email", "role"] as const;

async function portalMessages() {
  const { t } = await getUserDict();
  const known = t.portalUsers.errors as Record<string, string>;
  return {
    t,
    error: (code: string, values?: FormValues): LinkActionState => ({ error: known[code] ?? t.portalUsers.errors.generic, ...(values ? { values } : {}) }),
  };
}

export async function invitePortalUserAction(clientId: string, _prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await portalMessages();
  const role = portalRoleSchema.safeParse(text(formData, "role"));
  const typedValues = formValues(formData, INVITE_KEYS);
  if (!role.success) return error("invalid", typedValues);
  const confirmId = text(formData, "confirmLinkOf");
  const res = await invitePortalUser(actor, clientId, {
    name: text(formData, "name"),
    email: text(formData, "email"),
    role: role.data,
    // Only a confirm that names the login it was shown for counts (the core re-checks it under the lock).
    ...(confirmId ? { confirm: { clientUserId: confirmId, active: text(formData, "confirmActive") === "1", willBeAdmin: text(formData, "confirmWillBeAdmin") === "1" } } : {}),
  });
  if (!res.ok) return error(res.error, typedValues);
  const name = text(formData, "name").trim();
  if (res.value.outcome === "confirm" && res.value.existing) {
    const client = await getClient(actor, clientId);
    return {
      confirm: {
        clientUserId: res.value.clientUserId,
        active: res.value.existing.active,
        clientName: client.ok ? client.value.name : "",
        typed: { name, email: text(formData, "email").trim().toLowerCase(), role: role.data },
        name: res.value.existing.name,
        companies: res.value.existing.companies,
        willBeAdmin: res.value.existing.willBeAdmin,
      },
      // Back in the form if the team cancels the confirmation.
      values: typedValues,
    };
  }
  refresh();
  if (res.value.outcome === "linked") {
    return { ok: fmt(res.value.wasPending ? t.portalUsers.linkedPendingDone : t.portalUsers.linkedDone, { name }) };
  }
  if (!res.value.link) return { ok: fmt(t.portalUsers.inviteDone, { name }) };
  return {
    ok: fmt(t.portalUsers.inviteDone, { name }),
    link: { url: res.value.link, kind: "invite", name, email: text(formData, "email").trim().toLowerCase(), emailed: res.value.emailed },
  };
}

export async function resendPortalInviteAction(clientId: string, _prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await portalMessages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  if (!person.success) return error("notFound");
  const res = await resendPortalInvite(actor, clientId, person.data.clientUserId);
  if (!res.ok) return error(res.error);
  refresh();
  const name = text(formData, "name");
  return {
    ok: fmt(t.portalUsers.resendDone, { name }),
    link: { url: res.value.link, kind: "invite", name, email: text(formData, "email"), emailed: res.value.emailed },
  };
}

export async function createPortalResetLinkAction(clientId: string, _prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await portalMessages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  if (!person.success) return error("notFound");
  const res = await createPortalResetLink(actor, clientId, person.data.clientUserId);
  if (!res.ok) return error(res.error);
  const name = text(formData, "name");
  return {
    ok: fmt(t.portalUsers.resetDone, { name }),
    link: { url: res.value.link, kind: "reset", name, email: null, emailed: null },
  };
}

export async function setPortalRoleAction(clientId: string, _prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await portalMessages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  const role = portalRoleSchema.safeParse(text(formData, "role"));
  if (!person.success) return error("notFound");
  if (!role.success) return error("invalid");
  const res = await setPortalRole(actor, clientId, person.data.clientUserId, role.data);
  if (!res.ok) return error(res.error);
  refresh();
  return { ok: t.portalUsers.roleDone };
}

export async function removePortalUserAction(clientId: string, _prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const actor = await requireTeam(["owner", "manager"]);
  const { t, error } = await portalMessages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  if (!person.success) return error("notFound");
  const res = await removePortalUser(actor, clientId, person.data.clientUserId);
  if (!res.ok) return error(res.error);
  refresh();
  return { ok: t.portalUsers.removeDone };
}
