# Updating

Updating Velk Express means running a newer image and restarting. When the app starts, it:

1. waits for the database;
2. if the new version has database changes, backs up the database (see [backup and restore](backup-and-restore.md#backup-before-each-migration-all-platforms));
3. applies the changes (migrations);
4. starts.

If the backup fails, nothing is migrated and the app does not start; the log says why. If a migration fails, the app does not start, and the log shows the error and where the backup is:

```
[boot] failed: Migration failed: <reason>. A backup taken before the migration is at /data/backups/pre-migration-<date-and-time>.dump.
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

The guides use `:0`, so pulling the image again gets the newest release with the same major version. A new major version (for example `1`) can need steps described in its release notes; you move to it by changing the tag yourself. Pin an exact version (`:0.1.0`) if you want to decide every update.

## How to update on each platform

### Docker Compose and Hostinger VPS

From the folder with `docker-compose.yml`:

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

There is no in-place downgrade: an older version cannot run on a database that a newer version has already migrated. To go back, restore the backup taken before the migration and run the previous image tag:

1. stop the app;
2. restore the backup taken before the migration (see [restoring a pre-migration backup](backup-and-restore.md#from-a-pre-migration-backup-dump));
3. run the previous version's exact tag, for example `ghcr.io/elleven-digital/velk-express:0.1.0`.

Then report the problem, with the log, on GitHub.

## Skipping the pre-migration backup

The backup needs a writable `DATA_DIR` (or S3). If you have neither, the update stops with:

```
[boot] failed: A pre-migration backup is required but /data/backups is not writable. Mount a writable DATA_DIR, configure S3, or set SKIP_PRE_MIGRATION_BACKUP=true.
```

Fix the storage if you can. Otherwise, take a backup another way, then set `SKIP_PRE_MIGRATION_BACKUP=true` for this update and remove it afterwards. Without a backup there is no way back if a migration fails.
