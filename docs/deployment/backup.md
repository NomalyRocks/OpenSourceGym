# MongoDB and Redis backup / restore runbook

> This runbook is for the `docker-compose.prod.yml` production stack. In the
> development environment, the same commands run without
> `-f docker-compose.prod.yml`, without MongoDB/Redis authentication parameters,
> and with the `opengym-dev` database name.

This runbook is based on the `mongo` and `redis` services in the production
stack and the `mongo-data` and `redis-data` named volumes they use,
respectively. The `MONGO_USER`, `MONGO_PASSWORD`, and `REDIS_PASSWORD` values
used in the commands are loaded into the shell environment from the `.env`
file at the repository root; do not embed passwords in this file or in commands.

## What should be backed up?

### MongoDB: required

MongoDB stores actual business data, including members, subscriptions, entry
events, audit records, and data protection deletion requests. Regular MongoDB
backups are required. Instead of taking a direct file-system copy of the named
volume, use `mongodump` to produce a consistent logical backup from the running
database.

### Redis: normally reproducible, but check the queue

Sessions and rate-limit counters in Redis can be reproduced. Losing them
requires users to sign in again; it is not a loss of persistent business data.
However, the `og:entry-events` queue may contain entry events that have not yet
been written to MongoDB. These events may also be lost if Redis is lost.

If the latest entry events must be preserved during a disaster, also take a
Redis RDB backup. During planned maintenance, stop new entries first if
possible and wait for the queue to be transferred to MongoDB; taking only a
MongoDB backup does not include events waiting in the queue.

### Cloudflare R2: separate system

Profile photos stored in Cloudflare R2 are **not included** in the MongoDB
backup. A separate backup, versioning, or replication policy must be applied
for R2.

## Backing up MongoDB

Run the following commands at the repository root. `mongodump` runs inside the
running `mongo` service; the compressed archive output is written directly to
the `backups/` directory on the host.

```bash
set -a
. ./.env
set +a
mkdir -p backups
export OPENGYM_DB=opengym
export BACKUP_FILE="backups/${OPENGYM_DB}-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
docker compose -f docker-compose.prod.yml exec -T mongo mongodump \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --db "$OPENGYM_DB" \
  --archive \
  --gzip > "$BACKUP_FILE"
test -s "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
```

If the command fails, do not consider any incomplete archive file it may have
created to be a valid backup. Store the backup file and the `.sha256` file together.

## Restoring MongoDB

Verify the checksum first:

```bash
sha256sum -c backups/opengym-20260727T020000Z.archive.gz.sha256
```

Then restore the selected archive to the same database name:

```bash
set -a
. ./.env
set +a
export OPENGYM_DB=opengym
export BACKUP_FILE=backups/opengym-20260727T020000Z.archive.gz
docker compose -f docker-compose.prod.yml exec -T mongo mongorestore \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --archive \
  --gzip \
  --drop < "$BACKUP_FILE"
```

> **Caution:** Before restoring each collection in the archive, `--drop` deletes
> the collection with the same name and its existing data from the target
> database. Running it on the wrong server or with the wrong backup can cause
> irreversible data loss. Verify the target Compose project, archive name, and
> checksum before running it. Stop application writes for the duration of the restore.

Overwriting while preserving existing collections usually does not produce a
clean disaster recovery result; therefore, complete the test procedure below
before a production restore.

## Testing the backup in a separate database

An untested backup is not a backup. In every backup cycle, or at least once a
month, restore the archive under a separate database name and verify that it
can be opened and has the expected basic record counts.

```bash
set -a
. ./.env
set +a
export SOURCE_DB=opengym
export RESTORE_TEST_DB=opengym-restore-test
export BACKUP_FILE=backups/opengym-20260727T020000Z.archive.gz

sha256sum -c "$BACKUP_FILE.sha256"
docker compose -f docker-compose.prod.yml exec -T mongo mongorestore \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --archive \
  --gzip \
  --drop \
  --nsFrom="${SOURCE_DB}.*" \
  --nsTo="${RESTORE_TEST_DB}.*" < "$BACKUP_FILE"

docker compose -f docker-compose.prod.yml exec -T mongo mongosh "$RESTORE_TEST_DB" \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --quiet --eval '
  const names = db.getCollectionNames().sort();
  if (names.length === 0) throw new Error("No restored collections found");
  for (const name of names) print(name + "\t" + db.getCollection(name).countDocuments({}));
  assert.commandWorked(db.runCommand({ validate: names[0] }));
'
```

Check that the output contains the expected collections and reasonable record
counts. If the source system is still accessible, compare the counts of
critical collections with the source; account for small differences caused by
live writes. When the test is complete, delete only the test database:

```bash
set -a
. ./.env
set +a
export RESTORE_TEST_DB=opengym-restore-test
docker compose -f docker-compose.prod.yml exec -T mongo mongosh \
  --username "$MONGO_USER" \
  --password "$MONGO_PASSWORD" \
  --authenticationDatabase admin \
  --quiet --eval \
  "db.getSiblingDB('$RESTORE_TEST_DB').dropDatabase()"
```

