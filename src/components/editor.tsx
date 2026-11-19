"use client";

import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { INLINE_IMAGE_ACCEPT, INLINE_IMAGE_MAX_BYTES } from "@/lib/attachments";
import { Icon } from "./icons";
import { cn } from "./ui";

export type EditorLabels = {
  placeholder: string;
  uploadError: string;
  /** Shown when the server refuses the upload for the rate limit (HTTP 429). */
  uploadLimit?: string;
  bold: string;
  italic: string;
  list: string;
  link: string;
  image: string;
};

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "size-7 rounded-md flex items-center justify-center text-[0.8125rem] font-semibold transition-colors",
        active ? "bg-chip text-ink" : "text-muted hover:text-ink hover:bg-chip",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The rich text field of tickets and messages. With `name`, the HTML rides along with the form in
 * a hidden field, kept current as people type; the editor itself is not reset by the form, so an
 * error never costs the text. The image button uploads to `/api/upload` as an inline image of
 * `side`'s session (the file is the raw request body).
 */
export function RichEditor({
  editorRef,
  side,
  labels,
  name,
  initialContent,
  autoFocus,
  minHeight,
  compact = false,
  onEmptyChange,
  onFocusChange,
  variant = "field",
  trailing,
}: {
  editorRef: MutableRefObject<Editor | null>;
  side: "team" | "portal";
  labels: EditorLabels;
  name?: string;
  /** HTML the field starts with (editing a message). Read once, on mount. */
  initialContent?: string;
  autoFocus?: boolean;
  minHeight?: number;
  /** One line without the toolbar (the reply box at rest). */
  compact?: boolean;
  /** Called when the field goes from empty to filled and back. */
  onEmptyChange?: (empty: boolean) => void;
  /** Called when the field gains or loses focus. */
  onFocusChange?: (focused: boolean) => void;
  /** "field": a form field with its toolbar on top. "composer": the reply box, with `trailing` inside it. */
  variant?: "field" | "composer";
  trailing?: ReactNode;
}) {
  const [, setTick] = useState(0);
  const [html, setHtml] = useState(initialContent ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  // useEditor keeps its first options; read the latest callback through a ref.
  const emptyChange = useRef(onEmptyChange);
  const focusChange = useRef(onFocusChange);
  useEffect(() => {
    emptyChange.current = onEmptyChange;
    focusChange.current = onFocusChange;
  }, [onEmptyChange, onFocusChange]);

  const editor = useEditor({
    onFocus: () => focusChange.current?.(true),
    onBlur: () => focusChange.current?.(false),
    onUpdate: ({ editor: e }) => {
      setHtml(e.isEmpty ? "" : e.getHTML());
      emptyChange.current?.(e.isEmpty);
    },
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      Image,
      Placeholder.configure({ placeholder: labels.placeholder }),
    ],
    content: initialContent ?? "",
    autofocus: autoFocus ? "end" : false,
    onTransaction: () => setTick((t) => t + 1),
  });

  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);

  async function uploadImage(file: File) {
    try {
      if (file.size > INLINE_IMAGE_MAX_BYTES) throw new Error("too large");
      const res = await fetch(`/api/upload?side=${side}&purpose=inline`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      if (res.status === 429) {
        window.alert(labels.uploadLimit ?? labels.uploadError);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const { url } = (await res.json()) as { url: string };
      editor?.chain().focus().setImage({ src: url }).run();
    } catch {
      window.alert(labels.uploadError);
    }
  }

  function promptLink() {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  const composer = variant === "composer";
  const tools = (
    <div
      className={cn(
        "flex items-center gap-0.5",
        composer ? "pb-1.5 mb-1.5 border-b border-line" : "border-b border-line px-1.5 py-1",
        compact && "hidden",
      )}
    >
      <ToolButton title={labels.bold} active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>
        B
      </ToolButton>
      <ToolButton title={labels.italic} active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>
        <span className="italic font-serif">I</span>
      </ToolButton>
      <ToolButton title={labels.list} active={editor?.isActive("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
        <Icon name="list" />
      </ToolButton>
      <ToolButton title={labels.link} active={editor?.isActive("link")} onClick={promptLink}>
        <Icon name="link" />
      </ToolButton>
      <ToolButton title={labels.image} onClick={() => fileRef.current?.click()}>
        <Icon name="image" />
      </ToolButton>
      <input
        ref={fileRef}
        type="file"
        accept={INLINE_IMAGE_ACCEPT}
        className="hidden"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadImage(file);
          e.target.value = "";
        }}
      />
    </div>
  );

  const content = (
    <EditorContent
      editor={editor}
      style={minHeight ? ({ "--mh": `${minHeight}px` } as CSSProperties) : undefined}
      className={cn(
        composer && "flex-1 min-w-0 [&_.tiptap]:px-2 [&_.tiptap]:py-1.5 [&_.tiptap]:text-[0.90625rem]",
        composer && !compact && "[&_.tiptap]:min-h-[84px]",
        Boolean(minHeight) && !compact && "[&_.tiptap]:min-h-[var(--mh)]",
        // one line: a draft shows only its start until the field is focused again
        compact &&
          "[&_.tiptap]:min-h-0 [&_.tiptap]:max-h-8 [&_.tiptap]:overflow-hidden [&_.tiptap]:py-1.5 [&_.tiptap]:px-2 [&_.is-editor-empty::before]:w-full [&_.is-editor-empty::before]:h-auto [&_.is-editor-empty::before]:overflow-hidden [&_.is-editor-empty::before]:text-ellipsis [&_.is-editor-empty::before]:whitespace-nowrap",
      )}
    />
  );

  const hidden = name ? <input type="hidden" name={name} value={html} /> : null;

  if (composer) {
    return (
      <div className="rounded-lg border border-line-strong/60 bg-white p-2 transition-[border-color,box-shadow] focus-within:border-[#a8a8a8] focus-within:shadow-[0_0_0_4px_rgb(0_0_0/0.06)]">
        {hidden}
        {tools}
        <div className="flex items-end gap-2">
          {content}
          {trailing}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-field border border-line bg-white transition-[border-color,box-shadow] hover:border-line-strong focus-within:!border-[#8f8f8f] focus-within:shadow-[0_0_0_3px_rgb(0_0_0/0.08)]">
      {hidden}
      {tools}
      {content}
    </div>
  );
}
