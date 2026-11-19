import { cn } from "./ui";

/**
 * The agency's logo in a circle (a square upload fills it), or its initial
 * when there is no logo. Always shown next to the agency name, so it is
 * decorative for screen readers.
 */
export function AgencyAvatar({
  name,
  logoUrl,
  size = 36,
  className,
}: {
  name: string;
  logoUrl?: string | null;
  /** Diameter in px. */
  size?: number;
  className?: string;
}) {
  const box = { width: size, height: size };
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        style={box}
        className={cn("flex-none rounded-full object-cover bg-white border border-line", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ ...box, fontSize: Math.round(size * 0.42) }}
      className={cn(
        "flex-none inline-flex items-center justify-center rounded-full bg-ink text-white font-semibold leading-none",
        className
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
