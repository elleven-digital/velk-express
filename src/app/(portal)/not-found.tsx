import Link from "next/link";
import { Card, EmptyState, buttonClasses } from "@/components/ui";
import { getPortalDict } from "@/lib/i18n/server";

/** Shown inside the portal frame when a page calls notFound(). */
export default async function PortalNotFound() {
  const { t } = await getPortalDict();
  return (
    <Card>
      <EmptyState
        icon="alert"
        title={t.notFound.title}
        text={t.notFound.text}
        action={
          <Link href="/" className={buttonClasses("secondary", "md")}>
            {t.notFound.back}
          </Link>
        }
      />
    </Card>
  );
}
