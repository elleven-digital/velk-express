import { createResetLink } from "@/cli/reset-link";
import { ConfigError, readConfig } from "@/lib/config";
import { createDb } from "@/lib/db/client";
import { TOKEN_TTL } from "@/lib/auth/tokens";

const USAGE = `Velk Express administration

Usage:
  velk reset-link <email>   Print a password link for a team user (use it when email is not set up)

Inside the container: docker compose exec app velk reset-link <email>`;

async function main(argv: string[]): Promise<number> {
  const [command, email, ...rest] = argv;
  if (command !== "reset-link") {
    if (command && command !== "help" && command !== "--help" && command !== "-h") console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    return command === undefined || command === "help" || command === "--help" || command === "-h" ? 0 : 1;
  }
  if (!email || rest.length > 0) {
    console.error("Usage: velk reset-link <email>");
    return 1;
  }

  let databaseUrl: string;
  let appUrl: string | null;
  try {
    const config = readConfig(process.env);
    databaseUrl = config.databaseUrl;
    appUrl = config.appUrl;
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : "Could not read the configuration.");
    return 1;
  }

  let close: (() => Promise<unknown>) | null = null;
  try {
    const created = createDb(databaseUrl, { connectTimeout: 5, quietNotices: true });
    close = created.close;
    const db = created.db;
    const result = await createResetLink(db, email, appUrl);
    if (!result.ok) {
      console.error(result.reason === "invalidEmail" ? "Enter the user's email." : `No team user with the email ${email.trim().toLowerCase()}. Portal users are not covered by this command.`);
      return 1;
    }
    if (!result.absolute) {
      console.error("The public address is not set (APP_URL or saved at install): showing the path only. Prepend your server's address.");
    }
    console.error(`Password link for ${result.name} (valid for ${TOKEN_TTL.reset / 3600_000} hours, single use; earlier reset links stop working):`);
    console.log(result.link);
    return 0;
  } catch {
    // Never echo the error: connection errors can carry the database URL.
    console.error("Could not reach the database or issue the link. Check that the server is up and DATABASE_URL is correct.");
    return 1;
  } finally {
    await close?.().catch(() => {});
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  () => {
    // Never print the error object: it can carry the database URL.
    console.error("Unexpected error.");
    process.exit(1);
  },
);
