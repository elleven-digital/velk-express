import { redirect } from "next/navigation";
import type { UserRole } from "@/lib/db";
import { getPortalSession, getTeamSession, type PortalSession, type TeamSession } from "./session";

/** For team pages: no session → login, a role that is not allowed → the panel home. */
export async function requireTeam(roles?: UserRole[]): Promise<TeamSession> {
  const session = await getTeamSession();
  if (!session) redirect("/admin/login");
  if (roles && !roles.includes(session.user.role)) redirect("/admin");
  return session;
}

/** For portal pages: no session → the portal login. */
export async function requirePortal(): Promise<PortalSession> {
  const session = await getPortalSession();
  if (!session) redirect("/login");
  return session;
}

/** For portal pages only the admin of the active company may open: anyone else → the portal home. */
export async function requirePortalAdmin(): Promise<PortalSession> {
  const session = await requirePortal();
  if (session.role !== "admin") redirect("/");
  return session;
}
