# Install on a Hostinger VPS

On a Hostinger VPS you run the same Docker Compose stack as on any server: the app, PostgreSQL 17, Caddy for HTTPS and daily database backups. This page covers the Hostinger-specific parts; the [Docker Compose guide](install-docker-compose.md) has the details.

Hostinger names and menus change over time. Where this guide describes a step by what it does, look for the matching option in hPanel.

## What will be created

- One VPS running Ubuntu with Docker.
- In it, the four containers from [`deploy/docker-compose.yml`](../deploy/docker-compose.yml): `app`, `db`, `caddy` and `backup`.
- Docker volumes for the database, the app's files, the backups and Caddy's certificates.

## Step by step

1. **Choose a plan.** Any VPS plan with at least 2 GB of RAM is enough for one agency.

2. **Choose the operating system.** Pick an Ubuntu template that comes with Docker already installed. If you pick plain Ubuntu, install Docker Engine and the Compose plugin with [Docker's guide for Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

3. **Open the ports.** If you turn on the VPS firewall in hPanel, allow incoming TCP 22 (SSH), 80 and 443, and UDP 443.

4. **Point your domain at the VPS.** Create a DNS `A` record for your domain or subdomain (for example `panel.example.com`) with the VPS's IPv4 address. Wait until it resolves:

   ```sh
   dig +short panel.example.com
   ```

5. **Connect over SSH** with the address and root password (or SSH key) shown in hPanel:

   ```sh
   ssh root@your-vps-ip
   ```

6. **Get the deploy files, set the domain and the password, and start**, as in steps 1 to 5 of the [Docker Compose guide](install-docker-compose.md#step-by-step):

   ```sh
   mkdir -p ~/velk && cd ~/velk
   curl -fsSLO https://raw.githubusercontent.com/elleven-digital/velk-express/main/deploy/docker-compose.yml
   curl -fsSLO https://raw.githubusercontent.com/elleven-digital/velk-express/main/deploy/Caddyfile
   curl -fsSL -o .env https://raw.githubusercontent.com/elleven-digital/velk-express/main/deploy/.env.example
   openssl rand -hex 24      # copy this into POSTGRES_PASSWORD
   nano .env                 # set DOMAIN, APP_URL and POSTGRES_PASSWORD
   docker compose up -d
   docker compose logs -f app
   ```

7. **Finish the install screen right away.** Open `https://panel.example.com` as soon as the logs show `[boot] ready`. Until someone creates the agency, the install screen is open to anyone who can reach the address.

Hostinger's Docker Manager can also deploy a compose file from a URL, but it only fetches that one file. This stack also needs the `Caddyfile` next to it, so use the SSH steps above.

## Minimum variables

In `~/velk/.env`:

| Variable | Value |
|---|---|
| `DOMAIN` | your domain, for example `panel.example.com` |
| `APP_URL` | `https://` plus the same domain |
| `POSTGRES_PASSWORD` | a long random value, letters and digits only |

Everything else is optional. See [configuration](configuration.md).

## Domain and HTTPS

Caddy gets the certificate on its own once the DNS record points to the VPS and ports 80 and 443 are open. If it fails, run `docker compose logs caddy`.

## Updating

Connect over SSH and run:

```sh
cd ~/velk
docker compose pull app
docker compose up -d
```

See [updating](updating.md). Hostinger's own VPS snapshots or backups, if your plan has them, are a good extra safety net; the database dumps described in [backup and restore](backup-and-restore.md) are still the ones to restore from.
