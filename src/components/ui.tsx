import Link from "next/link";
import { Children, Fragment, isValidElement, type ComponentProps, type ReactNode } from "react";
import { PageCrumb } from "./crumbs";
import { Icon, type IconName } from "./icons";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- buttons ----------
// Geist's sizes: 32, 36 and 40px tall, 6px corners (8px on the large one),
// weight 500; the color changes on hover, nothing moves. The primary button
// is black, so a screen has one main action; the rest is white with a 1px
// line, or bare.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ink";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md"
): string {
  const base =
    "inline-flex items-center justify-center gap-1.5 border font-medium whitespace-nowrap select-none transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none";
  const sizes = {
    sm: "h-8 px-2.5 rounded-md text-[0.875rem]",
    md: "h-9 px-3 rounded-md text-[0.875rem]",
    lg: "h-10 px-4 rounded-lg text-[0.875rem]",
  }[size];
  const variants = {
    primary: "border-transparent bg-accent text-on-accent hover:bg-accent-hover",
    secondary:
      "border-line bg-white text-ink hover:bg-chip",
    // text-body (#171717): a lower-sorting color class, so
    // a `text-danger` / `text-muted` passed in className still wins
    ghost: "border-transparent text-body hover:bg-chip hover:text-ink",
    danger: "border-line bg-white text-danger hover:bg-danger-soft hover:border-danger/25",
    ink: "border-transparent bg-ink text-white hover:bg-ink/85",
  }[variant];
  return cn(base, sizes, variants);
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <Link
      {...props}
      className={cn(buttonClasses(variant, size), className)}
    />
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      {...props}
      className={cn(buttonClasses(variant, size), className)}
    />
  );
}

// ---------- surfaces ----------
// White with one 1px line and 8px corners; hierarchy comes from type, not
// from shadows. Lists inside a Card are split by lines (`divide-y`).

export function Card({
  className,
  children,
  id,
}: {
  className?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "bg-white border border-line rounded-card",
        className
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("text-[1rem] leading-snug font-semibold tracking-[-0.01em] text-ink", className)}>
      {children}
    </h2>
  );
}

/** A number of things waiting, next to a heading or a nav item. */
export function Count({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-line text-[0.75rem] font-medium leading-none text-ink tabular",
        className
      )}
    >
      {n}
    </span>
  );
}

/** A section's heading, with an optional count and a link or action on the right. */
export function SectionHead({
  title,
  count,
  action,
  id,
  className,
}: {
  title: ReactNode;
  count?: number;
  action?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 mb-3", className)}>
      <h2 id={id} className="flex items-center gap-2 text-[1rem] leading-snug font-semibold tracking-[-0.01em] text-ink">
        {title}
        {count ? <Count n={count} /> : null}
      </h2>
      {action}
    </div>
  );
}

/** "View all" and the like: dark text, underlined on hover. */
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-[0.875rem] font-medium text-ink hover:underline underline-offset-[3px] whitespace-nowrap"
    >
      {children}
    </Link>
  );
}

/** Small context line above a title (what this page is), in sentence case. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <div className="text-[0.8125rem] font-medium text-muted">
      {children}
    </div>
  );
}

function flatFacts(children: ReactNode): ReactNode[] {
  // a fragment (`meta={<>…</>}`) counts as its children
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flatFacts(child.props.children)
      : [child]
  );
}

/**
 * Facts in one line split by thin rules ("Your turn | Support | Acme Studio").
 * A fact that wraps starts its line without a rule (see `.meta`).
 */
