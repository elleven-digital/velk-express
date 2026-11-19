"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { LinkActionState } from "@/components/link-box";
import { requirePortalAdmin } from "@/lib/auth/guards";
import { invitePortalUser, linkForPortalAdmin, removePortalUser, resendPortalInvite, setPortalRole } from "@/lib/core/portal-users";
import { getAgency } from "@/lib/agency";
import { formValues, type FormValues } from "@/lib/form-values";
import { fmt } from "@/lib/i18n";
import { getPortalDict } from "@/lib/i18n/server";

/*
 * The Users page of the portal. The company is always the session's own (`session.client.id`):
 * no form field or URL chooses it, so an admin can only ever manage their own company. The core
 * checks the same thing again, against the database.
 */

const personSchema = z.object({ clientUserId: z.uuid() });
const roleSchema = z.enum(["admin", "collaborator"]);

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

async function messages() {
  const [{ t }, agency] = await Promise.all([getPortalDict(), getAgency()]);
  const known = t.portalUsers.errors as Record<string, string>;
  return {
    t,
    error: (code: string, values?: FormValues): LinkActionState => ({
      error: fmt(known[code] ?? t.portalUsers.errors.generic, { agency: agency?.name ?? "Velk Express" }),
      ...(values ? { values } : {}),
    }),
  };
}

const refresh = () => revalidatePath("/users");

export async function portalInviteAction(_prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const session = await requirePortalAdmin();
  const { t, error } = await messages();
  const role = roleSchema.safeParse(text(formData, "role"));
  const typed = formValues(formData, ["name", "email", "role"]);
  if (!role.success) return error("invalid", typed);
  const res = await invitePortalUser(session, session.client.id, {
    name: text(formData, "name"),
    email: text(formData, "email"),
    role: role.data,
  });
  if (!res.ok) return error(res.error, typed);
  refresh();
  const name = text(formData, "name").trim();
  const link = res.value.link ? linkForPortalAdmin(res.value.link, res.value.emailed) : null;
  if (!res.value.link || !link) return { ok: fmt(t.portalUsers.inviteDone, { name }) };
  return {
    ok: fmt(t.portalUsers.inviteDone, { name }),
    link: { url: link, kind: "invite", name, email: text(formData, "email").trim().toLowerCase(), emailed: res.value.emailed },
  };
}

export async function portalResendAction(_prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const session = await requirePortalAdmin();
  const { t, error } = await messages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  if (!person.success) return error("notFound");
  const res = await resendPortalInvite(session, session.client.id, person.data.clientUserId);
  if (!res.ok) return error(res.error);
  refresh();
  const name = text(formData, "name");
  const link = linkForPortalAdmin(res.value.link, res.value.emailed);
  if (!link) return { ok: fmt(t.portalUsers.resendDone, { name }) };
  return {
    ok: fmt(t.portalUsers.resendDone, { name }),
    link: { url: link, kind: "invite", name, email: text(formData, "email"), emailed: res.value.emailed },
  };
}

export async function portalRoleAction(_prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const session = await requirePortalAdmin();
  const { t, error } = await messages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  const role = roleSchema.safeParse(text(formData, "role"));
  if (!person.success) return error("notFound");
  if (!role.success) return error("invalid");
  const res = await setPortalRole(session, session.client.id, person.data.clientUserId, role.data);
  if (!res.ok) return error(res.error);
  // A demotion of oneself changes what the frame shows (the Users tab goes away).
  if (person.data.clientUserId === session.user.id && role.data !== "admin") redirect("/");
  refresh();
  return { ok: t.portalUsers.roleDone };
}

export async function portalRemoveAction(_prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const session = await requirePortalAdmin();
  const { t, error } = await messages();
  const person = personSchema.safeParse({ clientUserId: text(formData, "clientUserId") });
  if (!person.success) return error("notFound");
  const res = await removePortalUser(session, session.client.id, person.data.clientUserId);
  if (!res.ok) return error(res.error);
  // Whoever removed themselves is no longer in this company: the home decides where they land.
  if (person.data.clientUserId === session.user.id) redirect("/");
  refresh();
  return { ok: t.portalUsers.removeDone };
}
