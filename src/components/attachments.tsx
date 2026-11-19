"use client";

import { useRef, useState, useTransition } from "react";
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_BATCH, attachmentMime, opensInline } from "@/lib/attachments";
import type { FileItem } from "@/lib/core/thread";
import type { Locale } from "@/lib/i18n";
import type { MessageActionState } from "./chat";
import { Icon } from "./icons";
import { LocalTime } from "./local-time";
import { buttonClasses, cn } from "./ui";

export type AttachmentLabels = {
  attach: string;
  uploading: string;
  remove: string;
  uploadFailed: string;
  fileType: string;
  /** Contains {max}. */
  fileTooLarge: string;
  uploadUnavailable: string;
  tooManyFiles: string;
  uploadLimit: string;
};

export type UploadedFile = { id: string; name: string; size: number; mime: string };
export type Uploaded = UploadedFile;

/** The texts of the ticket's files UI (messages' attachments, pending files, the "Files" panel). */
export type FileLabels = AttachmentLabels & {
  removeConfirm: string;
  download: string;
  /** "in the conversation": a file sent in a message. */
  inMessage: string;
  empty: string;
};

const MAX_LABEL = `${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`;

/**
 * Uploads one attachment as the raw request body (never through a server action). It belongs to
 * the session's person and to nothing else until the ticket or message that carries it claims it.
 */
export async function uploadAttachment(
  file: File,
  side: "team" | "portal",
  labels: AttachmentLabels,
): Promise<{ ok: true; file: UploadedFile } | { ok: false; error: string }> {
  if (!attachmentMime(file.name)) return { ok: false, error: `${file.name}: ${labels.fileType}` };
  if (file.size > ATTACHMENT_MAX_BYTES) return { ok: false, error: `${file.name}: ${labels.fileTooLarge.replace("{max}", MAX_LABEL)}` };
  if (file.size === 0) return { ok: false, error: `${file.name}: ${labels.uploadFailed}` };
  try {
    const res = await fetch(`/api/upload?side=${side}&purpose=attachment`, {
      method: "POST",
      headers: { "x-file-name": encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) {
      const error =
        res.status === 415
          ? labels.fileType
          : res.status === 413
            ? labels.fileTooLarge.replace("{max}", MAX_LABEL)
            : res.status === 429
              ? labels.uploadLimit
              : res.status === 503
                ? labels.uploadUnavailable
                : labels.uploadFailed;
      return { ok: false, error: `${file.name}: ${error}` };
    }
    return { ok: true, file: (await res.json()) as UploadedFile };
  } catch {
    return { ok: false, error: `${file.name}: ${labels.uploadFailed}` };
  }
}

/** Files picked in the composer, before the message is sent. */
export type PendingFile = { key: string; name: string; status: "uploading" | "done"; id?: string };
type Pending = PendingFile;

/**
 * A file picker that uploads on pick and puts the ids of what is uploaded in a hidden field
 * (`name`, comma separated) for the form to carry. `onBusyChange` tells the form to wait.
 */
export function AttachmentField({
  name,
  side,
  labels,
  onBusyChange,
}: {
  name: string;
  side: "team" | "portal";
  labels: AttachmentLabels;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  // Held outside state so two quick picks count their uploads together.
  const inFlight = useRef(0);
  const total = useRef(0);

  const setBusy = (delta: number) => {
    inFlight.current += delta;
    onBusyChange?.(inFlight.current > 0);
  };

  async function pick(picked: File[]) {
    setError(null);
    if (total.current + picked.length > ATTACHMENTS_PER_BATCH) {
      setError(labels.tooManyFiles);
      return;
    }
    total.current += picked.length;
    const batch = picked.map((f) => ({ file: f, key: `f${counter.current++}` }));
    setItems((cur) => [...cur, ...batch.map((b) => ({ key: b.key, name: b.file.name, status: "uploading" as const }))]);
    setBusy(batch.length);
    const failures: string[] = [];
    await Promise.all(
      batch.map(async ({ file, key }) => {
        const res = await uploadAttachment(file, side, labels);
        if (res.ok) {
          setItems((cur) => cur.map((i) => (i.key === key ? { ...i, status: "done", id: res.file.id } : i)));
        } else {
          failures.push(res.error);
          total.current -= 1;
          setItems((cur) => cur.filter((i) => i.key !== key));
        }
        setBusy(-1);
      }),
    );
    if (failures.length) setError(failures.join(" "));
  }

  function remove(key: string) {
    total.current -= 1;
    setItems((cur) => cur.filter((i) => i.key !== key));
  }

  const ids = items.flatMap((i) => (i.id ? [i.id] : []));
  const uploading = items.some((i) => i.status === "uploading");
  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={ids.join(",")} />
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        data-testid="attachment-input"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) void pick(picked);
        }}
      />
      {items.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((f) => (
            <li
              key={f.key}
              className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-line bg-paper pl-2 pr-1 py-1 text-[0.8125rem]"
            >
              {f.status === "uploading" ? (
                <span
                  aria-label={labels.uploading}
                  className="size-3 flex-none rounded-full border-2 border-muted border-t-transparent animate-spin"
                />
              ) : (
                <Icon name="paperclip" size={14} className="text-muted" />
              )}
              <span className="min-w-0 truncate text-ink">{f.name}</span>
              <button
                type="button"
                aria-label={`${labels.remove} ${f.name}`}
                disabled={f.status === "uploading"}
                onClick={() => remove(f.key)}
                className="flex-none rounded p-0.5 text-muted hover:text-ink hover:bg-chip"
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-[0.8125rem] font-medium text-danger">
          {error}
        </p>
      ) : null}
      <button type="button" onClick={() => inputRef.current?.click()} className={cn(buttonClasses("secondary", "sm"))}>
        <Icon name="paperclip" />
        {uploading ? labels.uploading : labels.attach}
      </button>
    </div>
  );
}

