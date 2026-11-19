# Railway template

The "Deploy on Railway" button in the README points to a template that lives on Railway, not in this repository. This page describes how it is built, so it can be recreated or checked.

Railway's interface changes over time; the steps describe what to configure rather than exact button names.

## Services

### Postgres

- Railway's PostgreSQL database, version 17 or newer.
- Service name: `Postgres` (the variable reference below uses this name).

### Velk Express

- **Source:** Docker image `ghcr.io/elleven-digital/velk-express:0`.
- **Volume:** mounted at `/data`.
- **Variables:**

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
  | `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |

  `RAILWAY_PUBLIC_DOMAIN` is the domain Railway generates for the service. Leave the optional variables (SMTP, S3, Stripe, Mercado Pago) out of the template, or add them as optional with an empty default and a description from [configuration](configuration.md).

- **Networking:** a generated public domain on port `3000`.
- **Deploy settings:**
  - healthcheck path: `/api/health`;
  - restart policy: on failure.

Do not set a start command: the image's entrypoint waits for the database, backs it up when needed, applies migrations and starts the app.

## Recreating it

1. Create a new project and add the two services above with the settings listed.
2. Deploy it once and check that:
   - the service logs end with `[boot] ready`;
   - `https://<generated domain>/api/health` answers `{"ok":true}`;
   - the public address opens the install screen.
3. From the project's settings, create a template from the project. Give it a name and a short description, and in the description tell people to finish the install screen right after the deploy.
4. Publish the template and copy its link.
5. In the README, replace `RAILWAY_TEMPLATE_URL` with that link and uncomment the button.

Delete the test project afterwards, or keep it as your own install after finishing the install screen.
