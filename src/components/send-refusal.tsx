import { cn } from "./ui";

/**
 * The refusal of a message send, and, when the composer is gone, the text that was not sent
 * (plain text, rendered as text: never as HTML) in a block that is easy to copy.
 */
export function SendRefusal({
  error,
  unsent,
  label,
  className,
}: {
  error?: string;
  unsent?: string;
  label: string;
  className?: string;
}) {
  if (!error) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <div role="alert" className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-[0.875rem] font-medium text-danger">
        {error}
      </div>
      {unsent ? (
        <div className="rounded-md border border-line bg-paper px-3 py-2 text-[0.875rem]">
          <p className="mb-1 font-medium text-ink">{label}</p>
          <p data-unsent className="whitespace-pre-wrap break-words text-body select-all">
            {unsent}
          </p>
        </div>
      ) : null}
    </div>
  );
}
