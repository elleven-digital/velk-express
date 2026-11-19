# Velk Express

Velk Express is a self-hosted, open-source support panel for web agencies. One install serves one agency. It gives you:

- a **client portal** where your clients open tickets, follow replies, approve quotes and pay;
- **tickets** with rich-text messages, attachments, assignees, labels and unread tracking;
- **hours**: a monthly allowance per client, extra hours the client can buy, or internal-only tracking;
- **quotes** with a public approval page, and a "Close & execute" step that creates the client, sites, support plan and tickets for you;
- **charges**, one-time or monthly, paid through Stripe and/or Mercado Pago with your own keys, or kept as manual records.

It runs as a single Docker image, `ghcr.io/elleven-digital/velk-express`, next to a PostgreSQL database. Your data stays on your server.

## Install

<!--
  Install buttons. Replace the placeholders when the links exist:
  RAILWAY_TEMPLATE_URL   -> the Railway template link (see docs/railway-template.md)
  HOSTINGER_REFERRAL_URL -> the Hostinger VPS referral link

  [![Deploy on Railway](https://railway.com/button.svg)](RAILWAY_TEMPLATE_URL)
  [Get a Hostinger VPS](HOSTINGER_REFERRAL_URL)
-->

Pick the guide for where you want to run it:

| Where | Guide |
|---|---|
| Any server with Docker | [Docker Compose](docs/install-docker-compose.md) |
| Railway | [Railway](docs/install-railway.md) |
| Hostinger VPS | [Hostinger VPS](docs/install-hostinger-vps.md) |
| PikaPods | [PikaPods](docs/install-pikapods.md) |
| Elestio | [Elestio](docs/install-elestio.md) |

### Requirements

- PostgreSQL 17 or newer.
- 1 GB of RAM for the app (the database needs its own memory on top).
- A domain or subdomain with HTTPS, if your clients will use it or you take payments.

## After installing

1. **Open the address right away and finish the install screen.** Until someone creates the agency, the install screen is open to anyone who can reach the address.
2. Check **Settings → Installation**: the public address, e-mail, file storage and payments status.
3. Set up e-mail (SMTP) if you want invites and notifications sent by e-mail. Without it, invite and password links are shown in the panel for you to copy.
4. Invite your team, add clients and invite them to the portal.
5. To take payments, follow the [payments guide](docs/payments.md).
6. Turn on your hosting's database backups: Velk Express does not back itself up. See [backup and restore](docs/backup-and-restore.md).

## Documentation

- [Configuration](docs/configuration.md): every environment variable, e-mail, S3 storage.
- [Reverse proxy](docs/reverse-proxy.md): if you put your own proxy in front of the app.
- [Payments](docs/payments.md): Stripe and Mercado Pago.
- [Backup and restore](docs/backup-and-restore.md)
- [Updating](docs/updating.md)
- [Railway template](docs/railway-template.md): how the Railway template is built.
- [Development](docs/development.md): running from source, tests, building the image.

## License

AGPL-3.0-only. See [LICENSE](LICENSE). If you change the code and let others use it over a network, you must offer them your changed source.
