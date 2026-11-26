"use client";

import { useActionState, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { ATTACHMENTS_PER_BATCH } from "@/lib/attachments";
import type { ThreadMessage } from "@/lib/core/thread";
import type { FormValues } from "@/lib/form-values";
import type { Locale } from "@/lib/i18n";
import { MessageAttachments, PendingFiles, uploadAttachment, useFilePicker, type FileLabels, type PendingFile } from "./attachments";
import { RichEditor, type EditorLabels } from "./editor";
import { fillNode } from "./fill-node";
import { Icon } from "./icons";
import { LocalTime } from "./local-time";
import { SendRefusal } from "./send-refusal";
import { SubmitButton } from "./submit-button";
import { Avatar, buttonClasses, cn } from "./ui";

// the small actions on a message's line (reply, edit, delete): shown on hover, always on touch screens
const msgActionBase =
  "-my-1 inline-flex items-center gap-1 h-7 px-1.5 rounded-md text-[0.8125rem] font-medium text-muted hover:bg-chip opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 transition-opacity disabled:opacity-40";
const msgAction = `${msgActionBase} hover:text-ink`;

/**
 * What the conversation's actions answer: `ok` with a new `nonce` for a success (the composer
 * clears when it sees one), `error` (already translated) otherwise, plus the submitted `values` so
 * a refusal never costs what was typed.
 */
export type MessageActionState = {
  ok?: boolean;
  error?: string;
  nonce?: number;
  values?: FormValues;
  /** The refused message as plain text, for when the composer is gone (the ticket was closed meanwhile). */
  unsent?: string;
} | null;

/** A quiet line between messages (time logged on the ticket), placed by `at` (epoch ms). Team side only. */
export type ChatEvent = { id: string; at: number; iso: string; name: string; mine: boolean; time: string };

export type ChatLabels = EditorLabels & {
  send: string;
  reply: string;
  /** Contains {name}. */
  replyingTo: string;
  cancelReply: string;
  you: string;
  emptyThread: string;
  /** Role next to the author: the agency's people, the client's people. */
  team: string;
  client: string;
  /** Composer placeholder once the other side has written (contains {name}). */
  replyTo: string;
  edit: string;
  delete: string;
  save: string;
  cancelEdit: string;
  /** "Edited" (portal side); "Edited by {name} · {date}" (team side). */
  edited: string;
  editedBy: string;
  /** "Message deleted"; "Deleted by {name} · {date}" (team side). */
  deleted: string;
  deletedBy: string;
  deleteConfirm: string;
  /** Heads the refused text that is shown when the composer is gone. */
  unsent: string;
  /** A time event line; contains {name} and {time}. */
  timeEvent: string;
  /** The files UI inside the conversation. */
  files: FileLabels;
};

export function ChatThread({
  messages,
  events = [],
  side,
  editorSide,
  locale,
  sendAction,
  editAction,
  deleteAction,
  closedNotice,
  labels,
  heightClass = "max-h-[calc(100dvh-22rem)] lg:max-h-[calc(100dvh-15rem)]",
  framed = false,
  fill = false,
}: {
  messages: ThreadMessage[];
  /** Quiet lines placed among the messages by time (the team's time entries). */
  events?: ChatEvent[];
  /** Who is reading: the composer addresses the latest person on the other side. */
  side: "agency" | "client";
  /** Whose upload endpoint the editor and the attachments use. */
  editorSide: "team" | "portal";
  locale: Locale;
  /** Fields: body (HTML), replyToId, attachmentIds ("a,b"). */
  sendAction: (prev: MessageActionState, fd: FormData) => Promise<MessageActionState>;
  editAction?: (messageId: string, bodyHtml: string) => Promise<MessageActionState>;
  deleteAction?: (messageId: string) => Promise<MessageActionState>;
  /** When set, the composer is replaced by this notice (ticket closed). */
  closedNotice?: ReactNode;
  labels: ChatLabels;
  /** The most the whole chat (thread + composer) may grow to; the page's own sticky box can override it. */
  heightClass?: string;
  /** Inside a white box: the messages turn gray (and a quoted reply white) to stand apart from it. */
  framed?: boolean;
  /** In a box of fixed height: the thread takes the room left and the composer sits at the bottom. */
  fill?: boolean;
}) {
  const fileLabels = labels.files;
  const bubbleBg = framed ? "bg-paper" : "bg-white";
  const quoteBg = framed ? "bg-white" : "bg-paper";
  // messages and events in one line of time; a message goes first when both share a moment
  type Item = { at: number; message: ThreadMessage; event?: undefined } | { at: number; event: ChatEvent; message?: undefined };
  const timeline: Item[] = [
    ...messages.map((message): Item => ({ at: message.at, message })),
    ...events.map((event): Item => ({ at: event.at, event })),
  ].sort((a, b) => a.at - b.at || (a.event ? 1 : 0) - (b.event ? 1 : 0));
  const [replyPick, setReplyTo] = useState<{ id: string; name: string; bodyHtml: string } | null>(null);
  // the message being edited in place, and a refusal from edit/delete
  const [editPick, setEditingId] = useState<string | null>(null);
  // a message deleted meanwhile can't be answered or edited any more
  const gone = (id: string) => messages.some((m) => m.id === id && m.deleted);
  const replyTo = replyPick && !gone(replyPick.id) ? replyPick : null;
  const editingId = editPick && !gone(editPick) ? editPick : null;
  const [changeError, setChangeError] = useState<{ id: string; text: string } | null>(null);
  const [changing, startChange] = useTransition();
  const editEditorRef = useRef<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(timeline.length);
  // Whether the reader is at the newest message. New messages and late images only pull the view
  // down while they are; reading older ones stays put.
  const atBottom = useRef(true);
  const sentByMe = useRef(false);
  const lastTop = useRef(0);
  // The composer rests as one line next to the send button and opens up (toolbar, taller field)
  // while it has focus, a draft or a reply target.
  const [focused, setFocused] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  // files picked for the next message: uploading, then ready to send
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const uploading = pending.some((f) => f.status === "uploading");
  const picker = useFilePicker((picked) => {
    setFileError(null);
    if (pending.length + picked.length > ATTACHMENTS_PER_BATCH) {
      setFileError(fileLabels.tooManyFiles);
      return;
    }
    const batch = picked.map((file) => ({ file, key: `${Date.now()}-${Math.random()}` }));
    setPending((list) => [...list, ...batch.map((b) => ({ key: b.key, name: b.file.name, status: "uploading" as const }))]);
    for (const { file, key } of batch) {
      void uploadAttachment(file, editorSide, fileLabels).then((r) => {
        if (r.ok) {
          setPending((list) => list.map((f) => (f.key === key ? { ...f, status: "done", id: r.file.id } : f)));
        } else {
          setPending((list) => list.filter((f) => f.key !== key));
          setFileError(r.error);
        }
      });
    }
  });
  const expanded = focused || hasDraft || replyTo !== null || pending.length > 0;

  const toBottom = (smooth = false) => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // Open on the newest message, before the first paint.
  useLayoutEffect(() => {
    toBottom();
  }, []);

  // Stay on the newest message, while the reader is there, when the thread grows (images and fonts
  // loading late) or its window shrinks (the editor mounting, a long draft, the "replying to" bar).
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollerRef.current;
    if (!content || !scroller) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) toBottom();
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const [state, formAction] = useActionState(sendAction, null);

  // A success brings a new nonce: only then the editor, the quoted reply and the pending files are
  // cleared. A refusal leaves everything as it was, and puts back the text if the editor lost it.
  const seenNonce = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      if (state.nonce === seenNonce.current) return;
      seenNonce.current = state.nonce;
      editorRef.current?.commands.clearContent(true);
      setReplyTo(null);
      setPending([]);
      setFileError(null);
      sentByMe.current = true;
    } else if (state.error && state.values?.body && editorRef.current?.isEmpty) {
      editorRef.current.commands.setContent(state.values.body, { emitUpdate: true });
    }
  }, [state]);

  useEffect(() => {
    if (timeline.length === lastCount.current) return;
    lastCount.current = timeline.length;
    if (atBottom.current || sentByMe.current) toBottom(true);
    sentByMe.current = false;
  }, [timeline.length]);

  function saveEdit(id: string) {
    if (!editAction) return;
    const html = editEditorRef.current?.getHTML() ?? "";
    startChange(async () => {
      const result = await editAction(id, html);
      if (result?.error) setChangeError({ id, text: result.error });
      else {
        setChangeError(null);
        setEditingId(null);
      }
    });
  }

  function remove(id: string) {
    if (!deleteAction || !window.confirm(labels.deleteConfirm)) return;
    startChange(async () => {
      const result = await deleteAction(id);
      setChangeError(result?.error ? { id, text: result.error } : null);
    });
  }

  function jumpTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-4", "ring-line");
      setTimeout(() => el.classList.remove("ring-4", "ring-line"), 1200);
    }
  }

  // "Reply to Marina…": whoever is being replied to, else the latest person on the other side, once they have written
  const lastOther = [...messages].reverse().find((m) => !m.deleted && m.fromAgency !== (side === "agency"));
  const addressee = replyTo?.name ?? lastOther?.authorName;
  const placeholder = addressee ? labels.replyTo.replace("{name}", () => addressee.split(" ")[0]) : labels.placeholder;

  return (
    // As tall as its messages, up to what the screen allows; past that the thread scrolls on its
    // own and the composer stays in view under it.
    <div className={cn("flex flex-col min-h-0", heightClass)}>
      {/* thread */}
      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          atBottom.current = distance < 80;
          // reading older messages: give the room back to the thread, unless there is something in the composer worth keeping open
          if (focused && !hasDraft && !replyTo && el.scrollTop < lastTop.current - 2 && distance > 120) {
            editorRef.current?.commands.blur();
          }
          lastTop.current = el.scrollTop;
        }}
        className={cn("min-h-0 overflow-y-auto overscroll-contain -mx-2 px-2", fill && "flex-1")}
      >
        <div ref={contentRef} className="flex flex-col gap-6 pt-1 pb-6">
          {timeline.length === 0 ? <p className="text-center text-muted py-10">{labels.emptyThread}</p> : null}
          {timeline.map((item) => {
            if (item.event) {
              const e = item.event;
              return (
                <p key={`time-${e.id}`} className="flex items-center gap-1.5 sm:ml-[38px] -my-2 text-[0.8125rem] text-muted">
                  <Icon name="clock" size={13} />
                  <span className="min-w-0">
                    {fillNode(labels.timeEvent, { name: e.mine ? labels.you : e.name, time: e.time })} ·{" "}
                    <LocalTime iso={e.iso} locale={locale} />
                  </span>
                </p>
              );
            }
            const m = item.message;
            const editing = editingId === m.id;
            // "Edited" for the portal; who and when for the team
            const note = m.deleted
              ? m.changedBy
                ? fillNode(labels.deletedBy, { name: m.changedBy.name, date: <LocalTime iso={m.changedBy.at} locale={locale} /> })
                : null
              : m.edited
                ? m.changedBy
                  ? fillNode(labels.editedBy, { name: m.changedBy.name, date: <LocalTime iso={m.changedBy.at} locale={locale} /> })
                  : labels.edited
                : null;
            // A ticket thread, not a chat: every message full width, on the left, in the same gray
            // box; the author line says who wrote it.
            return (
              <article key={m.id} className="group">
                <header className="flex items-center gap-2.5 mb-1">
                  <Avatar name={m.authorName} kind={m.fromAgency ? "team" : "client"} size={28} />
                  {/* the role gives way first (it shrinks far faster than the name), so the name keeps its room */}
                  <span className="min-w-0 font-semibold text-ink truncate">{m.mine ? labels.you : m.authorName}</span>
                  <span className="min-w-0 shrink-[100] max-sm:hidden text-[0.8125rem] text-muted truncate whitespace-nowrap">
                    {m.fromAgency ? labels.team : labels.client}
                  </span>
                  {/* reply shows on hover (always on touch screens), left of the time */}
                  <span className="ml-auto flex flex-none items-center gap-1">
                    {closedNotice || m.deleted || editing ? null : (
                      <button
                        type="button"
                        aria-label={labels.reply}
                        title={labels.reply}
                        onClick={() => {
                          setReplyTo({ id: m.id, name: m.authorName, bodyHtml: m.bodyHtml });
                          editorRef.current?.commands.focus("end");
                        }}
                        className={msgAction}
                      >
                        <Icon name="reply" size={14} />
                      </button>
                    )}
                    {m.canEdit && editAction && !editing ? (
                      <button
                        type="button"
                        aria-label={labels.edit}
                        title={labels.edit}
                        disabled={changing}
                        onClick={() => {
                          setChangeError(null);
                          setEditingId(m.id);
                          // the editor is taller than the message: keep it in view
                          requestAnimationFrame(() =>
                            document.getElementById(`msg-${m.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
                          );
                        }}
                        className={msgAction}
                      >
                        <Icon name="pencil" size={14} />
                      </button>
                    ) : null}
                    {m.canDelete && deleteAction && !editing ? (
                      <button
                        type="button"
                        aria-label={labels.delete}
                        title={labels.delete}
                        disabled={changing}
                        onClick={() => remove(m.id)}
                        className={`${msgActionBase} hover:text-danger`}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    ) : null}
                    <span className="text-[0.8125rem] text-muted whitespace-nowrap tabular">
                      <LocalTime iso={m.createdAt} locale={locale} />
                    </span>
                  </span>
                </header>
                <div
                  id={`msg-${m.id}`}
                  className={cn(
                    "sm:ml-[38px] rounded-lg border border-line px-4 py-3 text-[0.90625rem] leading-[1.6] text-ink transition-shadow",
                    bubbleBg,
                  )}
                >
                  {m.replyTo ? (
                    <button
                      type="button"
                      onClick={() => jumpTo(m.replyTo!.id)}
                      className={cn(
                        "block w-full text-left mb-2 rounded border-l-2 border-line-strong px-2.5 py-1.5 text-[0.8125rem] text-muted",
                        quoteBg,
                      )}
                    >
                      <span className="block font-medium text-ink">{m.replyTo.authorName}</span>
                      {m.replyTo.deleted ? (
                        <span className="flex items-center gap-1 italic">
                          <Icon name="ban" size={12} />
                          {labels.deleted}
                        </span>
                      ) : (
                        <span className="block truncate">{m.replyTo.excerpt}</span>
                      )}
                    </button>
                  ) : null}
                  {m.deleted ? (
                    <p className="flex items-center gap-1.5 italic text-muted">
                      <Icon name="ban" size={14} />
                      {labels.deleted}
                    </p>
                  ) : editing ? (
                    <div className="space-y-2">
                      <RichEditor
                        editorRef={editEditorRef}
                        side={editorSide}
                        labels={labels}
                        initialContent={m.bodyHtml}
                        autoFocus
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={changing}
                          onClick={() => {
                            setChangeError(null);
                            setEditingId(null);
                          }}
                          className={buttonClasses("secondary", "sm")}
                        >
                          {labels.cancelEdit}
                        </button>
                        <button type="button" disabled={changing} onClick={() => saveEdit(m.id)} className={buttonClasses("primary", "sm")}>
                          {labels.save}
                        </button>
                      </div>
                    </div>
                  ) : m.bodyHtml ? (
                    <div className="msg-body" dangerouslySetInnerHTML={{ __html: m.bodyHtml }} />
                  ) : null}
                  {/* a message of files only has no text bubble content, just its attachments */}
                  {m.deleted ? null : <MessageAttachments files={m.attachments} labels={fileLabels} />}
                </div>
                {changeError?.id === m.id ? (
                  <p role="alert" className="sm:ml-[38px] mt-1.5 text-[0.8125rem] font-medium text-danger">
                    {changeError.text}
                  </p>
                ) : null}
                {note && !editing ? <p className="sm:ml-[38px] mt-1.5 text-[0.75rem] text-muted">{note}</p> : null}
              </article>
            );
          })}
        </div>
      </div>

      {/* a refusal shows even when the composer is gone, so what was typed is never lost with it */}
      <SendRefusal
        error={state?.error}
        unsent={closedNotice ? state?.unsent : undefined}
        label={labels.unsent}
        className="flex-none sm:ml-[38px] mb-2"
      />

      {/* composer */}
      {closedNotice ? (
        <div className={cn("flex-none sm:ml-[38px] rounded-lg border border-line px-4 py-3 text-center text-muted", bubbleBg)}>
          {closedNotice}
        </div>
      ) : (
        <form
          action={formAction}
          onSubmit={(e) => {
            // wait for the files to finish uploading
            if (uploading) e.preventDefault();
          }}
          className="flex-none space-y-2 sm:ml-[38px]"
        >
          {replyTo ? (
            // the whole message being answered, so it is clearly the right one
            <div className="rounded-md border border-line bg-white text-[0.8125rem]">
              <div className="flex items-center justify-between gap-3 px-3 pt-2">
                <span className="font-medium text-ink truncate">{labels.replyingTo.replace("{name}", replyTo.name)}</span>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  className="inline-flex items-center gap-1 text-muted hover:text-ink flex-none"
                >
                  <Icon name="x" size={14} />
                  {labels.cancelReply}
                </button>
              </div>
              <div
                className="msg-body mx-3 mt-1.5 mb-2.5 max-h-36 overflow-y-auto border-l-2 border-line-strong pl-2.5 text-[0.875rem] leading-[1.55] text-body [&_img]:max-h-24"
                dangerouslySetInnerHTML={{ __html: replyTo.bodyHtml }}
              />
            </div>
          ) : null}
          <input type="hidden" name="replyToId" value={replyTo?.id ?? ""} />
          <input type="hidden" name="attachmentIds" value={pending.flatMap((f) => (f.id ? [f.id] : [])).join(",")} />
          {fileError ? (
            <p role="alert" className="text-[0.8125rem] font-medium text-danger">
              {fileError}
            </p>
          ) : null}
          <PendingFiles files={pending} labels={fileLabels} onRemove={(key) => setPending((list) => list.filter((f) => f.key !== key))} />
          {picker.input}
          <RichEditor
            editorRef={editorRef}
            side={editorSide}
            name="body"
            labels={{ ...labels, placeholder }}
            variant="composer"
            compact={!expanded}
            trailing={
              <span className="flex flex-none items-center gap-1">
                <button
                  type="button"
                  onClick={picker.open}
                  aria-label={fileLabels.attach}
                  title={fileLabels.attach}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:text-ink hover:bg-chip"
                >
                  <Icon name="paperclip" />
                </button>
                <SubmitButton size="sm" className="flex-none" disabled={uploading}>
                  {labels.send}
                </SubmitButton>
              </span>
            }
            onEmptyChange={(empty) => setHasDraft(!empty)}
            onFocusChange={(isFocused) => {
              setFocused(isFocused);
              // writing is about the latest messages: go back to them
              if (isFocused) {
                atBottom.current = true;
                toBottom(true);
              }
            }}
          />
        </form>
      )}
    </div>
  );
}
