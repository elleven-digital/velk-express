import { TicketListPage } from "./ticket-list-page";

export const dynamic = "force-dynamic";

/** The team's tickets, projects apart (they have their own list). */
export default function TicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <TicketListPage kind="tickets" searchParams={searchParams} />;
}
