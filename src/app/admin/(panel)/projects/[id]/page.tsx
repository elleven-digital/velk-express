import { TeamTicketPage } from "../../tickets/[id]/team-ticket-page";

export const dynamic = "force-dynamic";

/** A project's page: the ticket page, at the projects' address. */
export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  return <TeamTicketPage params={params} area="projects" />;
}
