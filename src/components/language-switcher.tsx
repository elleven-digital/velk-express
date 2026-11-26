"use client";

import { useRef } from "react";
import { usePathname } from "next/navigation";
import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n";
import { Select } from "./ui";

/**
 * The signed-in person's own language, under their name in the sidebar: the agency's (empty) or
 * one of the supported ones. Choosing submits the form; the action saves it and comes back here.
 */
export function LanguageSwitcher({
  action,
  value,
  agencyLocale,
  labels,
}: {
  action: (formData: FormData) => void | Promise<void>;
  /** The person's own choice, or null when they follow the agency's. */
  value: Locale | null;
  agencyLocale: Locale;
  labels: { language: string; agency: string };
}) {
  const form = useRef<HTMLFormElement>(null);
  const path = usePathname();
  return (
    <form ref={form} action={action} className="flex items-center gap-2">
      <input type="hidden" name="path" value={path} />
      <span className="flex-none text-[0.8125rem] text-muted">{labels.language}</span>
      <Select
        // remounts when the saved value changes, so the shown value follows
        key={value ?? ""}
        name="locale"
        aria-label={labels.language}
        defaultValue={value ?? ""}
        onChange={() => form.current?.requestSubmit()}
        className="h-8 !py-0.5 min-w-0 text-[0.8125rem]"
      >
        <option value="">{labels.agency.replace("{language}", LOCALE_NAMES[agencyLocale])}</option>
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </Select>
    </form>
  );
}
