# Railway template

The "Deploy on Railway" button in the README points to a template that lives on Railway, not in this repository. This page describes how it is built, so it can be recreated or checked.

Railway's interface changes over time; the steps describe what to configure rather than exact button names.

## Services

### Postgres

- Railway's PostgreSQL database, version 17 or newer.
- Service name: `Postgres` (the variable reference below uses this name).

### Velk Express

- **Source:** Docker image `ghcr.io/elleven-digital/velk-express:0`.
- **Volume:** mounted at `/data` (uploaded files). To keep files in object storage instead, add a Railway Bucket and set the five `S3_*` variables as references to it (see [configuration](configuration.md#file-storage-disk-or-s3)); the volume is then unused.
- **Variables:**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
  | `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
  | `PORT` | `3000` |

  `RAILWAY_PUBLIC_DOMAIN` is the domain Railway generates for the service; generate the domain before the first deploy, or `APP_URL` starts empty and the log warns that it was ignored. Without `PORT`, Railway's own value (usually `8080`) wins and the domain on port `3000` gets no answer. Leave the optional variables (SMTP, Resend, S3, Stripe, Mercado Pago) out of the template, or add them as optional with an empty default and a description from [configuration](configuration.md).

- **Networking:** a generated public domain on port `3000`.
- **Deploy settings:**
  - healthcheck path: `/api/health`, with a timeout of 300 seconds (the first boot applies every migration before the app answers);
  - restart policy: on failure, up to 10 retries.

Do not set a start command: the image's entrypoint waits for the database, applies pending migrations and starts the app. It does not back the database up: tell people to turn on the Postgres service's backups (see [backup and restore](backup-and-restore.md)).

## Recreating it

1. Create a new project and add the two services above with the settings listed. Generate the public domain and set the variables before attaching the image, so the first deploy already has `APP_URL`.
2. Deploy it once and check that:
   - the service logs end with `[boot] ready`;
   - `https://<generated domain>/api/health` answers `{"ok":true}`;
   - the public address opens the install screen.
3. From the project's settings, create a template from the project. Give it a name, an icon and a short description, and in the description tell people to finish the install screen right after the deploy and to turn on database backups.
4. Publish the template and copy its link.
5. In the README, replace `RAILWAY_TEMPLATE_URL` with that link and uncomment the button.

Delete the test project afterwards, or keep it as your own install after finishing the install screen.
