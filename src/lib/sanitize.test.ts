import { describe, expect, it } from "vitest";
import { htmlToText, inlineImageIds, messageBody, sanitizeMessageHtml } from "./sanitize";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("sanitizeMessageHtml", () => {
  it("removes scripts, with their content", () => {
    const out = sanitizeMessageHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).toBe("<p>hi</p>");
  });

  it("removes event handlers, styles, iframes and other unknown tags", () => {
    const out = sanitizeMessageHtml(
      '<p onclick="x()" style="color:red">a</p><iframe src="https://evil.test"></iframe><object data="x"></object><form action="x"><input></form><svg onload="x()"></svg>',
    );
    expect(out).toBe("<p>a</p>");
  });

  it("removes an image with an error handler", () => {
    expect(sanitizeMessageHtml("<img src=x onerror=alert(1)>")).toBe("");
  });

  it("removes external, data and protocol-relative images", () => {
    expect(sanitizeMessageHtml('<img src="https://evil.test/a.png">')).toBe("");
    expect(sanitizeMessageHtml('<img src="data:image/png;base64,AAAA">')).toBe("");
    expect(sanitizeMessageHtml('<img src="//evil.test/a.png">')).toBe("");
    expect(sanitizeMessageHtml(`<img src="/api/files/${A}/../../x">`)).toBe("");
    expect(sanitizeMessageHtml('<img src="/api/files/not-a-uuid">')).toBe("");
  });

  it("keeps an image of the app's own files and nothing else on it", () => {
    const out = sanitizeMessageHtml(`<img src="/api/files/${A}" alt="a" onerror="x()" style="x">`);
    expect(out).toBe(`<img src="/api/files/${A}" alt="a" />`);
  });

  it("drops a javascript: href but keeps the text", () => {
    const out = sanitizeMessageHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("href");
    expect(out).toContain(">x</a>");
  });

  it.each(["/portal/logout", "#x", "//evil.test/a", "relative/path"])("drops the non-absolute href %s", (href) => {
    const out = sanitizeMessageHtml(`<a href="${href}">x</a>`);
    expect(out).not.toContain("href");
    expect(out).toContain(">x</a>");
  });

  it("keeps an absolute href in any case", () => {
    expect(sanitizeMessageHtml('<a href="HTTPS://ok.test">x</a>')).toContain('href="HTTPS://ok.test"');
  });

  it("opens links safely", () => {
    const out = sanitizeMessageHtml('<a href="https://a.test" target="_self" rel="opener">x</a>');
    expect(out).toContain('href="https://a.test"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain("opener\"");
  });

  it("allows mailto links and the editor's formatting", () => {
    const out = sanitizeMessageHtml('<h2>t</h2><p><strong>b</strong> <em>i</em> <a href="mailto:a@b.test">m</a></p><ul><li>x</li></ul><blockquote>q</blockquote><pre><code>c</code></pre>');
    expect(out).toContain("<h2>t</h2>");
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain('href="mailto:a@b.test"');
    expect(out).toContain("<ul><li>x</li></ul>");
    expect(out).toContain("<pre><code>c</code></pre>");
  });
});

describe("htmlToText", () => {
  it("decodes entities and separates blocks", () => {
    expect(htmlToText("<p>a &amp; b</p><p>c</p>")).toBe("a & b\nc");
    expect(htmlToText("<p>&lt;b&gt;</p>")).toBe("<b>");
  });
});

describe("messageBody", () => {
  it("is null when there is no text and no image", () => {
    expect(messageBody("<p> </p>")).toBeNull();
    expect(messageBody("")).toBeNull();
    expect(messageBody("<script>x</script>")).toBeNull();
  });

  it("is not null with only an image", () => {
    const body = messageBody(`<p><img src="/api/files/${A}"></p>`);
    expect(body).not.toBeNull();
    expect(body?.bodyText).toBe("");
  });

  it("returns the clean html and its text", () => {
    expect(messageBody("<p>Hello <b onclick=x>you</b></p>")).toEqual({
      bodyHtml: "<p>Hello <b>you</b></p>",
      bodyText: "Hello you",
    });
  });
});

describe("inlineImageIds", () => {
  it("lists the uuids in order without repeating", () => {
    const html = `<p><img src="/api/files/${B}"><img src="/api/files/${A}"><img src="/api/files/${B}"></p>`;
    expect(inlineImageIds(html)).toEqual([B, A]);
  });

  it("ignores everything that is not an app file", () => {
    expect(inlineImageIds('<img src="https://x.test/a.png"><a href="/api/files/' + A + '">x</a>')).toEqual([]);
  });
});
