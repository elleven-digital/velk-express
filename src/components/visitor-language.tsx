"use client";

import { useRef } from "react";
import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n";
import { Select } from "./ui";

/**
 * The language picker of the logged-out pages (login, password): choosing one submits the form,
 * whose action remembers it in this browser and comes back to the same address.
 */
export function VisitorLanguage({
  action,
  value,
  label,
}: {
  action: (formData: FormData) => void | Promise<void>;
  value: Locale;
  label: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const path = useRef<HTMLInputElement>(null);
  return (
    <form ref={form} action={action}>
      <input ref={path} type="hidden" name="path" defaultValue="" />
      <Select
        key={value}
        name="locale"
        aria-label={label}
        defaultValue={value}
        onChange={() => {
          // the address as it is (with its query, e.g. ?next=), to come back to it
          if (path.current) path.current.value = window.location.pathname + window.location.search;
          form.current?.requestSubmit();
        }}
        className="h-8 !w-auto !py-0.5 text-[0.8125rem]"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </Select>
    </form>
  );
}
