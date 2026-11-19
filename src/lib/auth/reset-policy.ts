/**
 * A reset link requested on /forgot is only worth issuing when it can be
 * e-mailed. Without SMTP it would be undeliverable and would cancel a link the
 * owner just copied from the team page (issuing replaces older reset links).
 */
export function canDeliverResetMail(smtp: unknown | null): boolean {
  return smtp !== null && smtp !== undefined;
}
