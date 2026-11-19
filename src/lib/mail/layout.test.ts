import { describe, expect, it } from "vitest";
import { renderMailLayout } from "./layout";

const base = { agencyName: "Acme", logoUrl: null, heading: "Welcome", bodyHtml: "<p>Hello <b>there</b></p>", footer: "Sent by Acme" };

describe("renderMailLayout", () => {
  it("escapes HTML in agencyName, heading, footer and button label", () => {
    const { html } = renderMailLayout({
      ...base,
      agencyName: "<script>a</script>",
      heading: "<img onerror=x>",
      footer: "<i>f</i>",
      button: { label: "<u>go</u>", url: "https://x.test/" },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("<i>f</i>");
    expect(html).not.toContain("<u>go</u>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });

  it("inserts bodyHtml as-is and escapes the button URL for attributes", () => {
    const { html } = renderMailLayout({ ...base, button: { label: "Go", url: 'https://x.test/?a=1&b="2"' } });
    expect(html).toContain("<p>Hello <b>there</b></p>");
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });

  it("puts the button URL and stripped body in the text version", () => {
    const { text } = renderMailLayout({ ...base, button: { label: "Open", url: "https://x.test/a?b=1" } });
    expect(text).toContain("Open: https://x.test/a?b=1");
    expect(text).toContain("Hello there");
    expect(text).not.toContain("<");
    expect(text).toContain("Welcome");
    expect(text).toContain("Sent by Acme");
  });

  it("shows the logo image when provided and the name otherwise, with no platform branding", () => {
    const withLogo = renderMailLayout({ ...base, logoUrl: "https://x.test/logo.png" }).html;
    expect(withLogo).toContain('<img src="https://x.test/logo.png"');
    const without = renderMailLayout(base).html;
    expect(without).not.toContain("<img");
    expect(without).toContain("Acme");
    expect(without.toLowerCase()).not.toContain("velk");
  });

  it("omits the button when none is given", () => {
    expect(renderMailLayout(base).html).not.toContain("<a ");
  });
});