/** A hidden file picker for attachments, opened by `open()`. */
export function useFilePicker(onPick: (files: File[]) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      multiple
      accept={ATTACHMENT_ACCEPT}
      className="hidden"
      tabIndex={-1}
      data-testid="attachment-input"
      onChange={(e) => {
        const picked = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (picked.length) onPick(picked);
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

/** What a file's link does: types a browser shows (images, PDF, text) open in a tab; the rest download. */
function fileLink(f: Pick<FileItem, "url" | "mime">): { href: string; opens: boolean } {
  const opens = opensInline(f.mime);
  return { href: opens ? f.url : `${f.url}?download=1`, opens };
}

/** The files sent with a message: images as thumbnails, the rest as chips. */
export function MessageAttachments({ files, labels }: { files: FileItem[]; labels: FileLabels }) {
  if (files.length === 0) return null;
  const images = files.filter((f) => f.preview);
  const others = files.filter((f) => !f.preview);
  return (
    <div className="mt-2.5 space-y-2 first:mt-0">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((f) => (
            <a
              key={f.id}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              title={f.name}
              className="block overflow-hidden rounded-md border border-line bg-white hover:border-line-strong"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.url} alt={f.name} className="h-28 max-w-[220px] object-cover" loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {others.map((f) => {
            const link = fileLink(f);
            return (
              <li key={f.id}>
                <a
                  href={link.href}
                  {...(link.opens ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  title={link.opens ? f.name : `${labels.download} ${f.name}`}
                  className="inline-flex max-w-[280px] items-center gap-2 rounded-md border border-line bg-white px-2.5 py-1.5 text-[0.8125rem] hover:border-line-strong"
                >
                  <Icon name="file" size={16} className="text-muted" />
                  <span className="min-w-0 truncate font-medium text-ink">{f.name}</span>
                  <span className="flex-none text-muted tabular">{f.size}</span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** The chips of the files picked for the next message (uploading, then ready). */
export function PendingFiles({
  files,
  onRemove,
  labels,
}: {
  files: PendingFile[];
  onRemove: (key: string) => void;
  labels: FileLabels;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <li
          key={f.key}
          className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-line bg-paper pl-2 pr-1 py-1 text-[0.8125rem]"
        >
          {f.status === "uploading" ? (
            <span
              aria-label={labels.uploading}
              className="size-3 flex-none rounded-full border-2 border-muted border-t-transparent animate-spin"
            />
          ) : (
            <Icon name="paperclip" size={14} className="text-muted" />
          )}
          <span className="min-w-0 truncate text-ink">{f.name}</span>
          <button
            type="button"
            aria-label={`${labels.remove} ${f.name}`}
            onClick={() => onRemove(f.key)}
            className="flex-none rounded p-0.5 text-muted hover:text-ink hover:bg-chip"
          >
            <Icon name="x" size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The ticket's "Files": general attachments and those sent in messages, newest first, plus
 * "Attach file" for a general attachment. Files upload as raw bodies; only their ids reach the action.
 */
export function TicketFiles({
  files,
  side,
  attachAction,
  removeAction,
  labels,
  locale,
  disabled = false,
  className,
}: {
  files: FileItem[];
  side: "team" | "portal";
  attachAction: (fileIds: string[]) => Promise<MessageActionState>;
  removeAction: (fileId: string) => Promise<MessageActionState>;
  labels: FileLabels;
  locale: Locale;
  /** A closed ticket takes no new files. */
  disabled?: boolean;
  className?: string;
}) {
  const [busy, startBusy] = useTransition();
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const picker = useFilePicker((picked) => {
    setError(null);
    if (picked.length > ATTACHMENTS_PER_BATCH) {
      setError(labels.tooManyFiles);
      return;
    }
    setUploading(picked.length);
    startBusy(async () => {
      const results = await Promise.all(picked.map((f) => uploadAttachment(f, side, labels)));
      setUploading(0);
      const failed = results.flatMap((r) => (r.ok ? [] : [r.error]));
      const ids = results.flatMap((r) => (r.ok ? [r.file.id] : []));
      if (ids.length) {
        const saved = await attachAction(ids);
        if (saved?.error) failed.push(saved.error);
      }
      setError(failed.length ? failed.join(" ") : null);
    });
  });

  function remove(f: FileItem) {
    if (!window.confirm(labels.removeConfirm)) return;
    startBusy(async () => {
      const result = await removeAction(f.id);
      setError(result?.error ?? null);
    });
  }

  return (
    <div className={className}>
      {files.length === 0 ? (
        <p className="text-muted mb-3">{labels.empty}</p>
      ) : (
        <ul className="space-y-2.5 mb-3">
          {files.map((f) => (
              <li key={f.id} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-md border border-line bg-paper text-muted">
                  <Icon name={f.preview ? "image" : "file"} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate font-medium leading-tight text-ink hover:underline underline-offset-[3px]"
                    title={f.name}
                  >
                    {f.name}
                  </a>
                  <span className="block text-[0.8125rem] text-muted truncate">
                    {f.size} ·{" "}
                    {f.messageId ? (
                      <a href={`#msg-${f.messageId}`} className="hover:text-ink hover:underline underline-offset-[3px]">
                        {labels.inMessage}
                      </a>
                    ) : (
                      f.byName
                    )}{" "}
                    · <LocalTime iso={f.at} locale={locale} />
                  </span>
                </span>
                <a
                  href={`${f.url}?download=1`}
                  aria-label={`${labels.download} ${f.name}`}
                  title={labels.download}
                  className="flex-none rounded-md p-1.5 text-muted hover:text-ink hover:bg-chip"
                >
                  <Icon name="download" size={14} />
                </a>
                {f.canDelete ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(f)}
                    aria-label={`${labels.remove} ${f.name}`}
                    title={labels.remove}
                    className="flex-none rounded-md p-1.5 text-muted hover:text-danger hover:bg-chip disabled:opacity-40"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                ) : null}
              </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mb-2 text-[0.8125rem] font-medium text-danger">
          {error}
        </p>
      ) : null}
      {picker.input}
      {disabled ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={picker.open}
          className={cn(buttonClasses("secondary", "sm"), "w-full")}
        >
          {uploading > 0 ? (
            <span aria-hidden className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          ) : (
            <Icon name="paperclip" />
          )}
          {uploading > 0 ? labels.uploading : labels.attach}
        </button>
      )}
    </div>
  );
}
