# Railway template

The "Deploy on Railway" button in the README points to a template that lives on Railway, not in this repository. This page describes how it is built, so it can be recreated or checked.

Railway's interface changes over time; the steps describe what to configure rather than exact button names.

## Services

### Postgres

- Railway's PostgreSQL database, version 17 or newer.
- Service name: `Postgres` (the variable reference below uses this name).

### Velk Express

- **Source:** Docker image `ghcr.io/elleven-digital/velk-express:0`.
- **Files:** a Railway Bucket named `velk-files`, in the same region as the service. The service has no volume: with the `S3_*` variables set, nothing is written to `/data`. (A volume at `/data` also works, without the five `S3_*` variables; buckets cost less per GB and let the service redeploy without the brief stop a volume needs.)
- **Variables:**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
  | `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
  | `PORT` | `3000` |
  | `S3_ENDPOINT` | `${{velk-files.ENDPOINT}}` |
  | `S3_REGION` | `${{velk-files.REGION}}` |
  | `S3_BUCKET` | `${{velk-files.BUCKET}}` |
  | `S3_ACCESS_KEY_ID` | `${{velk-files.ACCESS_KEY_ID}}` |
  | `S3_SECRET_ACCESS_KEY` | `${{velk-files.SECRET_ACCESS_KEY}}` |

  `RAILWAY_PUBLIC_DOMAIN` is the domain Railway generates for the service; generate the domain before the first deploy, or `APP_URL` starts empty and the log warns that it was ignored. Without `PORT`, Railway's own value (usually `8080`) wins and the domain on port `3000` gets no answer. Leave the other optional variables (SMTP, Resend, Stripe, Mercado Pago) out of the template, or add them as optional with an empty default and a description from [configuration](configuration.md).

- **Networking:** a generated public domain on port `3000`.
- **Deploy settings:**
  - healthcheck path: `/api/health`, with a timeout of 300 seconds (the first boot applies every migration before the app answers);
  - restart policy: on failure, up to 10 retries.

Do not set a start command: the image's entrypoint waits for the database, applies pending migrations and starts the app. It does not back the database up: tell people to turn on the Postgres service's backups (see [backup and restore](backup-and-restore.md)).

## Recreating it

1. Create a new project and add the database, the bucket and the service above with the settings listed. Generate the public domain and set the variables before attaching the image, so the first deploy already has `APP_URL`.
2. Deploy it once and check that:
   - the service logs end with `[boot] ready`;
   - `https://<generated domain>/api/health` answers `{"ok":true}`;
   - the public address opens the install screen.
3. From the project's settings, create a template from the project. Give it a name, an icon and a short description, and in the description tell people to finish the install screen right after the deploy and to turn on database backups.
4. Publish the template and copy its link.
5. In the README, point the "Deploy on Railway" button at that link. The published template lives at https://railway.com/deploy/velk-express.

Delete the test project afterwards, or keep it as your own install after finishing the install screen.
