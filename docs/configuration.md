# Configuration

Velk Express is configured with environment variables. Integration secrets (SMTP, Resend, S3, Stripe, Mercado Pago) live only in variables, never in the database. The annotated list is in [`.env.example`](../.env.example); the Docker Compose version is [`deploy/.env.example`](../deploy/.env.example).

Change a variable, then restart the app for it to take effect.

The agency's time zone (it decides where the hours month starts and what "today" is) is not a variable: set it on the install screen and change it later in **Settings → Agency**. The `TZ` environment variable has no effect on it.

## All variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `DATABASE_URL` | Yes | none | PostgreSQL connection string, for example `postgres://velk:password@db:5432/velk`. PostgreSQL 17 or newer. |
| `APP_URL` | No | detected at install | Public address, for example `https://panel.example.com`. Used in invite and password links, e-mails, payment return pages and webhook addresses. When set, it always wins and the address in Settings is locked. Only the origin is kept (scheme, host and port); a value that is not an `http` or `https` URL is ignored with a warning in the log. |
| `SECRET_KEY` | No | generated | Reserved for signing features. Generated on the first start and stored in the database; set it only to override that value. |
| `DATA_DIR` | No | `/data` | Folder for uploaded files (`DATA_DIR/files`) when S3 is not set. Must be persistent and writable. |
| `PORT` | No | `3000` | Port the app listens on. |
| `S3_ENDPOINT` | No | none | S3-compatible endpoint, for example `https://<account>.r2.cloudflarestorage.com`. |
| `S3_REGION` | No | none | Region, for example `us-east-1`, or `auto` for Cloudflare R2. |
| `S3_BUCKET` | No | none | Bucket name. The bucket must already exist. |
| `S3_ACCESS_KEY_ID` | No | none | Access key id. |
| `S3_SECRET_ACCESS_KEY` | No | none | Secret access key. |
| `SMTP_HOST` | No | none | SMTP server. Without it, no e-mail is sent. |
| `SMTP_PORT` | No | `587` | SMTP port. Port `465` uses TLS from the start; other ports upgrade with STARTTLS when the server offers it. |
| `SMTP_USER` | No | none | SMTP username. Leave empty for a server without authentication. |
| `SMTP_PASS` | No | none | SMTP password. |
| `RESEND_API_KEY` | No | none | A [Resend](https://resend.com) API key. Sends e-mail through Resend's HTTPS API instead of SMTP, for hosts that block outbound SMTP. When set, the `SMTP_*` variables are ignored. |
| `MAIL_FROM` | No | none | Sender, for example `Your Agency <support@example.com>`. Required with `SMTP_HOST` or `RESEND_API_KEY`. |
| `STRIPE_SECRET_KEY` | No | none | Your Stripe secret key. With `STRIPE_WEBHOOK_SECRET`, turns Stripe on. See [payments](payments.md). |
| `STRIPE_WEBHOOK_SECRET` | No | none | The signing secret of your Stripe webhook endpoint. |
| `MERCADOPAGO_ACCESS_TOKEN` | No | none | Your Mercado Pago access token. With `MERCADOPAGO_WEBHOOK_SECRET`, turns Mercado Pago on. |
| `MERCADOPAGO_WEBHOOK_SECRET` | No | none | The secret signature of your Mercado Pago webhooks. |
| `UPDATE_CHECK` | No | `true` | Checks GitHub for a newer release, at most every 12 hours, when the owner or a manager opens the panel. Set `false` to turn it off. |

`true` and `false` are the only values `UPDATE_CHECK` accepts; anything else falls back to the default.

The Docker Compose stack also reads `DOMAIN`, `POSTGRES_PASSWORD` and `VELK_IMAGE` from its `.env` (see [Docker Compose](install-docker-compose.md)). The app itself does not use them.

## Groups that must be complete

Some features need several variables. If only part of a group is set, the feature stays off and the app logs a warning at start, for example `[boot] warning: S3 storage is disabled: missing S3_BUCKET.`

| Feature | Needs |
|---|---|
| E-mail | `MAIL_FROM` plus either `SMTP_HOST` (and `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` as your server requires) or `RESEND_API_KEY` |
| S3 storage | all five `S3_*` variables |
| Stripe | `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` |
| Mercado Pago | `MERCADOPAGO_ACCESS_TOKEN` and `MERCADOPAGO_WEBHOOK_SECRET` |

## E-mail

Velk Express sends invites, password resets and notices (a ticket opened, a quote sent or approved, a person added to another client) through your own SMTP server or e-mail provider, or through the Resend API.

Without e-mail set up, nothing breaks: sending is skipped and logged once, and the panel shows invite and password links for you to copy and send yourself. If you are locked out of the owner account, `velk reset-link` prints a password link (see [backup and restore](backup-and-restore.md#recovering-the-owner-account)).

Example with a typical provider:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=apikey-or-username
SMTP_PASS=your-smtp-password
MAIL_FROM=Your Agency <support@example.com>
```

Use a sender address on a domain you have set up with your provider (SPF and DKIM), or the e-mails will land in spam.

### When your host blocks SMTP

Some hosts block outbound SMTP ports on cheaper plans, and every send then times out. Use the Resend API instead, which goes out over HTTPS:

1. Create an account at [resend.com](https://resend.com), add your domain and create the DNS records it shows.
2. Create an API key with sending access.
3. Set the variables and restart:

```sh
RESEND_API_KEY=re_your_key
MAIL_FROM=Your Agency <support@example.com>
```

`MAIL_FROM` must use the domain you verified in Resend. If a send fails, the log shows Resend's reason, for example `[mail] send to example.com failed: Resend API returned 403: ...`.

## File storage: disk or S3

By default, uploaded files (ticket attachments, logos) go to `DATA_DIR/files` on the app's disk. Keep `DATA_DIR` on a persistent volume.

With all five `S3_*` variables set, files go to an S3-compatible bucket instead (AWS S3, Cloudflare R2, Backblaze B2, MinIO and others). The app uses path-style addresses, which these services accept.

Switching between disk and S3 does not move existing files. Decide before you start using the panel, or copy the files yourself.

If neither S3 nor a writable `DATA_DIR` is available, the app still runs, but attachments are unavailable and Settings → Installation shows the storage as "not writable".

Uploads are limited to 25 MB per file. Each person can also have at most 40 unclaimed files, or 300 MB, waiting to be sent in any 24 hours; beyond that the upload is refused (HTTP 429) with "Too many files waiting to be sent. Attach them to a message or ticket, or try again tomorrow."

## Settings → Installation

The owner sees this read-only summary in **Settings → Installation**:

- **Public address**: `APP_URL`, or the address saved at install. When `APP_URL` is not set, the owner can change it here. The [AI connector](ai-connector.md) is tied to this address: changing it disconnects every AI app, and each person has to connect again.
- **E-mail**: whether e-mail goes out through SMTP, through the Resend API, or is off.
- **File storage**: local disk or S3 bucket, and whether it is writable.
- **Payments**: which providers are on, or "manual records only".
- **Version** and **Latest release**: the running version and, with `UPDATE_CHECK` on, whether a newer one exists.
- **Update guide**: a link to the [update guide](updating.md).

**Settings → Payments** lists, for each provider, the variables that turn it on, its webhook address and the events to subscribe. See [payments](payments.md).

## Health check

`GET /api/health` answers `200` with `{"ok":true}` when the app and the database are up, and `503` otherwise. It needs no login and works before the install. Use it for your platform's health check.
