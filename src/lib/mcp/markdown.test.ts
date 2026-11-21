import { describe, expect, it } from "vitest";
import { markdownToHtml } from "@/lib/mcp/markdown";

describe("markdownToHtml", () => {
  it("makes paragraphs and line breaks", () => {
    expect(markdownToHtml("Oi Marina,\ntudo certo.\n\nAbraço")).toBe("<p>Oi Marina,<br>tudo certo.</p><p>Abraço</p>");
  });

  it("supports bold, italic, code and links", () => {
    expect(markdownToHtml("**novo** banner e *ajuste* no `header`, veja [aqui](https://cafe.example/x)")).toBe(
      '<p><strong>novo</strong> banner e <em>ajuste</em> no <code>header</code>, veja <a href="https://cafe.example/x">aqui</a></p>'
    );
  });

  it("supports lists, quotes, headings and code blocks", () => {
    expect(markdownToHtml("- um\n- dois")).toBe("<ul><li><p>um</p></li><li><p>dois</p></li></ul>");
    expect(markdownToHtml("1. um\n2. dois")).toBe("<ol><li><p>um</p></li><li><p>dois</p></li></ol>");
    expect(markdownToHtml("> citado")).toBe("<blockquote><p>citado</p></blockquote>");
    expect(markdownToHtml("## Próximos passos")).toBe("<h2>Próximos passos</h2>");
    expect(markdownToHtml("```\n<div>\n```")).toBe("<pre><code>&lt;div&gt;</code></pre>");
  });

  it("escapes whatever HTML the text carries", () => {
    expect(markdownToHtml('<img src=x onerror="alert(1)">')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>"
    );
  });

  it("only links http(s) and mailto", () => {
    expect(markdownToHtml("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
  });

  it("leaves snake_case words alone", () => {
    expect(markdownToHtml("use client_id e redirect_uri")).toBe("<p>use client_id e redirect_uri</p>");
  });
});
