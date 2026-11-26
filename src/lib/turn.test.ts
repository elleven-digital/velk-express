import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { ticketStatusBadge, whoseTurn } from "./turn";

describe("whoseTurn", () => {
  it("a closed ticket is done", () => {
    expect(whoseTurn({ status: "closed", createdByType: "client" }, "client")).toBe("done");
  });
  it("without messages, a ticket opened by the client is on the agency", () => {
    expect(whoseTurn({ status: "open", createdByType: "client" }, null)).toBe("agency");
    expect(whoseTurn({ status: "open", createdByType: "agency" }, null)).toBe("client");
  });
  it("the last message's author hands the move to the other side", () => {
    expect(whoseTurn({ status: "open", createdByType: "client" }, "agency")).toBe("client");
    expect(whoseTurn({ status: "open", createdByType: "agency" }, "client")).toBe("agency");
  });
});

describe("badges", () => {
  it("status badge is open or closed", () => {
    expect(ticketStatusBadge("open", en).label).toBe(en.tickets.statusOpen);
    expect(ticketStatusBadge("closed", en).tone).toBe("muted");
  });
});
