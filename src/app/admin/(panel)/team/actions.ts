"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTeam } from "@/lib/auth/guards";
import { setMemberClients } from "@/lib/core/assignments";
import { changeRole, createResetLink, inviteMember, removeMember, resendInvite, ROLES } from "@/lib/core/team";
import { formValues, type FormValues } from "@/lib/form-values";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import type { TeamState } from "./team-state";

const idSchema = z.object({ userId: z.uuid() });
const roleSchema = idSchema.extend({ role: z.enum(ROLES) });
const inviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().min(1).max(254),
  role: z.enum(ROLES),
});

async function messages() {
  const { t } = await getUserDict();
  const known = t.team.errors as Record<string, string>;
  return {
    t,
    error: (code: string, values?: FormValues): TeamState => ({ error: known[code] ?? t.team.errors.generic, ...(values ? { values } : {}) }),
  };
}

function fields(formData: FormData, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, String(formData.get(k) ?? "")]));
}

export async function inviteAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const typed = formValues(formData, ["name", "email", "role"]);
  const input = inviteSchema.safeParse(fields(formData, ["name", "email", "role"]));
  if (!input.success) return error("invalid", typed);
  const res = await inviteMember(actor, input.data);
  if (!res.ok) return error(res.error, typed);
  revalidatePath("/admin/team");
  return {
    ok: fmt(t.team.inviteDone, { name: input.data.name }),
    link: { url: res.value.link, kind: "invite", name: input.data.name, email: input.data.email.toLowerCase(), emailed: res.value.emailed },
  };
}

export async function resendInviteAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const input = idSchema.extend({ name: z.string().max(120), email: z.string().max(254) }).safeParse(
    fields(formData, ["userId", "name", "email"]),
  );
  if (!input.success) return error("invalid");
  const res = await resendInvite(actor, input.data.userId);
  if (!res.ok) return error(res.error);
  revalidatePath("/admin/team");
  return {
    ok: fmt(t.team.resendDone, { name: input.data.name }),
    link: { url: res.value.link, kind: "invite", name: input.data.name, email: input.data.email, emailed: res.value.emailed },
  };
}

export async function resetLinkAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const input = idSchema.extend({ name: z.string().max(120) }).safeParse(fields(formData, ["userId", "name"]));
  if (!input.success) return error("invalid");
  const res = await createResetLink(actor, input.data.userId);
  if (!res.ok) return error(res.error);
  revalidatePath("/admin/team");
  return {
    ok: fmt(t.team.resetDone, { name: input.data.name }),
    link: { url: res.value.link, kind: "reset", name: input.data.name, email: null, emailed: null },
  };
}

export async function changeRoleAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const input = roleSchema.safeParse(fields(formData, ["userId", "role"]));
  if (!input.success) return error("invalid");
  const res = await changeRole(actor, input.data.userId, input.data.role);
  if (!res.ok) return error(res.error);
  revalidatePath("/admin/team");
  return { ok: t.team.roleDone };
}

export async function removeMemberAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const input = idSchema.safeParse(fields(formData, ["userId"]));
  if (!input.success) return error("invalid");
  const res = await removeMember(actor, input.data.userId);
  if (!res.ok) return error(res.error);
  revalidatePath("/admin/team");
  return { ok: t.team.removeDone };
}

export async function setMemberClientsAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const actor = await requireTeam(["owner"]);
  const { t, error } = await messages();
  const input = idSchema.safeParse(fields(formData, ["userId"]));
  if (!input.success) return error("invalid");
  const res = await setMemberClients(actor, input.data.userId, formData.getAll("clientIds").map(String));
  if (!res.ok) return error(res.error);
  revalidatePath("/admin/team");
  return { ok: t.team.clientsDone };
}
