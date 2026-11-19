export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
export type SmtpConfig = {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  from: string;
};
export type ResendConfig = { apiKey: string; from: string };
/** How e-mail leaves the app: SMTP, or the Resend HTTPS API for hosts that block outbound SMTP. */
export type MailConfig = ({ provider: "smtp" } & SmtpConfig) | ({ provider: "resend" } & ResendConfig);
export type AppConfig = {
  databaseUrl: string;
  appUrl: string | null;
  secretKey: string | null;
  dataDir: string;
  port: number;
  s3: S3Config | null;
  mail: MailConfig | null;
  stripe: { secretKey: string; webhookSecret: string } | null;
  mercadoPago: { accessToken: string; webhookSecret: string } | null;
  updateCheck: boolean;
  warnings: string[];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key]?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

function parseAppUrl(raw: string | null, warnings: string[]): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // falls through to the warning below
  }
  warnings.push("APP_URL is not a valid http(s) URL and was ignored.");
  return null;
}

/** Returns the values when all keys are set; warns when only some are. */
function group(env: Env, keys: string[], label: string, warnings: string[]): Record<string, string> | null {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const v = str(env, key);
    if (v) values[key] = v;
    else missing.push(key);
  }
  if (missing.length === keys.length) return null;
  if (missing.length > 0) {
    warnings.push(`${label} is disabled: missing ${missing.join(", ")}.`);
    return null;
  }
  return values;
}

export function readConfig(env: Env): AppConfig {
  const databaseUrl = str(env, "DATABASE_URL");
  if (!databaseUrl) throw new ConfigError("DATABASE_URL is required.");

  const warnings: string[] = [];

  const portRaw = str(env, "PORT");
  const portNum = portRaw && /^\d+$/.test(portRaw) ? Number.parseInt(portRaw, 10) : NaN;
  const port = Number.isInteger(portNum) && portNum > 0 && portNum < 65536 ? portNum : 3000;

  const s3v = group(
    env,
    ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    "S3 storage",
    warnings,
  );
  const s3: S3Config | null = s3v && {
    endpoint: s3v.S3_ENDPOINT,
    region: s3v.S3_REGION,
    bucket: s3v.S3_BUCKET,
    accessKeyId: s3v.S3_ACCESS_KEY_ID,
    secretAccessKey: s3v.S3_SECRET_ACCESS_KEY,
  };

  let mail: MailConfig | null = null;
  const smtpHost = str(env, "SMTP_HOST");
  const resendKey = str(env, "RESEND_API_KEY");
  const mailFrom = str(env, "MAIL_FROM");
  if ((smtpHost || resendKey) && !mailFrom) {
    warnings.push("E-mail is disabled: missing MAIL_FROM.");
  } else if (resendKey && mailFrom) {
    mail = { provider: "resend", apiKey: resendKey, from: mailFrom };
    if (smtpHost) warnings.push("RESEND_API_KEY and SMTP_HOST are both set; e-mail goes through Resend and SMTP is ignored.");
  } else if (smtpHost && mailFrom) {
    const p = str(env, "SMTP_PORT");
    const parsed = p && /^\d+$/.test(p) ? Number.parseInt(p, 10) : NaN;
    mail = {
      provider: "smtp",
      host: smtpHost,
      port: Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 587,
      user: str(env, "SMTP_USER"),
      pass: str(env, "SMTP_PASS"),
      from: mailFrom,
    };
  } else if (mailFrom) {
    warnings.push("E-mail is disabled: set SMTP_HOST or RESEND_API_KEY.");
  }

  const st = group(env, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], "Stripe", warnings);
  const mp = group(env, ["MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET"], "Mercado Pago", warnings);

  return {
    databaseUrl,
    appUrl: parseAppUrl(str(env, "APP_URL"), warnings),
    secretKey: str(env, "SECRET_KEY"),
    dataDir: str(env, "DATA_DIR") ?? "/data",
    port,
    s3,
    mail,
    stripe: st && { secretKey: st.STRIPE_SECRET_KEY, webhookSecret: st.STRIPE_WEBHOOK_SECRET },
    mercadoPago: mp && { accessToken: mp.MERCADOPAGO_ACCESS_TOKEN, webhookSecret: mp.MERCADOPAGO_WEBHOOK_SECRET },
    updateCheck: bool(env, "UPDATE_CHECK", true),
    warnings,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  cached ??= readConfig(process.env);
  return cached;
}
