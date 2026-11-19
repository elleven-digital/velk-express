# Backup and restore

What to keep safe:

- **The database.** Everything except uploaded files.
- **Uploaded files.** In `DATA_DIR/files` (default `/data/files`) on disk, or in your S3 bucket.
- **Your variables** (`.env` or your platform's variables), especially the payment and SMTP secrets.

## The backups Velk Express makes

### Daily database dumps (Docker Compose)

The Docker Compose stack has a `backup` container that dumps the database every day at midnight (container time, UTC by default). Dumps are compressed SQL files (`.sql.gz`) in the `velk-backups` volume:

- `daily/`: one file per day, kept for 7 days;
- `last/`: every run, kept for 24 hours;
- `weekly/` and `monthly/`: one file per week and per month, kept for a short time;
- each folder has a `velk-latest.sql.gz` link to its newest file.

List them:

```sh
docker compose exec backup ls -l /backups/daily
```

Copy one off the server regularly: a backup on the same disk does not survive the loss of that disk. To copy the newest daily dump to the current folder:

```sh
docker compose exec -T backup cat /backups/daily/velk-latest.sql.gz > velk-$(date +%F).sql.gz
```

On other platforms, use the platform's database backups (Railway, Elestio and PikaPods have their own), or schedule `pg_dump` yourself.

### Backup before each migration (all platforms)

When a new version brings database changes, the app dumps the whole database **before** it migrates. If the dump fails, the app does not migrate and does not start, and the log says why.

- Without S3, the dump goes to `DATA_DIR/backups/pre-migration-<date-and-time>.dump` (default `/data/backups`).
- With S3, it goes to your bucket as `backups/pre-migration-<date-and-time>.dump`.
- A brand-new install has nothing to back up, so no dump is made.
- The log shows where it went: `[boot] pre-migration backup saved to ...`.

These files are made with `pg_dump --format=custom` from PostgreSQL 18. Restore them with `pg_restore` **18 or newer**; older versions cannot read them. They are not deleted automatically: remove old ones yourself once you no longer need them.

`SKIP_PRE_MIGRATION_BACKUP=true` turns this backup off. Use it only if you have no writable place for the dump and you have another, recent backup.

### Uploaded files

Velk Express does not back up uploaded files. Back up the `/data` volume (Docker Compose: the `velk-data` volume) with your server's or platform's backups, or use your bucket's versioning or replication with S3.

To copy the files out of the Docker Compose stack:

```sh
docker compose cp app:/data/files ./velk-files
```

## Restoring

Restoring replaces the whole database with the backup. Everything written after the backup is lost. Stop the app first, and make a fresh backup of the current state if you can.

The examples use the Docker Compose stack, run from the folder with `docker-compose.yml`. The database name and user are `velk`.

### From a daily dump (`.sql.gz`)

```sh
docker compose stop app
docker compose exec db psql -U velk -d postgres -c 'DROP DATABASE velk WITH (FORCE)' -c 'CREATE DATABASE velk OWNER velk'
docker compose exec -T backup cat /backups/daily/velk-latest.sql.gz | gunzip | docker compose exec -T db psql -U velk -d velk -v ON_ERROR_STOP=1
docker compose start app
```

To restore an older day, replace `velk-latest.sql.gz` with that file's name from `docker compose exec backup ls /backups/daily`.

### From a pre-migration backup (`.dump`)

Use this to go back to the version you ran before an update (see [updating](updating.md)): restore the dump, then run the **previous** version of the image. If you start the new version on the restored database, it simply migrates again.

1. Find the file name in the log line `pre-migration backup saved to ...`, or list them:

   ```sh
   docker compose run --rm --no-deps --entrypoint ls app -l /data/backups
   ```

2. Stop the app and empty the database:

   ```sh
   docker compose stop app
   docker compose exec db psql -U velk -d postgres -c 'DROP DATABASE velk WITH (FORCE)' -c 'CREATE DATABASE velk OWNER velk'
   ```

3. Restore with the `pg_restore` 18 that ships in the app image. The `app` service already has `DATABASE_URL`, so no password is typed. Replace `<file>` with the file name:

   ```sh
   docker compose run --rm --no-deps --entrypoint sh app -c \
     'pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL" /data/backups/<file>'
   ```

4. Pin the previous version in `.env`, for example `VELK_IMAGE=ghcr.io/elleven-digital/velk-express:0.1.0`, then start it:

   ```sh
   docker compose up -d
   ```

### On other platforms

You need `pg_restore` 18 or newer on your computer, or Docker. Download the `.dump` file (from your bucket, or from the `/data/backups` folder of the app's volume), stop the app, and run, with your database's connection string:

```sh
psql "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS drizzle CASCADE' -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL" pre-migration-<date-and-time>.dump
```

The first command empties the database: the `public` schema holds the data and the `drizzle` schema records which migrations ran. Without a local `pg_restore` 18, run it from Docker:

```sh
docker run --rm -v "$PWD:/backup" postgres:18 pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL" /backup/pre-migration-<date-and-time>.dump
```

The connection string must be reachable from inside that container: use the database's public connection string. For a database on the same machine, add `--network host` to `docker run` (Linux), or use `host.docker.internal` as the host in the connection string (Docker Desktop).

Then start the version of the app that matches the backup.

### Files

If you restored the database to an earlier point, files uploaded after that point stay in storage without a record. Nothing shows them; they only take space. Files that were deleted after that point are gone unless you restore them from your file backup:

```sh
docker compose cp ./velk-files/. app:/data/files
docker compose restart app
```

## Recovering the owner account

If the owner forgets the password and e-mail is not set up, create a password link from the server:

```sh
docker compose exec app velk reset-link owner@example.com
```

On other platforms, run `velk reset-link owner@example.com` in a shell inside the app's container.

It prints a link valid for 2 hours that works once. Earlier reset links for that person stop working. It covers team accounts only; without e-mail, portal users cannot reset their password themselves. The agency gives them a new access link: open the client in the panel, go to the Access tab and use Resend invite (or Reset link) for that person.