export function MetaLine({ children, className }: { children: ReactNode; className?: string }) {
  // each fact in its own plain span, so the rule never lands inside a Badge
  const facts = flatFacts(children);
  return (
    <div className={cn("meta text-[0.875rem] text-muted", className)}>
      <div>
        {facts.map((fact, i) => (
          <span key={i}>{fact}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * The page's title block. A string title also names the page in the top
 * bar's breadcrumb (`crumb` overrides it; null leaves the bar alone).
 */
export function PageHeader({
  title,
  sub,
  meta,
  actions,
  crumb,
  actionsBeside = false,
  back,
  titleAside,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** Facts under the title, as MetaLine children. */
  meta?: ReactNode;
  actions?: ReactNode;
  crumb?: string | null;
  /** The actions on the title's own line, with the facts running the full width under both. */
  actionsBeside?: boolean;
  /** With `actionsBeside`: a back arrow left of the title, to where the page came from. */
  back?: { href: string; label: string };
  /** With `actionsBeside`: something kept right of the title on every width (actions wrap under on phones). */
  titleAside?: ReactNode;
}) {
  const crumbLabel = crumb === undefined ? (typeof title === "string" ? title : null) : crumb;
  if (actionsBeside) {
    return (
      // on phones the conversation under it needs the room
      <header className="mb-6 max-lg:mb-3">
        {crumbLabel ? <PageCrumb label={crumbLabel} /> : null}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            {back ? (
              <Link
                href={back.href}
                aria-label={back.label}
                title={back.label}
                className="-ml-1.5 mt-px inline-flex size-8 flex-none items-center justify-center rounded-field text-muted transition-colors hover:bg-paper hover:text-ink sm:mt-0.5"
              >
                <Icon name="chevron" size={20} className="rotate-90" />
              </Link>
            ) : null}
            <h1 className="min-w-0 flex-1 text-[1.5rem] sm:text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.025em] text-ink">
              {title}
            </h1>
            {titleAside ? <div className="flex-none">{titleAside}</div> : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:*:flex-1 max-sm:[&_:is(a,button)]:w-full">{actions}</div>
          ) : null}
        </div>
        {sub ? <p className="text-muted text-[0.875rem] mt-1.5 max-w-[62ch]">{sub}</p> : null}
        {meta ? <MetaLine className="mt-2.5">{meta}</MetaLine> : null}
      </header>
    );
  }
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 mb-8 max-sm:mb-6">
      {crumbLabel ? <PageCrumb label={crumbLabel} /> : null}
      <div className="min-w-0">
        <h1 className="text-[1.5rem] sm:text-[1.75rem] leading-[1.2] font-semibold tracking-[-0.025em] text-ink">
          {title}
        </h1>
        {sub ? <p className="text-muted text-[0.875rem] mt-1.5 max-w-[62ch]">{sub}</p> : null}
        {meta ? <MetaLine className="mt-2.5">{meta}</MetaLine> : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:*:flex-1 max-sm:[&_:is(a,button)]:w-full">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * A note that needs attention: a white box with a tinted line and an icon,
 * never a filled colored block. `danger` = fix it, `warn` = keep an eye on it.
 */
export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "danger" | "warn" | "info" | "ok";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const ring = {
    danger: "border-[color-mix(in_srgb,var(--color-dot-danger)_32%,#fff)]",
    warn: "border-[color-mix(in_srgb,var(--color-dot-warn)_45%,#fff)]",
    info: "border-line",
    ok: "border-[color-mix(in_srgb,var(--color-dot-ok)_35%,#fff)]",
  }[tone];
  const icon: Record<typeof tone, { name: IconName; color: string }> = {
    danger: { name: "alert", color: "text-dot-danger" },
    warn: { name: "alert", color: "text-dot-warn" },
    info: { name: "clock", color: "text-muted" },
    ok: { name: "check", color: "text-dot-ok" },
  };
  // Success reads as a green band: the tint tells it apart from a hint at a glance.
  const fill = tone === "ok" ? "bg-[color-mix(in_srgb,var(--color-dot-ok)_9%,#fff)]" : "bg-white";
  return (
    <div
      role={tone === "danger" ? "alert" : tone === "ok" ? "status" : undefined}
      className={cn("flex items-start gap-3 rounded-card border px-4 py-3", fill, ring, className)}
    >
      <Icon name={icon[tone].name} className={cn("mt-0.5", icon[tone].color)} />
      <div className="min-w-0 flex-1 text-[0.875rem]">
        {title ? <div className="font-medium text-ink">{title}</div> : null}
        {children ? <div className={cn("text-muted", title ? "mt-0.5" : null)}>{children}</div> : null}
      </div>
      {action ? <div className="flex-none self-center">{action}</div> : null}
    </div>
  );
}

// ---------- status ----------

export type BadgeTone =
  | "brand"
  | "info"
  | "lav"
  | "ok"
  | "warn"
  | "danger"
  | "muted"
  | "ink";

const DOT: Partial<Record<BadgeTone, string>> = {
  ok: "bg-dot-ok",
  warn: "bg-dot-warn",
  danger: "bg-dot-danger",
  info: "bg-dot-info",
  brand: "bg-dot-info",
  muted: "bg-dot-off",
};

/**
 * A status as a colored dot plus text, never a filled pill: amber waits on
 * you, blue is with the other side, green is fine, red needs fixing, gray is
 * done or off. Categories (`lav`, `ink`) read as plain secondary text.
 */
export function Badge({
  tone = "lav",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  const dot = DOT[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[0.875rem] whitespace-nowrap",
        dot && tone !== "muted" ? "text-ink" : "text-muted",
        className
      )}
    >
      {dot ? <span aria-hidden="true" className={cn("size-2 flex-none rounded-full", dot)} /> : null}
      {children}
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block size-1.5 rounded-full bg-current", className)}
    />
  );
}

function initialsOf(name: string, max: number): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = [parts[0]?.[0], parts.length > 1 ? parts[parts.length - 1][0] : undefined];
  return letters.filter(Boolean).slice(0, max).join("").toUpperCase() || "?";
}

/**
 * A person's initials in a circle: filled black for the agency's team,
 * white with a gray ring for the client's people. Decorative: the name is
 * always written next to it.
 */
export function Avatar({
  name,
  kind = "team",
  size = 24,
  className,
}: {
  name: string;
  kind?: "team" | "client";
  size?: 24 | 28 | 32;
  className?: string;
}) {
  const box = { 24: "size-6 text-[0.6875rem]", 28: "size-7 text-[0.71875rem]", 32: "size-8 text-[0.75rem]" }[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full font-semibold leading-none select-none",
        box,
        kind === "team" ? "bg-ink text-white" : "bg-white text-ink ring-1 ring-inset ring-line-strong",
        className
      )}
    >
      {initialsOf(name, size === 24 ? 1 : 2)}
    </span>
  );
}

// ---------- forms ----------

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[0.875rem] font-medium text-ink"
      >
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p className="text-[0.8125rem] text-muted">{hint}</p>
      ) : null}
      {error ? (
        <p className="text-[0.8125rem] font-medium text-danger">{error}</p>
      ) : null}
    </div>
  );
}

