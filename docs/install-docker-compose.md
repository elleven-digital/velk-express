# Install with Docker Compose

This guide runs Velk Express on any Linux server with Docker. It uses the files in [`deploy/`](../deploy):

- `deploy/docker-compose.yml`: four containers:
  - `app`: Velk Express (`ghcr.io/elleven-digital/velk-express:0`);
  - `db`: PostgreSQL 17;
  - `caddy`: the web server, with automatic HTTPS for your domain;
  - `backup`: a daily dump of the database, kept for 7 days.
- `deploy/Caddyfile`: sends your domain to the app.
- `deploy/.env.example`: the settings you can change. None is required.

## What you need

- A server with Docker Engine and the Docker Compose plugin, and at least 2 GB of RAM in total (1 GB for the app, the rest for PostgreSQL, Caddy and the system).
- A domain or subdomain (for example `panel.example.com`) with a DNS `A` record (and `AAAA` if you use IPv6) pointing to the server.
- Ports 80 and 443 open to the internet. Caddy needs both to get the HTTPS certificate.

## Step by step

1. Get the deploy files onto the server:

   ```sh
   mkdir -p ~/velk && cd ~/velk
   curl -fsSLO https://raw.githubusercontent.com/elleven-digital/velk-express/main/deploy/docker-compose.yml
   curl -fsSLO https://raw.githubusercontent.com/elleven-digital/velk-express/main/deploy/Caddyfile
   curl -fsSL -o .env https://raw.githubusercontent.com/elleven-digital/velk-express/main/deploy/.env.example
   ```

   Or clone the repository and work in its `deploy/` folder.

2. Generate a database password:

   ```sh
   openssl rand -hex 24
   ```

3. Edit `.env` and set at least these three values:

   ```sh
   DOMAIN=panel.example.com
   APP_URL=https://panel.example.com
   POSTGRES_PASSWORD=paste-the-generated-password-here
   ```

   - `DOMAIN` is the name Caddy serves and gets the certificate for.
   - `APP_URL` is the public address used in links, e-mails and payment webhooks. Without it, the install screen detects the address and asks you to confirm it.
   - `POSTGRES_PASSWORD` must use letters and digits only, because it goes inside the database URL. It is applied only when the database is created for the first time: changing it later does not change the existing database's password.

   The other variables (e-mail, S3, payments) are explained in [configuration](configuration.md). You can add them later.

4. Start the stack:

   ```sh
   docker compose up -d
   ```

5. Watch the app start:

   ```sh
   docker compose logs -f app
   ```

   It waits for the database, applies migrations and prints `[boot] ready`. Press Ctrl+C to stop following the logs.

6. **Open `https://panel.example.com` and finish the install screen right away.** It asks for the agency name, your name, e-mail and password, the public address, the currency, the language and the time zone. Until someone does this, the install screen is open to anyone who can reach the address.

7. Check **Settings → Installation**.

## Domain and HTTPS

Caddy gets and renews a certificate from Let's Encrypt for `DOMAIN` on its own. If the certificate fails, check that the DNS record points to the server and that ports 80 and 443 are reachable, then look at `docker compose logs caddy`.

With the default `DOMAIN=localhost`, Caddy serves `https://localhost` with a local certificate that browsers do not trust. That is only for trying it out on your own machine.

If you already run another web server on ports 80 and 443, remove the `caddy` service and follow the [reverse proxy guide](reverse-proxy.md).

## Day to day

Run these from the folder with `docker-compose.yml`:

```sh
docker compose ps                # what is running
docker compose logs -f app       # app logs
docker compose restart app       # restart the app, for example after editing .env
docker compose up -d             # apply changes to .env or docker-compose.yml
```

After you edit `.env`, run `docker compose up -d` so the app container is recreated with the new values.

If you lose access to the owner account and e-mail is not set up, create a password link:

```sh
docker compose exec app velk reset-link owner@example.com
```

## Updating

```sh
docker compose pull app
docker compose up -d
```

The app backs up the database before it applies new migrations. See [updating](updating.md) for versions and tags, and [backup and restore](backup-and-restore.md) for where backups are and how to restore them.
