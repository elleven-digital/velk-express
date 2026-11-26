import { TeamTicketPage } from "./team-ticket-page";

export const dynamic = "force-dynamic";

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  return <TeamTicketPage params={params} area="tickets" />;
}
