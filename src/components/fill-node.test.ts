import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fillNode } from "./fill-node";

const render = (template: string, values: Record<string, string>) => renderToStaticMarkup(createElement("p", null, fillNode(template, values)));

describe("fillNode", () => {
  it("keeps replacement patterns and placeholders inside a value as plain text", () => {
    const html = render("{name} logged time at {time}", { name: "Ann $& {time} $' $1", time: "10:00" });
    expect(html).toBe("<p>Ann $&amp; {time} $&#x27; $1 logged time at 10:00</p>");
  });
});
