import Link from "next/link";
import { Card, EmptyState, buttonClasses } from "@/components/ui";
import { getUserDict } from "@/lib/i18n/server";

/** Shown inside the panel shell when a page calls notFound(): a missing client, or one out of the member's scope. */
export default async function PanelNotFound() {
  const { t } = await getUserDict();
  return (
    <Card>
      <EmptyState
        icon="alert"
        title={t.notFound.title}
        text={t.notFound.text}
        action={
          <Link href="/admin" className={buttonClasses("secondary", "md")}>
            {t.notFound.back}
          </Link>
        }
      />
    </Card>
  );
}
