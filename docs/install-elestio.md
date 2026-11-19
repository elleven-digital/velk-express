# Install on Elestio

Elestio runs apps on a server it manages for you, behind its own HTTPS proxy. There are two ways to run Velk Express there:

- **From Elestio's catalog**, if Velk Express is listed. Elestio writes and maintains that recipe.
- **As a custom Docker Compose service**, with the compose file below.

Elestio's interface changes over time. Where this guide describes a step by what it does, look for the matching option in Elestio.

## What will be created

- A service with two containers: `app` (Velk Express) and `db` (PostgreSQL 17).
- Two folders inside the service: `./data` (the app's files) and `./postgres` (the database). Elestio's own backups cover folders inside the service.
- An address with HTTPS from Elestio's proxy.

## From the catalog

1. Create the service from the catalog entry and pick a server with at least 2 GB of RAM.
2. Before you use it, check:
   - the app's data folder is persistent and mounted at `/data` (or `DATA_DIR` points to it);
   - `APP_URL` is the service's public address with `https://`;
   - the database is PostgreSQL 17 or newer.
3. Go to [finish the install](#finish-the-install).

## As a custom Docker Compose service

1. Create a new service from a **Docker Compose** source and choose the **custom** template.
2. Paste this compose file:

   ```yaml
   services:
     app:
       image: ghcr.io/elleven-digital/velk-express:0
       restart: always
       depends_on:
         db:
           condition: service_healthy
       environment:
         DATABASE_URL: postgres://velk:${POSTGRES_PASSWORD}@db:5432/velk
         APP_URL: ${APP_URL}
         SMTP_HOST: ${SMTP_HOST:-}
         SMTP_PORT: ${SMTP_PORT:-}
         SMTP_USER: ${SMTP_USER:-}
         SMTP_PASS: ${SMTP_PASS:-}
         RESEND_API_KEY: ${RESEND_API_KEY:-}
         MAIL_FROM: ${MAIL_FROM:-}
         STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY:-}
         STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET:-}
         MERCADOPAGO_ACCESS_TOKEN: ${MERCADOPAGO_ACCESS_TOKEN:-}
         MERCADOPAGO_WEBHOOK_SECRET: ${MERCADOPAGO_WEBHOOK_SECRET:-}
       ports:
         - "172.17.0.1:3000:3000"
       volumes:
         - ./data:/data

     db:
       image: postgres:17
       restart: always
       environment:
         POSTGRES_USER: velk
         POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
         POSTGRES_DB: velk
       volumes:
         - ./postgres:/var/lib/postgresql/data
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U velk -d velk"]
         interval: 5s
         timeout: 5s
         retries: 10
   ```

   The app listens only on Elestio's internal address (`172.17.0.1`), and Elestio's proxy serves it over HTTPS. To use more variables from [configuration](configuration.md), add them to the `environment` list the same way.

3. Add the environment variables in the service settings:

   ```
   POSTGRES_PASSWORD=a-long-random-value-with-letters-and-digits-only
   APP_URL=https://your-service-address
   ```

4. Point Elestio's reverse proxy at the app: target port `3000`, the same as the host port in the compose file.
5. Deploy and wait until the app's logs show `[boot] ready`.

## Finish the install

**Open the address right away and finish the install screen.** Until someone creates the agency, the install screen is open to anyone who can reach the address.

Then check **Settings → Installation**: the public address must match `APP_URL`, and file storage must be "writable".

## Minimum variables

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | a long random value, letters and digits only (custom compose only) |
| `APP_URL` | the service's public address, with `https://` |

## Domain and HTTPS

Elestio's proxy issues the certificate. To use your own domain, add it in the service's domain settings, create the DNS record Elestio shows, and set `APP_URL` to `https://` plus that domain.

## Updating

For the custom compose service, pull the image again and restart the app: redeploy the service from Elestio, or, in a terminal on the service, run:

```sh
docker compose pull app
docker compose up -d
```

For a catalog service, use Elestio's update option for the app. See [updating](updating.md).
