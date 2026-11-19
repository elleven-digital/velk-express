# Reverse proxy

The Docker Compose stack comes with Caddy already set up. Read this page if you put your own proxy in front of the app instead: an existing nginx or Caddy, a load balancer, or a CDN.

The app listens on plain HTTP on `PORT` (default `3000`). Your proxy handles HTTPS and must meet the requirements below.

## Requirements

1. **Forward `X-Forwarded-For` and `X-Forwarded-Proto`.**
   - The app takes the visitor's IP address from the **last** value of `X-Forwarded-For`, the one your proxy appends. Without it, the per-address attempt limits on team and portal logins, password resets, payment links (`/pay`) and quote approvals (`/q`) are off; only the per-account limits on logins and resets remain.
   - `X-Forwarded-Proto` (and `X-Forwarded-Host`, if the proxy changes the host) lets the install screen detect the right `https://` address.
   - If another proxy or CDN sits in front of yours, make sure the last value your proxy appends is the visitor's address and not the CDN's (in nginx, the `real_ip` module; in Caddy, `trusted_proxies`).
2. **Pass webhooks through untouched** (`/api/webhooks/stripe` and `/api/webhooks/mercadopago`):
   - keep the query string as it is: Mercado Pago signs the `data.id` value in it;
   - keep the `X-Request-Id` header as it arrives: Mercado Pago signs it too. Some proxies replace it with their own request id;
   - do not rewrite, decompress or re-encode the body, and do not redirect these requests: Stripe signs the raw body, and a provider does not follow redirects.
3. **Allow at least 35 seconds** before timing out a response on `/pay/`. Opening a payment link creates a checkout at the provider, with retries.
4. **Body size limits:**
   - `/api/upload`: up to 26 MB (files are limited to 25 MB). Turn off request buffering there if your proxy allows it.
   - `/api/webhooks/`: a small limit is enough, for example 1 MB.
   - everything else: at least 3 MB (the logo upload is up to 2 MB).
5. **Mind your access logs.** Payment links (`/pay/<token>`), public quotes (`/q/<token>`) and password links (`/set-password/<token>`) carry their secret in the address. Anyone who reads the access logs can open them. Keep those logs private, or leave the path out of them.

Set `APP_URL` to the public `https://` address, so links and webhook addresses never depend on what the proxy sends.

## Caddy

```caddyfile
panel.example.com {
	@upload path /api/upload
	request_body @upload {
		max_size 26MB
	}

	@webhooks path /api/webhooks/*
	request_body @webhooks {
		max_size 1MB
	}

	reverse_proxy 127.0.0.1:3000
}
```

Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` on its own, keeps the query string and headers, and has no response timeout by default.

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    client_max_body_size 3m;

    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }

    location = /api/upload {
        client_max_body_size 26m;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:3000;
    }

    location /api/webhooks/ {
        client_max_body_size 1m;
        proxy_pass http://127.0.0.1:3000;
    }

    location /pay/ {
        proxy_read_timeout 60s;
        proxy_pass http://127.0.0.1:3000;
    }
}

server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
```

Notes:

- `proxy_pass` without a path after the port passes the original path and query string unchanged. Keep it that way.
- nginx passes `X-Request-Id` through as it arrives. Do not add `proxy_set_header X-Request-Id $request_id;` for the webhook location.
- The `proxy_set_header` lines at the `server` level apply to every `location` as long as no `location` sets its own.
- nginx's default `client_max_body_size` is 1 MB, too small for the logo upload; hence `3m` at the server level.

## Running the app container behind your proxy

To run only the app and the database from the compose stack, remove the `caddy` service from `docker-compose.yml` and publish the app's port on the loopback address:

```yaml
  app:
    ports:
      - "127.0.0.1:3000:3000"
```

Then point your proxy at `127.0.0.1:3000`.
