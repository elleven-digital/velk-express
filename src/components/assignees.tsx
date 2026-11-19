import type { User } from "@/lib/db";
import { Avatar, cn } from "./ui";

/** Stacked initials of a ticket's assignees; hover shows the names. */
export function AssigneeChips({
  users,
  emptyLabel,
  max = 3,
  className,
}: {
  users: Pick<User, "id" | "name">[];
  emptyLabel?: string;
  max?: number;
  className?: string;
}) {
  if (users.length === 0) {
    return emptyLabel ? <span className="text-muted">{emptyLabel}</span> : null;
  }
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <span className={cn("inline-flex items-center -space-x-1.5", className)} title={users.map((u) => u.name).join(", ")}>
      {shown.map((u) => (
        <Avatar key={u.id} name={u.name} className="ring-2 ring-white" />
      ))}
      {extra > 0 ? (
        <span className="size-6 rounded-full bg-chip text-ink text-[0.6875rem] font-semibold flex items-center justify-center ring-2 ring-white">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
