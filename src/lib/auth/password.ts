import bcrypt from "bcryptjs";

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt only reads the first 72 bytes, so longer passwords would silently be cut. */
export const MAX_PASSWORD_BYTES = 72;

export type PasswordProblem = "tooShort" | "tooLong";

/** Shared by install and set-password. Length is in characters, the cap in bytes. */
export function passwordProblem(password: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return "tooLong";
  return null;
}

const COST = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
