import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SendRefusal } from "./send-refusal";

const render = (props: Parameters<typeof SendRefusal>[0]) => renderToStaticMarkup(createElement(SendRefusal, props));

describe("SendRefusal", () => {
  it("renders nothing without an error", () => {
    expect(render({ label: "Not sent", unsent: "text" })).toBe("");
  });

  it("shows the error alone when there is no unsent text", () => {
    const html = render({ error: "This ticket is closed.", label: "Not sent" });
    expect(html).toContain("This ticket is closed.");
    expect(html).not.toContain("Not sent");
  });

  it("shows the unsent text as escaped text, under its label", () => {
    const html = render({ error: "Closed.", label: "Your message was not sent", unsent: "line one\n<b>line</b> two" });
    expect(html).toContain("Your message was not sent");
    expect(html).toContain("line one\n&lt;b&gt;line&lt;/b&gt; two");
    expect(html).not.toContain("<b>");
  });
});
