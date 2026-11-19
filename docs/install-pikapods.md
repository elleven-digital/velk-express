# Install on PikaPods

PikaPods runs open-source apps for you from its own catalog. PikaPods writes and maintains the recipe for each app; this repository only provides the image, `ghcr.io/elleven-digital/velk-express`.

PikaPods only runs apps from its catalog. If Velk Express is not listed there yet, you can ask for it on PikaPods' feedback page, and use one of the other guides in the meantime.

## What will be created

- A pod running the Velk Express image.
- A PostgreSQL database for it (provided by PikaPods as part of the recipe).
- Persistent storage for the pod.
- An address with HTTPS, on a PikaPods subdomain or your own domain.

## Step by step

1. In PikaPods, add a new pod and choose Velk Express from the catalog.
2. Pick the resources. Give the app at least 1 GB of RAM.
3. Before the first start, check the pod's settings against the list below.
4. Start the pod and open its address.
5. **Finish the install screen right away.** Until someone creates the agency, the install screen is open to anyone who can reach the address.
6. Check **Settings → Installation**: the public address must be the pod's address, and file storage must be "writable".

## What to check

Whatever the recipe looks like, these must hold:

- **Persistent storage at `/data`.** Uploaded files and the backups taken before migrations go to `/data` (`DATA_DIR`). If the pod's persistent folder is mounted elsewhere, set `DATA_DIR` to that path. If the folder is not persistent, files are lost on restart; if it is not writable, Settings → Installation shows file storage as "not writable".
- **`APP_URL`** set to the pod's public address with `https://`, for example `https://your-pod.pikapod.net` or your own domain. It is used in e-mail links and payment webhooks. Without it, the install screen asks you to confirm the address it detected.
- **`DATABASE_URL`** pointing to a PostgreSQL 17 or newer database.

E-mail, S3 storage and payments are optional. If the pod's settings let you add environment variables, see [configuration](configuration.md).

## Domain and HTTPS

PikaPods serves the pod over HTTPS. If you use your own domain, follow PikaPods' instructions for custom domains, then set `APP_URL` to `https://` plus that domain.

## Updating

PikaPods updates pods to new releases of the app. A new release backs up the database before migrating; see [updating](updating.md) and [backup and restore](backup-and-restore.md).
