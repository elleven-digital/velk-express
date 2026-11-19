import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_PER_BATCH,
  ATTACHMENT_ACCEPT,
  attachmentMime,
  attachmentName,
  contentDisposition,
  inlineImageMime,
  isPreviewImage,
  opensInline,
  parseFileIds,
} from "./attachments";

describe("attachmentMime", () => {
  it("maps known extensions case-insensitively", () => {
    expect(attachmentMime("a.PDF")).toBe("application/pdf");
    expect(attachmentMime("photo.JPeG")).toBe("image/jpeg");
  });

  it.each(["a.html", "a.htm", "a.svg", "a.js", "a.mjs", "a.xml", "a.xhtml", "a", "a.pdf.html", "a.", ".pdf.exe"])(
    "refuses %j",
    (name) => {
      expect(attachmentMime(name)).toBeNull();
    },
  );

  it("never lists a scriptable type in the picker", () => {
    for (const ext of [".html", ".htm", ".svg", ".js", ".mjs", ".xml", ".xhtml"]) {
      expect(ATTACHMENT_ACCEPT.split(",")).not.toContain(ext);
    }
    expect(ATTACHMENT_ACCEPT.split(",")).toContain(".pdf");
  });
});

describe("inlineImageMime", () => {
  it("accepts only the four web image types", () => {
    expect(inlineImageMime("x.webp")).toBe("image/webp");
    expect(inlineImageMime("x.JPG")).toBe("image/jpeg");
    expect(inlineImageMime("x.png")).toBe("image/png");
    expect(inlineImageMime("x.gif")).toBe("image/gif");
    expect(inlineImageMime("x.pdf")).toBeNull();
    expect(inlineImageMime("x.heic")).toBeNull();
    expect(inlineImageMime("x.svg")).toBeNull();
  });
});

describe("attachmentName", () => {
  it("strips folders, quotes and angle brackets", () => {
    expect(attachmentName('../../ev"il<>.pdf')).toBe("evil.pdf");
    expect(attachmentName("C:\\x\\y\\doc.pdf")).toBe("doc.pdf");
  });

  it("keeps accents", () => {
    expect(attachmentName("relatório final.pdf")).toBe("relatório final.pdf");
  });

  it("cuts long names to 120 characters and keeps the extension", () => {
    const out = attachmentName(`${"a".repeat(200)}.pdf`);
    expect(out).toHaveLength(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("cuts by code points, never leaving half a surrogate pair", () => {
    const out = attachmentName(`${"😀".repeat(200)}.pdf`);
    expect(Array.from(out)).toHaveLength(120);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    const noExt = attachmentName("😀".repeat(200));
    expect(Array.from(noExt)).toHaveLength(120);
  });

  it("applies the same cap to names that start with a dot", () => {
    const out = attachmentName(`.${"a".repeat(300)}`);
    expect(out.startsWith("file.")).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(120);
  });

  it("falls back to a generic name", () => {
    expect(attachmentName("")).toBe("file");
    expect(attachmentName('<>"')).toBe("file");
    expect(attachmentName(".pdf")).toBe("file.pdf");
  });
});

describe("opensInline / isPreviewImage", () => {
  it("opens images, pdf and plain text in the tab", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]) {
      expect(opensInline(m)).toBe(true);
    }
    expect(opensInline("text/html")).toBe(false);
    expect(opensInline("application/zip")).toBe(false);
    expect(isPreviewImage("image/png")).toBe(true);
    expect(isPreviewImage("application/pdf")).toBe(false);
  });
});

describe("contentDisposition", () => {
  it("carries an ascii fallback and the UTF-8 name", () => {
    const h = contentDisposition("relatório.pdf", false);
    expect(h.startsWith('attachment; filename="relat_rio.pdf"')).toBe(true);
    expect(h).toContain("filename*=UTF-8''relat%C3%B3rio.pdf");
    expect(contentDisposition("a.pdf", true).startsWith("inline;")).toBe(true);
  });
});

describe("parseFileIds", () => {
  it("dedupes and drops blanks", () => {
    expect(parseFileIds("a,b,a, ,c")).toEqual(["a", "b", "c"]);
    expect(parseFileIds(null)).toEqual([]);
    expect(parseFileIds(undefined)).toEqual([]);
  });

  it("returns at most one more than a batch, so callers can detect overflow", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `id${i}`).join(",");
    expect(parseFileIds(raw)).toHaveLength(ATTACHMENTS_PER_BATCH + 1);
  });
});
