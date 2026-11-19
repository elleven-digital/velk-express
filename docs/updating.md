# Updating

**Back up the database before every update** (see [backup and restore](backup-and-restore.md)). Velk Express does not back itself up.

Updating means running a newer image and restarting. When the app starts, it:

1. waits for the database;
2. applies the new version's database changes (migrations), if there are any;
3. starts.

Pending migrations run in a single transaction. If one fails, none of them is kept, the database is left as it was, and the app does not start. The log says why:

```
[boot] failed: Migration failed: <reason>. The database was left unchanged; go back to the previous version and report the error.
```

## When there is a new version

With `UPDATE_CHECK` on (the default), the owner and managers see a notice in the panel when a newer release is published, and **Settings → Installation** shows the latest release. Read the release notes on GitHub before updating.

## Image tags

The image is `ghcr.io/elleven-digital/velk-express`. Each release `X.Y.Z` is published with three tags:

| Tag | Follows |
|---|---|
| `0` | the newest `0.x.x` release |
| `0.1` | the newest `0.1.x` release |
| `0.1.0` | exactly that release |

The guides use `:0`, so pulling the image again gets the newest release with the same major version. A new major version (for example `1`) can need steps described in its release notes; you move to it by changing the tag yourself. With `:0`, anything that pulls the image again (a redeploy, a restart on some platforms, an automatic update) can bring a new release and its migrations. Pin an exact version (`:0.1.0`) if you want every update to be a step you take, after a backup.

## How to update on each platform

Take a backup first, whatever the platform.

### Docker Compose and Hostinger VPS

From the folder with `docker-compose.yml`, after a backup (`docker compose exec -T db pg_dump -U velk velk | gzip > velk-$(date +%F-%H%M).sql.gz`):

```sh
docker compose pull app
docker compose up -d
docker compose logs -f app
```

Wait for `[boot] ready`. If you pinned a version with `VELK_IMAGE` in `.env`, change it to the new version first.

### Railway

Redeploy the Velk Express service so Railway pulls the image again, or use the update option Railway shows in the service settings when it finds a newer image. Railway can also update automatically on a schedule you set there. Watch the deploy logs for `[boot] ready`.

### Elestio

For a custom Docker Compose service, redeploy it from Elestio, or run in a terminal on the service:

```sh
docker compose pull app
docker compose up -d
```

For a catalog service, use Elestio's update option for the app.

### PikaPods

PikaPods updates pods to new releases. Check the pod's settings for its update options.

## Going back to an earlier version

If the update failed while migrating, the database was not changed: run the previous version's exact tag, for example `ghcr.io/elleven-digital/velk-express:0.1.0`.

If the new version started and you still want to go back, there is no in-place downgrade: an older version cannot run on a database that a newer version has already migrated. To go back:

1. stop the app;
2. restore the backup you took before the update (see [restoring](backup-and-restore.md#restoring));
3. run the previous version's exact tag.

Anything written after that backup is lost. Then report the problem, with the log, on GitHub.
