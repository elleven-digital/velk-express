"use client";

import { useRef, useState, useTransition } from "react";
import { DOCUMENT_ACCEPT, DOCUMENT_MAX_BYTES, documentMime } from "@/lib/attachments";
import { Icon } from "./icons";
import { CopyButton } from "./link-box";
import { ControlButton } from "./ticket-controls";
import { Badge, buttonClasses, cn, type BadgeTone } from "./ui";

type ActionResult = { error?: string };

export type ChargeDocLabels = {
  upload: string;
  uploading: string;
  open: string;
  remove: string;
  removeConfirm: string;
  hint: string;
  fileType: string;
  fileTooLarge: string;
  uploadFailed: string;
  /** The generic refusal, for an upload the server turned down. */
  invalidFile: string;
};

export type ChargeLabels = ChargeDocLabels & {
  copyLink: string;
  copied: string;
  openLink: string;
  markPaid: string;
  markPaidHint: string;
  cancel: string;
  cancelConfirm: string;
  documentTitle: string;
};

/** The bound actions of one charge. A missing one hides its control (the viewer may not do it). */
export type ChargeActions = {
  cancel?: () => Promise<ActionResult>;
  markPaid?: () => Promise<ActionResult>;
  attach?: (fileId: string) => Promise<ActionResult>;
  removeDocument?: () => Promise<ActionResult>;
};

/** Uploads the file as a fiscal document (the raw body, never through an action) and returns its id. */
async function uploadDocument(file: File, labels: ChargeDocLabels): Promise<{ id: string } | { error: string }> {
  if (!documentMime(file.name)) return { error: labels.fileType };
  if (file.size > DOCUMENT_MAX_BYTES) return { error: labels.fileTooLarge };
  if (file.size === 0) return { error: labels.uploadFailed };
  try {
    const res = await fetch("/api/upload?side=team&purpose=document", {
      method: "POST",
      headers: { "x-file-name": encodeURIComponent(file.name) },
      body: file,
    });
    if (res.status === 415) return { error: labels.fileType };
    if (res.status === 413) return { error: labels.fileTooLarge };
    if (!res.ok) return { error: labels.uploadFailed };
    return { id: ((await res.json()) as { id: string }).id };
  } catch {
    return { error: labels.uploadFailed };
  }
}

/**
 * The fiscal document of a charge: a link to open it and a remove button, or a file picker to
 * attach one. `compact` is for table rows (no label, icon-only remove).
 */
