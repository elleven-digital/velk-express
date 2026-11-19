"use client";

import { useState } from "react";
import { buttonClasses } from "@/components/ui";
import type { FormValues } from "@/lib/form-values";
import { fmt } from "@/lib/i18n";

/** A link to hand over: `emailed` is null for reset links (never e-mailed) and for logins that were only linked. */
export type LinkState = {
  url: string;
  kind: "invite" | "reset";
  name: string;
  email: string | null;
  emailed: boolean | null;
};

/** What an action that can produce a link returns: null before the first submit; text is already translated. Errors carry the submitted `values`. */
export type LinkActionState = { error?: string; ok?: string; link?: LinkState; confirm?: LinkConfirm; values?: FormValues } | null;

/**
 * Team invite only: an existing login was found and nothing was written yet. The team must confirm
 * linking it; `active` is sent back so a login that changed in between asks again.
 */
export type LinkConfirm = {
  clientUserId: string;
  active: boolean;
  clientName: string;
  /** What the team typed, sent back untouched by the confirm button (the form resets after each submit). */
  typed: { name: string; email: string; role: "admin" | "collaborator" };
  /** The existing login's own name. */
  name: string;
  companies: { name: string; role: "admin" | "collaborator" }[];
  willBeAdmin: boolean;
};

export type LinkBoxLabels = {
  linkTitle: string;
  linkHint: string;
  expiresInvite: string;
  expiresReset: string;
  emailSent: string;
  emailNotSent: string;
  copyLink: string;
  copiedLink: string;
};

export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClasses("secondary", "sm")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard blocked: the link stays selectable in the field.
        }
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

/** The link to hand over, with a Copy button and whether the e-mail went out. */
export function LinkBox({ state, labels }: { state: LinkActionState; labels: LinkBoxLabels }) {
  const link = state?.link;
  if (!link) return null;
  return (
    <div className="mt-3 space-y-2 rounded-field border border-line bg-paper p-3.5" role="status">
      {state?.ok ? <div className="text-[0.875rem] font-medium text-ink">{state.ok}</div> : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          aria-label={fmt(labels.linkTitle, { name: link.name })}
          value={link.url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 basis-60 rounded-field border border-line bg-white px-3 py-[7px] font-mono text-[0.8125rem] text-ink"
        />
        <CopyButton text={link.url} label={labels.copyLink} copiedLabel={labels.copiedLink} />
      </div>
      <p className="text-[0.8125rem] text-muted">
        {fmt(labels.linkHint, { name: link.name })} {link.kind === "invite" ? labels.expiresInvite : labels.expiresReset}
      </p>
      {link.emailed === true ? (
        <p className="text-[0.8125rem] text-muted">{fmt(labels.emailSent, { email: link.email ?? "" })}</p>
      ) : link.emailed === false ? (
        <p className="text-[0.8125rem] font-medium text-ink">{labels.emailNotSent}</p>
      ) : null}
    </div>
  );
}