// 36px tall like the default button; the line darkens on hover and focus.
export const inputClasses =
  "w-full rounded-field border border-line bg-white px-3 py-[7px] text-[0.875rem] leading-5 text-ink placeholder:text-muted/80 transition-[border-color,box-shadow] hover:border-line-strong";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cn(inputClasses, props.className)} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className={cn(inputClasses, "min-h-24", props.className)}
    />
  );
}

export function Select(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cn(inputClasses, "appearance-none pr-9 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%228%22%3E%3Cpath%20d%3D%22M1%201l5%205%205-5%22%20stroke%3D%22%23737373%22%20stroke-width%3D%222%22%20fill%3D%22none%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_12px_center]", props.className)}
    />
  );
}

export function Checkbox({
  label,
  hint,
  className,
  ...props
}: ComponentProps<"input"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 cursor-pointer group",
        className
      )}
    >
      <input
        type="checkbox"
        {...props}
        className="mt-0.5 size-4 accent-brand rounded"
      />
      <span>
        <span className="block text-[0.875rem] font-medium text-ink group-hover:text-brand-deep transition-colors">
          {label}
        </span>
        {hint ? (
          <span className="block text-[0.8125rem] text-muted mt-0.5">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

// ---------- data ----------

/**
 * Figures side by side in one hairline box, split by hairlines — lighter than
 * a card per number. Children are StatCards; `cols` is the count on wide
 * screens (four become two on small ones, three stack).
 */
export function StatGrid({
  cols,
  children,
  className,
}: {
  cols: 1 | 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-card border border-line bg-line",
        { 1: "grid-cols-1", 2: "grid-cols-2", 3: "sm:grid-cols-3", 4: "grid-cols-2 lg:grid-cols-4" }[cols],
        className
      )}
    >
      {children}
    </div>
  );
}

/** One figure in a StatGrid: its name, the number, an optional note. */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** "alert" marks a figure in the red; "brand" is kept for callers, same as default. */
  tone?: "default" | "alert" | "brand";
}) {
  return (
    <div className="bg-white px-5 py-4">
      <div className={cn("text-[0.875rem]", tone === "alert" ? "font-medium text-danger" : "text-muted")}>
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-[1.5rem] leading-[1.25] font-semibold tracking-[-0.02em] tabular",
          tone === "alert" ? "text-danger" : "text-ink"
        )}
      >
        {value}
      </div>
      {hint ? <div className="text-[0.8125rem] text-muted mt-0.5">{hint}</div> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  max,
  tone = "brand",
  size = "sm",
}: {
  value: number;
  max: number;
  tone?: "brand" | "danger" | "ok" | "warn";
  /** 4px, or 6px for the one bar a box is about. */
  size?: "sm" | "md";
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  const tones = {
    brand: "bg-brand",
    danger: "bg-danger",
    ok: "bg-ok-deep",
    warn: "bg-warn",
  }[tone];
  return (
    <div className={cn("w-full rounded-full bg-line overflow-hidden", size === "md" ? "h-1.5" : "h-1")}>
      <div
        className={cn("h-full rounded-full transition-[width]", tones)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({
  title,
  text,
  action,
  icon = "inbox",
}: {
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <span className="size-10 rounded-lg border border-line bg-white text-muted flex items-center justify-center mb-4">
        <Icon name={icon} size={18} />
      </span>
      <div className="text-[0.9375rem] font-medium text-ink">{title}</div>
      {text ? (
        <p className="text-[0.875rem] text-muted mt-1 max-w-sm">{text}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export const thClasses =
  "text-left text-[0.8125rem] font-medium text-muted px-4 h-10 whitespace-nowrap bg-paper";
export const tdClasses = "px-4 py-3 text-[0.875rem] align-middle";

export function TableShell({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[560px]">{children}</table>
      </div>
    </Card>
  );
}
