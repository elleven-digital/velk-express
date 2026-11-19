"use client";

import { useRouter } from "next/navigation";
import { Select } from "./ui";

/** A select that goes to the chosen option's address (the list's filters live in the URL). */
export function FilterSelect({
  options,
  value,
  ariaLabel,
}: {
  options: { href: string; label: string; value: string }[];
  value: string;
  ariaLabel: string;
}) {
  const router = useRouter();
  return (
    <Select
      aria-label={ariaLabel}
      value={value}
      className="!h-8 !py-0 w-auto max-w-56 text-[0.875rem]"
      onChange={(e) => {
        const next = options.find((o) => o.value === e.target.value);
        if (next) router.push(next.href);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
