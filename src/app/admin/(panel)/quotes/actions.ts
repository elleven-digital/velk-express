"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { LinkActionState } from "@/components/link-box";
import { requireTeam } from "@/lib/auth/guards";
import { executeQuote } from "@/lib/core/quote-execute";
import { archiveQuote, deleteQuote, saveQuote, sendQuote } from "@/lib/core/quotes";
import { fmt } from "@/lib/i18n";
import { getUserDict } from "@/lib/i18n/server";
import { parseQuotePayload, payloadErrorText } from "@/lib/quote-payload";
import type { QuoteState } from "./quote-state";

const idSchema = z.uuid();

async function messages() {
  const { t } = await getUserDict();
  const known = t.quotes.errors as Record<string, string>;
  return { t, error: (code: string): QuoteState => ({ error: known[code] ?? t.quotes.errors.generic }) };
}

function refresh(id?: string) {
  revalidatePath("/admin/quotes");
  if (id) revalidatePath(`/admin/quotes/${id}`);
}

/** Creates a quote, or rewrites the one in `quoteId`. The builder's whole state arrives as JSON in `payload`. */
export async function saveQuoteAction(_prev: QuoteState, formData: FormData): Promise<QuoteState> {
  const actor = await requireTeam();
  const { t, error } = await messages();
  const parsed = parseQuotePayload(formData.get("payload"));
  if (!parsed.ok) return { error: payloadErrorText(t.quotes.errors, parsed, fmt) };
  const quoteId = String(formData.get("quoteId") ?? "");
  const res = await saveQuote(actor, { ...parsed.value, ...(quoteId ? { quoteId } : {}) });
  if (!res.ok) return error(res.error);
  refresh(res.value.id);
  redirect(`/admin/quotes/${res.value.id}?ok=saved`);
}

/** Marks the quote as sent (again) and says who got the e-mail. The page shows the public link itself. */
export async function sendQuoteAction(_prev: QuoteState, formData: FormData): Promise<QuoteState> {
  const actor = await requireTeam();
  const { t, error } = await messages();
  const id = idSchema.safeParse(String(formData.get("quoteId") ?? ""));
  if (!id.success) return error("notFound");
  const res = await sendQuote(actor, id.data);
  if (!res.ok) return error(res.error);
  refresh(id.data);
  return { ok: res.value.emailedTo ? fmt(t.quotes.sentTo, { email: res.value.emailedTo }) : t.quotes.sentNoEmail };
}

/** Where a refused archive or delete lands: the quote's page (or the list when it is gone) with the reason in `?err=`. */
function refused(id: string, code: string): never {
  redirect(code === "notFound" ? `/admin/quotes?err=notFound` : `/admin/quotes/${id}?err=${code}`);
}

export async function archiveQuoteAction(formData: FormData): Promise<void> {
  const actor = await requireTeam();
  const id = idSchema.safeParse(String(formData.get("quoteId") ?? ""));
  if (!id.success) redirect("/admin/quotes");
  const res = await archiveQuote(actor, id.data);
  refresh(id.data);
  if (!res.ok) refused(id.data, res.error);
  // Archived in another tab already: say so instead of looking like nothing happened.
  redirect(res.value.changed ? `/admin/quotes/${id.data}` : `/admin/quotes/${id.data}?err=alreadyArchived`);
}

export async function deleteQuoteAction(formData: FormData): Promise<void> {
  const actor = await requireTeam();
  const id = idSchema.safeParse(String(formData.get("quoteId") ?? ""));
  if (!id.success) redirect("/admin/quotes");
  const res = await deleteQuote(actor, id.data);
  refresh(id.data);
  if (!res.ok) refused(id.data, res.error);
  redirect("/admin/quotes");
}

/**
 * "Close & execute": runs the ticked items (`itemIds`) of a sent or accepted quote. A login created
 * for the prospect comes back as a link to hand over, with whether its invite e-mail went out.
 */
export async function executeQuoteAction(_prev: LinkActionState, formData: FormData): Promise<LinkActionState> {
  const actor = await requireTeam();
  const { t, error } = await messages();
  // The public page's "nothing selected" talks about approving; here it is about executing.
  const fail = (code: string): LinkActionState => ({
    error: code === "nothingSelected" ? t.quotes.errors.nothingToExecute : error(code)?.error,
  });
  const id = idSchema.safeParse(String(formData.get("quoteId") ?? ""));
  if (!id.success) return fail("notFound");
  const itemIds = formData.getAll("itemIds").map(String);
  const res = await executeQuote(actor, id.data, itemIds);
  if (!res.ok) return fail(res.error);
  refresh(id.data);
  revalidatePath("/admin/clients");
  revalidatePath("/admin/tickets");
  revalidatePath("/admin/projects");
  const invite = res.value.invite;
  return {
    ok: t.quotes.executeDone,
    link: invite ? { url: invite.link, kind: "invite", name: invite.name, email: invite.email, emailed: invite.emailed } : undefined,
  };
}
