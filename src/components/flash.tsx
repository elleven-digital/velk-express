import { Callout } from "./ui";

/** Inline feedback note at the top of a page; the caller resolves the message text. */
export function Flash({ error, ok }: { error?: string; ok?: string }) {
  if (error) {
    // Callout marks the danger tone as an alert
    return <Callout tone="danger" title={error} className="mb-6" />;
  }
  if (ok) {
    return (
      <div role="status" className="mb-6">
        <Callout tone="ok" title={ok} />
      </div>
    );
  }
  return null;
}