## Optional Redis RDB backup and restore

First, check the queue length and the dead-letter list:

```bash
set -a
. ./.env
set +a
docker compose -f docker-compose.prod.yml exec -T redis redis-cli LLEN og:entry-events
docker compose -f docker-compose.prod.yml exec -T redis redis-cli LLEN og:entry-events:dead
```

`redis-cli` authenticates through the `REDISCLI_AUTH` variable that
`docker-compose.prod.yml` sets on the redis service, so the password never
reaches the process arguments where the container's process list would expose
it. Do not add `-a "$REDIS_PASSWORD"` back to these commands.

To take an RDB backup, have Redis write a synchronous snapshot and copy the file
to the host:

```bash
set -a
. ./.env
set +a
mkdir -p backups
export REDIS_BACKUP_FILE="backups/redis-$(date -u +%Y%m%dT%H%M%SZ).rdb"
docker compose -f docker-compose.prod.yml exec -T redis redis-cli SAVE
docker compose -f docker-compose.prod.yml cp redis:/data/dump.rdb "$REDIS_BACKUP_FILE"
test -s "$REDIS_BACKUP_FILE"
sha256sum "$REDIS_BACKUP_FILE" > "$REDIS_BACKUP_FILE.sha256"
```

A Redis restore returns existing sessions, counters, and queue state to the
backup's point in time. After stopping the application and all processes that
use Redis:

```bash
set -a
. ./.env
set +a
export REDIS_BACKUP_FILE="$PWD/backups/redis-20260727T020000Z.rdb"
sha256sum -c "$REDIS_BACKUP_FILE.sha256"
docker compose -f docker-compose.prod.yml stop redis
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -v "$REDIS_BACKUP_FILE:/restore/dump.rdb:ro" \
  redis sh -c 'cp /restore/dump.rdb /data/dump.rdb && chown redis:redis /data/dump.rdb'
docker compose -f docker-compose.prod.yml up -d redis
docker compose -f docker-compose.prod.yml exec -T redis redis-cli PING
docker compose -f docker-compose.prod.yml exec -T redis redis-cli LLEN og:entry-events
```

This operation replaces the existing `dump.rdb` file in the `redis-data`
volume. Verify the correct backup file and checksum before restoring.

## Scheduling, retention, and off-server copies

- Back up MongoDB at least daily. Increase the frequency for a shorter RPO when
  entry volume is high.
- As a starting policy, retain daily backups for 14 days, weekly backups for 8
  weeks, and monthly backups for 12 months. Document and limit these periods
  according to the business's legal and operational requirements.
- Do not keep backups only on the OpenGym server or the same physical disk.
  Transfer at least one encrypted copy to a different server or object storage.
  Assume the server and the `mongo-data` volume are lost together.
- Monitor the cron job's exit code, file size, and checksum generation; create
  an alert for failure. Schedule regular restore tests separately and record the result.

Example daily cron entry (adjust the server path for the installation):

```cron
15 2 * * * cd /opt/opengym && set -a && . ./.env && set +a && mkdir -p backups && docker compose -f docker-compose.prod.yml exec -T mongo mongodump --username "$MONGO_USER" --password "$MONGO_PASSWORD" --authenticationDatabase admin --db opengym --archive --gzip > "backups/opengym-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).archive.gz"
```

Before using the cron line, run the same command in an interactive shell. In
production, wrap the command in a backup script that checks for errors so
partial files are not considered valid backups and to handle off-server
transfer and retention operations.

## Data protection and backup security

Backups contain personal data. Strongly encrypt backup files in transit and at
rest; restrict access to authorized business personnel, log access, and keep
encryption keys separate from backups. The retention period must be limited to
its purpose, documented, and applied automatically.

When a member's deletion request is approved, copies in old backups may remain
for the backup retention period even after the data is deleted from the active
system. This copy must not be reused for normal operations; it must be removed
automatically when the relevant backup's defined retention period expires. If
a disaster restore brings back an old backup, deletion requests approved after
the backup date must be reapplied.

## Disaster recovery sequence

1. Prepare the new server securely; recover the repository/application version,
   `.env` values, and encryption secrets from a trusted source.
2. Start the `mongo` and `redis` services with `docker-compose.prod.yml`.
   After restoring the `.env` secrets from a trusted source, Compose creates
   the `mongo-data` and `redis-data` named volumes:

   ```bash
   docker compose -f docker-compose.prod.yml up -d mongo redis
   docker compose -f docker-compose.prod.yml ps
   ```

3. Verify the checksum of the latest successful MongoDB backup and restore
   MongoDB with the `mongorestore` procedure above.
4. If a Redis RDB backup was retained and events in the queue must be recovered,
   restore Redis with the procedure above. If there is no RDB, continue with an
   empty Redis instance; accept that users will need to sign in again.
5. Verify/restore R2 profile photos with their own separate recovery procedure.
6. Start the API and clients. Verify the health check, administrator sign-in,
   member and subscription counts, recent entry events, and audit records.
7. Reapply data protection deletion requests approved after the backup date;
   then enable new registrations and turnstile traffic in a controlled manner.
