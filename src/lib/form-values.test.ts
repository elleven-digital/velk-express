import { describe, expect, it } from "vitest";
import { formValues } from "./form-values";

describe("formValues", () => {
  it("returns only the requested keys", () => {
    const fd = new FormData();
    fd.set("name", "Acme");
    fd.set("password", "secret");
    expect(formValues(fd, ["name"])).toEqual({ name: "Acme" });
  });

  it("skips files and missing keys", () => {
    const fd = new FormData();
    fd.set("logo", new File(["x"], "logo.png"));
    fd.set("name", "Acme");
    expect(formValues(fd, ["logo", "name", "absent"])).toEqual({ name: "Acme" });
  });

  it("keeps an empty string", () => {
    const fd = new FormData();
    fd.set("notes", "");
    expect(formValues(fd, ["notes"])).toEqual({ notes: "" });
  });

  it("cuts a 20 000 character value to 10 000", () => {
    const fd = new FormData();
    fd.set("notes", "a".repeat(20_000));
    expect(formValues(fd, ["notes"]).notes).toHaveLength(10_000);
  });
});
