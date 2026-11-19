"use server";

import { redirect } from "next/navigation";
import { destroySession } from "./session";

/** Ends the team session and goes back to the team login page. */
export async function signOut(): Promise<void> {
  await destroySession("agency");
  redirect("/admin/login");
}

/** Ends the portal session and goes back to the portal login page. */
export async function signOutPortal(): Promise<void> {
  await destroySession("client");
  redirect("/login");
}
