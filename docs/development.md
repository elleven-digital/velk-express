# Development

Velk Express is a Next.js app (TypeScript, Drizzle ORM, PostgreSQL). This page covers running it from source, the tests, and building the image.

## What you need

- Node.js 22 and npm 11 (`npm install -g npm@11`).
- PostgreSQL 17 or newer running locally.
- Docker, to build and try the image.

## Run from source

1. Install the dependencies:

   ```sh
   npm ci
   ```

2. Create a database:

   ```sh
   createdb velk
   ```

3. Create `.env.local` in the repository root. Start from [`.env.example`](../.env.example); the minimum is:

   ```sh
   DATABASE_URL=postgres://localhost:5432/velk
   DATA_DIR=./.dev/data
   ```

   `.env.local` is ignored by git. Put test keys for Stripe or Mercado Pago here too, never real ones.

4. Apply the migrations:

   ```sh
   npm run db:migrate
   ```

5. Start the dev server:

   ```sh
   npm run dev
   ```

   Open `http://localhost:3000` and finish the install screen.

In development, migrations are applied with `npm run db:migrate`; there is no pre-migration backup. The production image migrates on its own when it starts.

## Changing the database schema

The schema is in `src/lib/db/schema.ts`. After changing it, generate a migration and apply it:

```sh
npm run db:generate
npm run db:migrate
```

Commit the new files in `drizzle/`. Migrations must only add or safely transform: removing or renaming a column takes two releases, so a running install never loses data on update.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs the unit tests. The integration tests (`*.int.test.ts`) run only when `TEST_DATABASE_URL` is set, and they wipe that database, so it must be a separate database whose name ends in `_test`:

```sh
createdb velk_test
TEST_DATABASE_URL=postgres://localhost:5432/velk_test npm test
```

The S3 storage tests also need an S3-compatible server with an existing bucket, for example MinIO, and run only when `S3_TEST_ENDPOINT` is set:

```sh
S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=velk-test \
S3_TEST_ACCESS_KEY_ID=minioadmin S3_TEST_SECRET_ACCESS_KEY=minioadmin \
TEST_DATABASE_URL=postgres://localhost:5432/velk_test npm test
```

CI (`.github/workflows/ci.yml`) runs the typecheck, lint and all tests against PostgreSQL and an S3-compatible server (moto), and builds the image.

## Build and try the image

Build it (the build downloads fonts, so it needs network access):

```sh
docker build -t velk-express:local .
```

Run it with the Docker Compose stack, pointing `VELK_IMAGE` at your build:

```sh
cd deploy
VELK_IMAGE=velk-express:local docker compose up -d
docker compose logs -f app
```

It serves `https://localhost` with a local certificate your browser will warn about. Stop it with `docker compose down`; add `-v` to also delete its volumes (the database, files and backups).

The image runs `dist/boot.mjs` (wait for the database, back up, migrate) and then the Next.js server. `npm run build:boot` and `npm run build:cli` build those two bundles; the Dockerfile runs them for you. The admin command inside the image is `velk`, for example `velk reset-link <email>`.

## Releasing

1. Set the new version in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and commit.
2. Tag the commit `vX.Y.Z` and push the tag. The tag must match the `package.json` version, or the release fails.
3. `.github/workflows/release.yml` builds the image for amd64 and arm64, pushes `ghcr.io/elleven-digital/velk-express` with the tags `X.Y.Z`, `X.Y` and `X`, and creates a GitHub release. A tag with a hyphen (for example `v0.2.0-rc.1`) is published only under its full version and marked as a pre-release.
