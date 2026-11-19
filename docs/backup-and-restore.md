# Backup and restore

What to keep safe:

- **The database.** Everything except uploaded files.
- **Uploaded files.** In `DATA_DIR/files` (default `/data/files`) on disk, or in your S3 bucket.
- **Your variables** (`.env` or your platform's variables), especially the payment and SMTP secrets.

## Turn on backups before you use the panel

Velk Express does not back itself up, like most self-hosted apps: backups are your hosting's job. Turn them on right after the install, and take one before every update (see [updating](updating.md)).

| Where it runs | Database backups |
|---|---|
| Docker Compose, Hostinger VPS | The stack's `backup` container, described below. A VPS snapshot from your provider is a good second copy. |
| Railway | Turn on scheduled backups in the Postgres service's backup settings (daily, plus weekly if you want a longer history). |
| Elestio | Elestio's automatic backups of the service. |
| PikaPods | PikaPods' own backups of the pod. |
| Anything else | Schedule `pg_dump` yourself, and keep the copies off the database server. |

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

To take one right now, for example before an update:

```sh
docker compose exec -T db pg_dump -U velk velk | gzip > velk-$(date +%F-%H%M).sql.gz
```

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

To go back to the version you ran before an update, restore the backup you took before it, then pin that version in `.env` (for example `VELK_IMAGE=ghcr.io/elleven-digital/velk-express:0.1.0`) and run `docker compose up -d`. If you start the newer version on the restored database, it simply migrates again.

To restore a dump you copied off the server instead, replace the third command with:

```sh
gunzip -c velk-<date>.sql.gz | docker compose exec -T db psql -U velk -d velk -v ON_ERROR_STOP=1
```

### On other platforms

Use your platform's restore option for the database. Then start the version of the app that matches the backup.

To restore a dump made with `pg_dump` yourself, stop the app and empty the database first, with your database's connection string:

```sh
psql "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS drizzle CASCADE' -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
```

The `public` schema holds the data and the `drizzle` schema records which migrations ran. Then load the dump: a plain SQL file with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <file>.sql`, or a custom-format file (`pg_dump --format=custom`) with `pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL" <file>.dump`. Use client tools at least as new as the version that made the dump.

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
