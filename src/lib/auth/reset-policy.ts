/**
 * A reset link requested on /forgot is only worth issuing when it can be
 * e-mailed. With e-mail off it would be undeliverable and would cancel a link the
 * owner just copied from the team page (issuing replaces older reset links).
 */
export function canDeliverResetMail(mail: unknown | null): boolean {
  return mail !== null && mail !== undefined;
}
