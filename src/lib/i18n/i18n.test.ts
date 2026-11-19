import { describe, expect, it } from "vitest";
import { en } from "./en";
import { es } from "./es";
import { pt } from "./pt";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  fmt,
  getDict,
  isLocale,
  localeCookieOptions,
  lookup,
  type Locale,
} from "./index";
import { localeFromAcceptLanguage } from "./server";

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

describe("fmt", () => {
  it("replaces placeholders", () => {
    expect(fmt("Hi {name}", { name: "Ana" })).toBe("Hi Ana");
    expect(fmt("{n} items", { n: 3 })).toBe("3 items");
  });

  it("keeps a missing key as {x}", () => {
    expect(fmt("Hi {x}", {})).toBe("Hi {x}");
  });
});

describe("locales", () => {
  it("exposes en, pt, es with en as default", () => {
    expect([...LOCALES]).toEqual(["en", "pt", "es"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual(["en", "es", "pt"]);
  });

  it("isLocale narrows only supported codes", () => {
    expect(isLocale("pt")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
});

describe("getDict", () => {
  it("returns each locale's dictionary", async () => {
    expect(await getDict("en")).toBe(en);
    expect(await getDict("pt")).toBe(pt);
    expect(await getDict("es")).toBe(es);
  });

  it("falls back to en for an unknown locale", async () => {
    expect(await getDict("xx" as Locale)).toBe(en);
  });

  it("caches loaded dictionaries", async () => {
    expect(await getDict("pt")).toBe(await getDict("pt"));
  });
});

describe("dictionary parity", () => {
  const flatEn = flatten(en);

  it("pt and es have exactly the keys of en", () => {
    const keys = Object.keys(flatEn).sort();
    expect(Object.keys(flatten(pt)).sort()).toEqual(keys);
    expect(Object.keys(flatten(es)).sort()).toEqual(keys);
  });

  it("has no empty values", () => {
    for (const dict of [en, pt, es]) {
      for (const [key, value] of Object.entries(flatten(dict))) {
        expect(typeof value, key).toBe("string");
        expect((value as string).trim(), key).not.toBe("");
      }
    }
  });
});

describe("localeFromAcceptLanguage", () => {
  it("picks the first supported code in header order", () => {
    expect(localeFromAcceptLanguage("pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt");
    expect(localeFromAcceptLanguage("fr-FR,es;q=0.5")).toBe("es");
  });

  it("returns null when nothing is supported", () => {
    expect(localeFromAcceptLanguage("")).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
    expect(localeFromAcceptLanguage("de")).toBeNull();
  });
});

describe("lookup", () => {
  const map = { a: "A", b: "B" };
  it("finds own keys only", () => {
    expect(lookup(map, "a")).toBe("A");
    expect(lookup(map, "missing")).toBeUndefined();
    expect(lookup(map, undefined)).toBeUndefined();
  });
  it("ignores inherited members", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(lookup(map, key)).toBeUndefined();
  });
});

describe("localeCookieOptions", () => {
  it("is secure only on an https address", () => {
    expect(localeCookieOptions(true)).toMatchObject({ secure: true, sameSite: "lax", path: "/" });
    expect(localeCookieOptions(false).secure).toBe(false);
  });
});
