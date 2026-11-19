"use client";

import { useRef } from "react";
import { Select } from "@/components/ui";

/**
 * The company picker of a person who belongs to several: choosing one submits the form of the
 * switch action. The action itself checks that the person is a member of the chosen company.
 */
export function CompanySwitcher({
  action,
  companies,
  currentId,
  label,
}: {
  action: (formData: FormData) => void | Promise<void>;
  companies: { id: string; name: string }[];
  currentId: string;
  label: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={action}>
      <Select
        // remounts when the active company changes, so the shown value follows
        key={currentId}
        name="clientId"
        aria-label={label}
        defaultValue={currentId}
        onChange={() => form.current?.requestSubmit()}
        className="h-9 !py-1"
      >
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </form>
  );
}
