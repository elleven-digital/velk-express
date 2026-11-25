# Install on Railway

Railway runs the Velk Express image next to a Railway PostgreSQL database. Railway gives you HTTPS and a domain.

Railway's interface changes over time. Where this guide describes a step by what it does, look for the matching option in your project.

## What will be created

- A **Postgres** service (Railway's PostgreSQL).
- A **Velk Express** service from the image `ghcr.io/elleven-digital/velk-express:0`.
- A **volume** mounted at `/data` on the Velk Express service, for uploaded files.
- A public domain for the Velk Express service.

## With the template

Open the [Velk Express template](https://railway.com/deploy/velk-express) (or click "Deploy on Railway" in the README) and deploy it. The template creates the Postgres service, the Velk Express service and its public domain with the right settings. Uploaded files go to a Railway Bucket named `velk-files` instead of a volume. Then go to [finish the install](#finish-the-install).

## By hand

1. Create a new, empty project.
2. Add a **PostgreSQL** database to the project. Check that it runs PostgreSQL 17 or newer.
3. Add a service from a **Docker image** and enter:

   ```
   ghcr.io/elleven-digital/velk-express:0
   ```

4. In the new service, **attach a volume** with the mount path `/data`.
5. In the service's **variables**, add:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   PORT=3000
   ```

   `Postgres` is the name of the database service. If yours has another name, use that name. Railway gives each service its own `PORT` (usually `8080`); setting it to `3000` keeps the app on the port the domain points to.

6. In the service's **networking** settings, generate a public domain and set the port to `3000`.
7. Back in the variables, add the public address, using the domain you just generated:

   ```
   APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   ```

   If you later add your own domain, change `APP_URL` to `https://` plus that domain.

8. In the service's **deploy** settings, set the healthcheck path to `/api/health`.
9. Deploy the changes. In the service's logs, wait for `[boot] ready`.

## Finish the install

**Open the public address right away and finish the install screen.** Until someone creates the agency, the install screen is open to anyone who can reach the address.

Then check **Settings → Installation**.

## Minimum variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}`, or `https://` plus your own domain |
| `PORT` | `3000` |

E-mail, S3 storage and payments are optional. See [configuration](configuration.md).

Railway blocks outbound SMTP on the Free, Trial and Hobby plans, so SMTP only works on Pro and above. On the other plans, send e-mail through the Resend API: set `RESEND_API_KEY` and `MAIL_FROM` (see [when your host blocks SMTP](configuration.md#when-your-host-blocks-smtp)).

## Backups

Velk Express does not back itself up. Turn on scheduled backups in the Postgres service's backup settings right after the install, and take one before every update. See [backup and restore](backup-and-restore.md).

## Your own domain

Add your domain in the service's networking settings and create the DNS record Railway shows you. Railway issues the certificate. Then set `APP_URL` to `https://` plus your domain and redeploy.

If you take payments, also update the webhook addresses at Stripe and Mercado Pago (see [payments](payments.md)).

## Updating

The `:0` tag always points to the newest 0.x release. To get it, redeploy the Velk Express service so Railway pulls the image again. Railway can also check for new images and update on a schedule you choose in the service settings.

If Railway offers to change the tag to a new major version (for example from `:0` to `:1`), read that release's notes first. See [updating](updating.md).

## Running the admin command

If you lose access to the owner account and e-mail is not set up, open a shell in the Velk Express service (for example with the Railway CLI's `railway ssh`) and run:

```sh
velk reset-link owner@example.com
```

It prints a single-use password link, valid for 2 hours.
