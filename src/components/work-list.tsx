import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { labelColorOf } from "@/lib/labels";
import { AssigneeChips } from "./assignees";
import { Icon } from "./icons";
import { Avatar, Badge, buttonClasses, Card, cn, MetaLine, type BadgeTone } from "./ui";

/** A box of rows split by lines. */
export function WorkList({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cn("divide-y divide-line overflow-hidden", className)}>{children}</Card>;
}

/**
 * A label's color as the `--label` CSS variable, for the pill and dot classes below. Any hex
 * works: the pill is only a light tint of it and the text stays dark, so it reads on every color.
 */
export function labelVars(color: string | null | undefined): CSSProperties {
  return { "--label": labelColorOf(color) } as CSSProperties;
}
export const LABEL_PILL =
  "border-[color-mix(in_srgb,var(--label)_45%,var(--color-line-strong))] bg-[color-mix(in_srgb,var(--label)_12%,white)] text-ink";
export const LABEL_DOT = "rounded-full bg-[var(--label)] ring-1 ring-inset ring-black/10";

/** One label: a pill tinted with its color, with the color dot. */
export function LabelChip({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  return (
    <span
      style={labelVars(color)}
      className={cn(
        "inline-flex items-center gap-1.5 h-[22px] max-w-full px-2 rounded-full border text-[0.75rem] font-normal leading-none whitespace-nowrap",
        LABEL_PILL,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 flex-none", LABEL_DOT)} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A ticket's labels in a row: the first `max`, then "+N". */
export function LabelChips({
  labels,
  max = 3,
  className,
}: {
  labels: { id: string; name: string; color: string | null }[];
  max?: number;
  className?: string;
}) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className={cn("inline-flex items-center gap-1 min-w-0", className)}>
      {shown.map((l) => (
        <LabelChip key={l.id} name={l.name} color={l.color} className="max-w-40" />
      ))}
      {rest > 0 ? (
        <span className="text-[0.75rem] text-muted tabular" title={labels.slice(max).map((l) => l.name).join(", ")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** A bubble with the unread message count; nothing at zero. */
export function UnreadCount({ n, label, className }: { n: number; label: string; className?: string }) {
  if (n <= 0) return null;
  return (
    <span
      title={label}
      className={cn(
        "inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-dot-info text-[0.75rem] font-semibold leading-none text-white tabular",
        className,
      )}
    >
      <span aria-hidden="true">{n > 99 ? "99+" : n}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * One ticket of the team panel's list. Left: the unread bubble (only when there is something new),
 * "client – title" with the labels, and under it the number, the site and "recurring support".
 * Then who is responsible, one per line, and last when it moved with its status under it. The
 * whole row opens `href`. On phones the people column becomes stacked initials and the date and
 * status go under the text.
 */
export function TicketRow({
  href,
  unread,
  client,
  title,
  number,
  site,
  support,
  tags,
  assignees,
  noAssignees,
  when,
  status,
}: {
  href: string;
  unread?: { n: number; label: string };
  client: string;
  title: string;
  number: number;
  /** The site's name; the general label for a ticket without one. */
  site: string;
  /** "Recurring support", for tickets under the support plan. */
  support?: string | null;
  /** Beside the title (the ticket's labels). */
  tags?: ReactNode;
  assignees: { id: string; name: string }[];
  noAssignees: string;
  when: ReactNode;
  status: { tone: BadgeTone; label: string };
}) {
  const hasUnread = Boolean(unread && unread.n > 0);
  return (
    <div className="relative flex flex-wrap md:flex-nowrap items-center gap-x-5 gap-y-2 min-h-16 px-3.5 sm:px-4 py-3 hover:bg-paper transition-colors">
      <div className="flex items-center gap-3 min-w-0 basis-full md:basis-auto md:flex-1">
        {hasUnread ? <UnreadCount n={unread!.n} label={unread!.label} className="flex-none" /> : null}
        <div className="min-w-0 flex-1">
          {/* phones: the labels wrap under the title instead of being cut */}
          <div className="flex max-md:flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <Link href={href} className="shrink-0 max-w-full truncate text-ink after:absolute after:inset-0 after:content-['']">
              <span>{client}</span>
              <span aria-hidden="true" className="text-muted mx-1.5">
                –
              </span>
              <span className="font-medium">{title}</span>
            </Link>
            {tags ? <div className="min-w-0 flex items-center overflow-hidden">{tags}</div> : null}
          </div>
          <MetaLine className="mt-0.5 truncate">
            <span className="tabular">#{number}</span>
            {site}
            {support ? support : null}
          </MetaLine>
        </div>
      </div>
      <div className="hidden md:block w-48 flex-none min-w-0">
        {assignees.length === 0 ? (
          <span className="text-muted">{noAssignees}</span>
        ) : (
          <ul className="space-y-1">
            {assignees.map((a) => (
              <li key={a.id} className="flex items-center gap-2 min-w-0">
                <Avatar name={a.name} className="flex-none" />
                <span className="truncate text-ink">{a.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        className={cn(
          "flex md:flex-col md:items-end items-center gap-x-3 gap-y-0.5 md:w-32 flex-none text-muted whitespace-nowrap max-md:text-[0.8125rem]",
          hasUnread && "max-md:pl-8",
        )}
      >
        <span>{when}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <AssigneeChips users={assignees} className="md:hidden" />
      </div>
    </div>
  );
}

/**
 * One ticket of the client portal's list: the title with its number and site under it, then when
 * it moved and whose turn it is. The whole row opens `href`; the portal shows no people or labels.
 */
export function PortalTicketRow({
  href,
  title,
  number,
  site,
  when,
  status,
}: {
  href: string;
  title: string;
  number: number;
  /** The site's name; the general label for a ticket without one. */
  site: string;
  when: ReactNode;
  status: { tone: BadgeTone; label: string };
}) {
  return (
    <div className="relative flex flex-wrap sm:flex-nowrap items-center gap-x-5 gap-y-2 min-h-16 px-3.5 sm:px-4 py-3 hover:bg-paper transition-colors">
      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
        <Link href={href} className="block truncate font-medium text-ink after:absolute after:inset-0 after:content-['']">
          {title}
        </Link>
        <MetaLine className="mt-0.5 truncate">
          <span className="tabular">#{number}</span>
          {site}
        </MetaLine>
      </div>
      <div className="flex sm:flex-col sm:items-end items-center gap-x-3 gap-y-0.5 sm:w-32 flex-none text-muted whitespace-nowrap max-sm:text-[0.8125rem]">
        <span>{when}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
    </div>
  );
}

/**
 * One proposal of the client portal: a task on the home ("needs you") or a line of the proposals
 * list. The whole row opens the public page; the button is the same link, raised above the
 * row's overlay. On phones the quiet "view" button is dropped, since the row itself is the link.
 */
export function ProposalRow({
  href,
  title,
  meta,
  status,
  action,
  primary,
}: {
  href: string;
  title: string;
  /** The amounts and the date, already formatted. */
  meta: ReactNode;
  status?: { tone: BadgeTone; label: string };
  action: string;
  /** Awaiting the client: the black button, shown on every width. */
  primary: boolean;
}) {
  return (
    <div className="relative flex flex-wrap sm:flex-nowrap items-center gap-x-5 gap-y-2 min-h-16 px-3.5 sm:px-4 py-3 hover:bg-paper transition-colors">
      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <Link href={href} className="truncate font-medium text-ink after:absolute after:inset-0 after:content-['']">
            {title}
          </Link>
          {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
        </div>
        <MetaLine className="mt-0.5">{meta}</MetaLine>
      </div>
      <div className={cn("flex-none", !primary && "max-sm:hidden")}>
        <Link href={href} className={cn("relative", buttonClasses(primary ? "primary" : "ghost", "sm"))}>
          {action}
        </Link>
      </div>
    </div>
  );
}

/**
 * A charge waiting on the client, as a task on the portal home: the title and the amount, and a
 * "Pay" button to the charge's own pay link, which opens in a new tab.
 */
export function PaymentTaskRow({
  href,
  title,
  meta,
  action,
}: {
  href: string;
  title: string;
  meta: ReactNode;
  action: string;
}) {
  return (
    <div className="relative flex flex-wrap sm:flex-nowrap items-center gap-x-5 gap-y-2 min-h-16 px-3.5 sm:px-4 py-3 hover:bg-paper transition-colors">
      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-medium text-ink after:absolute after:inset-0 after:content-['']"
        >
          {title}
        </a>
        <MetaLine className="mt-0.5">{meta}</MetaLine>
      </div>
      <div className="flex-none">
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn("relative", buttonClasses("primary", "sm"))}>
          {action}
        </a>
      </div>
    </div>
  );
}

/** The quiet green row of the portal home: nothing waits on the person. */
export function AllClearRow({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex items-center gap-3 min-h-16 px-3.5 sm:px-4 py-3">
      <span aria-hidden="true" className="flex-none grid size-8 place-items-center rounded-full bg-ok-soft text-ok-deep">
        <Icon name="check" size={16} />
      </span>
      <div className="min-w-0">
        <div className="font-medium text-ink">{title}</div>
        <div className="text-[0.875rem] text-muted">{text}</div>
      </div>
    </div>
  );
}
