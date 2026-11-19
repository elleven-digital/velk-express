"use client";

import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n";
import { Select } from "./ui";

/**
 * The language picker for logged-out pages: a select inside the caller's form; picking one submits the
 * form (the action stores the choice). Without scripts the noscript button does the same.
 */
export function LocaleSelect({ value, label, applyLabel }: { value: Locale; label: string; applyLabel: string }) {
  return (
    <>
      <Select
        name="locale"
        aria-label={label}
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="!h-8 !w-auto !text-[0.875rem]"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </Select>
      <noscript>
        <button type="submit" className="ml-2 text-[0.875rem] underline">
          {applyLabel}
        </button>
      </noscript>
    </>
  );
}
