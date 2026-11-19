import { fmt } from "@/lib/i18n";
import { LinkButton } from "@/components/ui";

/** Previous / "Page X of Y" / Next under a list; nothing when everything fits on one page. */
export function Pager({
  page,
  pages,
  hrefOf,
  labels,
}: {
  page: number;
  pages: number;
  hrefOf: (page: number) => string;
  labels: { nav: string; prev: string; next: string; of: string };
}) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={labels.nav} className="mt-5 flex items-center justify-between gap-3 text-muted">
      {page > 1 ? (
        <LinkButton href={hrefOf(page - 1)} variant="secondary" size="sm">
          {labels.prev}
        </LinkButton>
      ) : (
        <span />
      )}
      <span className="tabular">{fmt(labels.of, { page, pages })}</span>
      {page < pages ? (
        <LinkButton href={hrefOf(page + 1)} variant="secondary" size="sm">
          {labels.next}
        </LinkButton>
      ) : (
        <span />
      )}
    </nav>
  );
}
