/*
 * Ticket attachments: which files are accepted and how they are named and
 * served. Pure, so the upload route, the core and the tests share it.
 *
 * The type comes from the file's extension, never from what the browser
 * says, and only from this list: documents, spreadsheets, slides, text,
 * archives and images. No HTML, SVG or scripts: a file opened from the app
 * must never run in its origin.
 */

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Images pasted or dropped into a message body. */
export const INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Files one message (or one "attach" click) may carry. */
export const ATTACHMENTS_PER_BATCH = 10;

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  key: "application/vnd.apple.keynote",
  pages: "application/vnd.apple.pages",
  numbers: "application/vnd.apple.numbers",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ai: "application/postscript",
  eps: "application/postscript",
  psd: "image/vnd.adobe.photoshop",
  fig: "application/octet-stream",
  sketch: "application/octet-stream",
  xd: "application/octet-stream",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

const INLINE_IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** For the file picker's `accept`. */
export const ATTACHMENT_ACCEPT = Object.keys(TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export const INLINE_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

function extensionOf(fileName: string): string | null {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName.trim());
  return match ? match[1].toLowerCase() : null;
}

/** The file's type from its extension, or null when it isn't accepted. */
export function attachmentMime(fileName: string): string | null {
  const ext = extensionOf(fileName);
  return ext ? (Object.hasOwn(TYPES, ext) ? TYPES[ext] : null) : null;
}

/** The type of an image meant for a message body (png, jpg, gif, webp), or null. */
export function inlineImageMime(fileName: string): string | null {
  const ext = extensionOf(fileName);
  return ext && INLINE_IMAGE_TYPES.has(ext) ? TYPES[ext] : null;
}

/** The fiscal document of a charge: PDF or image, up to 8 MB. */
export const DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_MIMES: readonly string[] = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
export const DOCUMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";

/** The type of a fiscal document from its extension (pdf, png, jpg, jpeg, webp), or null. */
export function documentMime(fileName: string): string | null {
  const mime = attachmentMime(fileName);
  return mime && DOCUMENT_MIMES.includes(mime) ? mime : null;
}

const NAME_MAX = 120;

/**
 * The name as people gave it, minus what could break a path or a header:
 * folders, control characters, quotes and slashes. Accents stay. Long names
 * keep their extension.
 */
export function attachmentName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = !clean || clean.startsWith(".") ? `file${clean}` : clean;
  if (Array.from(name).length <= NAME_MAX) return name;
  // Cut by code points (never in the middle of a surrogate pair) and keep a sane extension.
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  return Array.from(stem).slice(0, NAME_MAX - Array.from(ext).length).join("") + ext;
}

/** Opened in the browser tab (images, PDF, plain text); everything else downloads. */
export function opensInline(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"].includes(mime);
}

/** Shown as a thumbnail in the conversation. */
export function isPreviewImage(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
}

/** `Content-Disposition` with the real name (RFC 6266, UTF-8). */
export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * alone, but RFC 5987 does not allow them in the value.
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The ids of a form field ("a,b,c"), deduplicated, at most one batch plus one (so callers can spot overflow). */
export function parseFileIds(raw: string | null | undefined): string[] {
  const ids = [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  return ids.slice(0, ATTACHMENTS_PER_BATCH + 1);
}