export function ChargeDocControl({
  chargeId,
  doc,
  attach,
  removeDocument,
  labels,
  compact = false,
}: {
  chargeId: string;
  doc: { id: string; name: string } | null;
  attach?: (fileId: string) => Promise<ActionResult>;
  removeDocument?: () => Promise<ActionResult>;
  labels: ChargeDocLabels;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputId = `doc-${chargeId}`;

  const pick = (file: File | undefined) => {
    if (!file || !attach) return;
    setError(null);
    start(async () => {
      const up = await uploadDocument(file, labels);
      if ("error" in up) {
        setError(up.error);
      } else {
        const res = await attach(up.id);
        setError(res.error ?? null);
      }
      if (input.current) input.current.value = "";
    });
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-1.5">
      {doc ? (
        <>
          <a
            href={`/api/files/${doc.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={doc.name}
            className={cn(buttonClasses("secondary", "sm"), "max-w-full")}
          >
            <Icon name="file" />
            {labels.open}
          </a>
          {removeDocument ? (
            <ControlButton
              variant="ghost"
              className={cn("text-muted hover:text-danger", compact ? "!px-0 w-8" : "")}
              label={labels.remove}
              confirm={labels.removeConfirm}
              action={removeDocument}
            >
              <Icon name="x" />
              {compact ? null : labels.remove}
            </ControlButton>
          ) : null}
        </>
      ) : attach ? (
        <>
          <input
            ref={input}
            id={inputId}
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="sr-only"
            onChange={(e) => pick(e.target.files?.[0])}
            disabled={pending}
          />
          <label
            htmlFor={inputId}
            title={labels.hint}
            className={cn(buttonClasses(compact ? "ghost" : "secondary", "sm"), "cursor-pointer", pending && "pointer-events-none opacity-50")}
          >
            <Icon name="paperclip" />
            {pending ? labels.uploading : labels.upload}
          </label>
        </>
      ) : (
        <span className="text-muted">—</span>
      )}
      </div>
      {error ? (
        <p role="alert" className="text-[0.8125rem] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One charge, the same on every screen: status and amount, the payment link, mark as paid and
 * cancel, the fiscal document and a footer saying how it is paid. Only strings, numbers and bound
 * actions come in: the page has done the formatting.
 */
export function ChargePanel({
  chargeId,
  status,
  amount,
  paidOn,
  payUrl,
  canMarkPaid,
  document,
  footer,
  actions,
  labels,
}: {
  chargeId: string;
  status: { label: string; tone: BadgeTone };
  /** Already formatted, with "/month" for a subscription. */
  amount: string;
  paidOn: string | null;
  /** The payment link, only while the charge can still be paid. */
  payUrl: string | null;
  canMarkPaid: boolean;
  document: { id: string; name: string } | null;
  footer: string;
  actions: ChargeActions;
  labels: ChargeLabels;
}) {
  const showDocument = document !== null || actions.attach !== undefined;
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <Badge tone={status.tone}>{status.label}</Badge>
          <b className="tabular font-medium text-ink">{amount}</b>
        </div>
        {paidOn ? <p className="mt-1 text-[0.8125rem] text-muted">{paidOn}</p> : null}
      </div>

      {payUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={payUrl} label={labels.copyLink} copiedLabel={labels.copied} />
          <a href={payUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost", "sm")}>
            <Icon name="ext" />
            {labels.openLink}
          </a>
        </div>
      ) : null}

      {(canMarkPaid && actions.markPaid) || actions.cancel ? (
        <div className="flex flex-wrap items-center gap-2">
          {canMarkPaid && actions.markPaid ? (
            <ControlButton confirm={labels.markPaidHint} action={actions.markPaid}>
              <Icon name="check" />
              {labels.markPaid}
            </ControlButton>
          ) : null}
          {actions.cancel ? (
            <ControlButton variant="ghost" className="text-muted hover:text-danger" confirm={labels.cancelConfirm} action={actions.cancel}>
              {labels.cancel}
            </ControlButton>
          ) : null}
        </div>
      ) : null}

      {showDocument ? (
        <div className="space-y-1.5">
          <div className="text-[0.8125rem] font-medium text-muted">{labels.documentTitle}</div>
          <ChargeDocControl
            chargeId={chargeId}
            doc={document}
            attach={actions.attach}
            removeDocument={actions.removeDocument}
            labels={labels}
          />
        </div>
      ) : null}

      <p className="text-[0.8125rem] text-muted">{footer}</p>
    </div>
  );
}

/** The actions of a row in the charges list: copy the link, mark as paid, cancel. */
export function ChargeRowActions({
  payUrl,
  canMarkPaid,
  actions,
  labels,
}: {
  payUrl: string | null;
  canMarkPaid: boolean;
  actions: Pick<ChargeActions, "cancel" | "markPaid">;
  labels: Pick<ChargeLabels, "copyLink" | "copied" | "markPaid" | "markPaidHint" | "cancel" | "cancelConfirm">;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {payUrl ? <CopyButton text={payUrl} label={labels.copyLink} copiedLabel={labels.copied} /> : null}
      {canMarkPaid && actions.markPaid ? (
        <ControlButton confirm={labels.markPaidHint} action={actions.markPaid}>
          {labels.markPaid}
        </ControlButton>
      ) : null}
      {actions.cancel ? (
        <ControlButton
          variant="ghost"
          className="!px-0 w-8 text-muted hover:text-danger"
          label={labels.cancel}
          confirm={labels.cancelConfirm}
          action={actions.cancel}
        >
          <Icon name="x" />
        </ControlButton>
      ) : null}
    </div>
  );
}
