import { TicketListPage } from "../tickets/ticket-list-page";

export const dynamic = "force-dynamic";

/** The team's projects: the tickets marked as projects, with the same filters as the tickets. */
export default function ProjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <TicketListPage kind="projects" searchParams={searchParams} />;
}
