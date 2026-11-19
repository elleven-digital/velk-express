import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth/guards";

/** Quotes are the owner's: anyone else gets the panel's 404, so the pages do not even show they exist. */
export async function requireQuoteOwner() {
  const me = await requireTeam();
  if (me.user.role !== "owner") notFound();
  return me;
}
