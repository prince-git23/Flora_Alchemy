# Backups, Data-Integrity Monitoring & Recovery Assurance

_Phase 8 (October 2026). Tool: `backend/scripts/backup.mjs` · Suite: `npm run test:backup`_
_Companion runbook for a restore: [RECOVERY.md](./RECOVERY.md) · Window analysis: [RECOVERY_WINDOW.md](./RECOVERY_WINDOW.md)_

October 2026 had two failures, not one: production was **emptied**, and nothing
**noticed** or could **roll back** to a recent state — the newest recoverable
export was five days old. This document is the missing half of the recovery
runbook: how recovery points are created, verified, monitored, alerted on and
regularly proven restorable.

---

## 0. Honest status (read this first)

| Component | State |
|---|---|
| Backup/verify/monitor/drill CLI (`scripts/backup.mjs`) | **Implemented and tested** — 117 assertions in `npm run test:backup`, including a real restore drill with API sign-in |
| Nightly scheduler (`.github/workflows/backup-nightly.yml`) | **Committed but NOT ACTIVE** — it fails loudly until the owner adds the five repository secrets in §5 |
| Off-host encrypted destination | **Not yet provisioned** — needs an S3/R2 bucket + credentials (owner, §5) |
| Alert delivery | **Code-tested against a loopback receiver; NOT delivered to a real channel** — owner must set `ALERT_WEBHOOK_URL` and send a test (§6) |
| Accepted baseline | **Not yet recorded** — run `npm run backup -- --accept-baseline` after the first verified export (§5) |
| First scheduled restore drill | **Not yet run** outside the test suite — the nightly job runs one once configured (§7) |
| Atlas-native backups / PITR | **Unknown — owner must inspect** the Atlas UI (§8). The application has no Atlas account credentials and none are stored in this repository |

**Do not treat backups as active because this file exists.** Backups become real
when (a) a scheduled run succeeds, (b) the uploaded artifact verifies, and
(c) a restore drill passes against the uploaded artifact. Each produces evidence
in §9.

---

## 1. What the system does

Every night (once configured) the scheduler:

1. **Exports** every collection of the production database to an artifact:
   Extended-JSON payloads + `manifest.json` (counts, index inventory, recovery
   point) + `SHA256SUMS.txt` + a `.complete.json` marker written last.
2. **Seals** the payload with AES-256-GCM (scrypt-derived key, per-archive
   salt). An interrupted export never produces a completion marker and is never
   treated as a recovery point.
3. **Uploads** the artifact to off-host object storage (S3 or R2 via its
   S3-compatible API), together with a `state/last-backup.json` receipt.
4. **Restores** the newest verified artifact into a **disposable** drill
   database, verifies counts, index recreation, single-owner identity, catalogue
   readability and the real API sign-in contract (correct password accepted,
   wrong password refused), then disposes of the drill database through the
   protected cleanup tool.
5. **Assesses** live integrity and freshness (§4) and **alerts** on any
   non-healthy verdict, with a 6-hour deduplication cooldown.

The restore path for a real incident is still `npm run recovery` —
[RECOVERY.md](./RECOVERY.md). This tool never restores into production and has
no code path that can.

## 2. Artifact format (`flora-backup/1`)

```
<root>/flora-backup-<ISO-timestamp>/
  manifest.json      format, source database + host, recovery point,
                     per-collection document counts/bytes/SHA-256,
                     full index inventory, encryption mode
  SHA256SUMS.txt     checksums of every payload file
  <collection>.ejson one Extended-JSON document per line  (plaintext mode)
  archive.fb1        magic ‖ salt ‖ iv ‖ GCM tag ‖ gzip(payload)  (encrypted mode)
  .complete.json     written LAST — absence means "interrupted export"
```

- Default root: `~/flora-alchemy-backups` (override with `BACKUP_ROOT`).
  **Never inside the Git repository** — `.gitignore` also defends an explicit
  in-tree root.
- Encryption is **mandatory for upload**: `--upload` refuses an unencrypted
  artifact. Plaintext artifacts exist for local, same-host drills only.
- Retention keeps the newest `BACKUP_RETENTION_COUNT` (default 14) *scheduled*
  artifacts. Pre-restore/recovery evidence artifacts are never pruned, and
  `--prune` is a dry run until `--apply` is passed.

## 3. Commands (run from `backend/`)

```bash
npm run backup -- --export [--encrypt]   # create a recovery point
npm run backup -- --verify [--artifact=<dir>] [--require-encryption]
npm run backup -- --status [--json] [--notify]     # read-only monitoring run
npm run backup -- --accept-baseline                # record the healthy reference
npm run backup -- --restore-drill --target=Flora-Alchemy-Test-Backup-Drill [--reset-drill]
npm run backup -- --decrypt --artifact=<dir> --out=<dir>   # for recovery.mjs
npm run backup -- --prune [--keep=14] [--apply]
npm run backup -- --upload [--artifact=<dir>] [--dry-run]
```

Exit codes (shared by every mode): **0** healthy/success · **2** warning ·
**1** critical/failure · **3** unknown (a check could not run — never reported
as success).

Guarantees:

- `--status`, `--verify` and `--prune` (without `--apply`) are **read-only** and
  never touch any database or delete anything.
- `--restore-drill` refuses any target that is protected
  (`Flora-Alchemy`, `flora_alchemy_dev`, anything named in
  `PRODUCTION_DB_NAMES`), not unmistakably disposable (`Flora-Alchemy-Test-*`
  or operator-`--allow`ed), or the configured source database. The drill always
  disposes of its target through `db-footprint.mjs --only=<exact name>`.
- Nothing prints credentials, connection strings, password hashes or document
  contents.

## 4. Integrity assessment (`--status`)

Verdicts: **healthy** · **warning** · **critical** · **unknown**. Checks:

| Check | Critical when | Warning when |
|---|---|---|
| `collections.essential` | any of users/products/settings/collections/customers/orders/inventories missing | — |
| `identity.owner` | owner ≠ exactly 1 · not `ACTIVE` · no password hash | fixture accounts present |
| `catalogue.visible` | zero storefront-visible products | — |
| `indexes.required` | — | a required unique index (users.email, products.slug, orders.orderId, settings.key, collections.slug, inventories.productSlug) is missing |
| `baseline.drop` | a critical collection (users/products/customers/orders) fell ≥ `BACKUP_MAX_DROP_PCT` % **and** ≥ `BACKUP_MIN_DROP_DOCS` below the accepted baseline | same rule on any other collection |
| `backup.freshness` | no verified artifact · recovery point > 2 × `BACKUP_MAX_AGE_HOURS` old · newest artifact fails verification | recovery point > `BACKUP_MAX_AGE_HOURS` old · a newer attempt is incomplete |
| `drill` | most recent drill failed | no drill recorded · last passing drill older than `BACKUP_DRILL_MAX_AGE_DAYS` |
| `monitor.schedule` | — | the previous run is > 2 × `BACKUP_RUN_INTERVAL_HOURS` old (dead-man's switch) |
| `references.orders` / `references.inventory` | — | orders reference missing customers / inventory rows reference missing products |
| `database` | — | (status `unknown`) the database could not be read at all |

Design rules that prevent alert fatigue **and** silent failure:

- Drift is measured against the **operator-accepted baseline**
  (`--accept-baseline`), never against hard-coded historical counts. **Growth
  never alerts.** Delete `state/baseline.json` to disable drift comparison —
  an absent baseline is itself a warning, never a pass.
- A restored-from-old-recovery-point database is compared to the baseline
  accepted *after* the restore, so the restored state is not falsely alarming.
- A database that cannot be read is **unknown** (exit 3), never healthy.
- A **newer** artifact that fails its own checksums fails the run even when an
  older artifact still verifies — that is a broken pipeline, not history.

## 5. Enabling the nightly schedule (owner setup — required)

Until these steps are done, `.github/workflows/backup-nightly.yml` runs nightly
and **fails with the list of missing settings**. That is deliberate: an
unconfigured backup system must look broken, not green.

1. **Dedicated Atlas backup account** (narrowly scoped, never the application's
   user). In Atlas → Database Access → Database Users → *Add new user*:
   - Authentication: SCRAM, a generated password (stored in your password
     manager — it is never written into this repository),
   - Privileges: role `read` on the built-in database `Flora-Alchemy`, **and**
     role `readWrite` on `Flora-Alchemy-Test-Backup-Drill` (the drill target
     only).
2. **Network access** (Atlas → Network Access): the GitHub Actions runners must
   be able to reach the cluster. The narrow option is the runner IP ranges
   published by GitHub (they change; Atlas will need periodic updating). The
   durable option is a CIDR allowlist entry you are comfortable with. If neither
   is acceptable, use the Render cron alternative below instead.
3. **Off-host destination**: create a private bucket (e.g. Cloudflare R2 — no
   egress fees — or AWS S3) and a credential pair limited to that bucket's
   prefix. Enable server-side encryption (SSE-S3 or SSE-KMS; R2 encrypts at
   rest by default). Add a **lifecycle rule** expiring objects under
   `flora-alchemy/` after ~45 days — that is the remote half of retention.
4. **Repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `BACKUP_MONGO_URI` | the Atlas URI of the **backup account** from step 1, database `Flora-Alchemy` |
   | `BACKUP_ENCRYPTION_KEY` | a random ≥ 16-character passphrase (e.g. `openssl rand -base64 32`) — losing it loses the backups |
   | `BACKUP_S3_BUCKET` / `BACKUP_S3_PREFIX` | bucket name and prefix (e.g. `flora-alchemy`) |
   | `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` | endpoint (R2/MinIO only) and region (`auto` for R2; e.g. `eu-west-1` for S3) |
   | `BACKUP_AWS_ACCESS_KEY_ID` / `BACKUP_AWS_SECRET_ACCESS_KEY` | the bucket-scoped credential pair |
   | `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_TOKEN` | optional — see §6 |

5. **First run and baseline**: Actions → *Backup & Integrity (nightly)* →
   *Run workflow* (`mode: full`). Confirm the run is green, the bucket contains
   a `flora-backup-*` artifact, and `state/last-backup.json` exists. Then, from
   a machine with production `MONGO_URI` configured:

   ```bash
   npm run backup -- --verify            # proves the local artifact
   npm run backup -- --accept-baseline   # records the healthy reference counts
   ```

   The next nightly run persists the baseline off-host (the workflow syncs
   `state/` to the bucket before and after every run) and drift detection
   becomes active. **Only accept a baseline from a state you know is healthy.**

6. **Render cron alternative** (if GitHub runners may not reach Atlas): create a
   Render **cron job** (starter plan or above) on the same repository,
   `cd backend && npm install && node scripts/backup.mjs --export --encrypt
   --upload && node scripts/backup.mjs --restore-drill
   --target=Flora-Alchemy-Test-Backup-Drill --reset-drill && node
   scripts/backup.mjs --status --notify`, daily schedule, with the `BACKUP_*`
   and `ALERT_*` environment variables set in the dashboard and a persistent
   disk for `BACKUP_ROOT`. Keep `MONGO_URI` in the cron job's own environment
   scoped to the backup account. Either mechanism is fine — **one** must run.

## 6. Alerting

`--status --notify` and the workflow's failure hook POST a minimal JSON payload
to `ALERT_WEBHOOK_URL`:

```json
{ "source": "flora-alchemy", "status": "critical", "at": "2026-10-19T02:17:00Z",
  "runbook": "…/docs/BACKUP_AND_INTEGRITY.md",
  "failures": [ { "id": "backup.freshness", "status": "critical", "detail": "…" } ],
  "backup": { "recoveryPoint": "2026-10-18T02:17:03Z" } }
```

- Contains status, time, failing check ids and the recovery point — **never**
  customer data, connection strings, hashes or counts of business records.
- Any Slack/Discord/Teams incoming webhook (or a tiny HTTP receiver) works;
  set `ALERT_WEBHOOK_TOKEN` if the receiver expects a Bearer token.
- One ongoing incident alerts once per `ALERT_COOLDOWN_HOURS` (default 6) per
  failure fingerprint; the cooldown state lives in `state/alerts.json`
  (persisted off-host by the workflow).
- A failed delivery is **exit 3**, never success: silence is never mistaken for
  health.
- **Test it**: once `ALERT_WEBHOOK_URL` is set, temporarily edit a local
  manifest's `createdAt` to be 100 hours old (or wait for a real warning) and
  run `npm run backup -- --status --notify`; confirm the message arrives. Record
  the date in §10.

## 7. Restore drills

A backup nobody has restored is a hypothesis. The nightly drill:

1. selects the newest **verified** artifact (an unverified artifact refuses the
   drill),
2. restores every collection — including empty ones — into
   `Flora-Alchemy-Test-Backup-Drill` (protected-name, disposable-marker and
   same-as-source refusals all apply),
3. recreates the source's indexes from the manifest inventory,
4. compares per-collection counts with the manifest,
5. confirms exactly one `ACTIVE` owner with a password hash present
   (presence only — the hash is never printed),
6. boots the real API against the drill database and proves the authentication
   contract: a drill-only fixture identity signs in with the correct password
   and is refused with a wrong one,
7. confirms the recovered catalogue has a storefront-visible product,
8. writes a receipt (duration, recovery point, results, problems) under
   `state/drills/`, disposes of the drill database through the protected
   cleanup tool, and alerts if anything failed.

Drill frequency: nightly with the schedule (cheap — the fixture database is
tiny and disposed immediately). `BACKUP_DRILL_MAX_AGE_DAYS` (default 30) turns
an overdue drill into a warning.

**RPO / RTO — recommended initial targets, not guarantees.** They are only
honest once the schedule has run and a drill has timed:

- **RPO ≤ 24 hours** (nightly export; `BACKUP_MAX_AGE_HOURS=30` gives one
  missed run of slack before a warning, 60 before critical).
- **RTO ≤ 2 hours** for a database of the current size (a full drill of the
  October-5-scale database restores and verifies in well under a minute; the
  rest of the budget is investigation and cutover). Re-measure from the drill
  receipts after the first scheduled drills and adjust the doc, not the hope.

## 8. Atlas owner checklist (incident follow-up)

The prior investigation could not inspect Atlas — no account-level access
exists in this repository, and none may be extracted from local env files. The
owner must do this in the Atlas UI:

1. **Activity Feed** (Project → Activity Feed, filter 2026-10-06 → 2026-10-18):
   look for `deleteMany`/`deleteDocument`/`drop` operations, the actor
   (a DB user, an API key, Atlas UI) and the source IP. Until such an entry is
   found, **the deletion cause is not established** — the pre-restore artifact
   proves *that* production was empty by 2026-10-18, not *why*.
2. **Backup → Restore** (or Cloud Backups): list available snapshots and their
   point-in-time ranges. If a snapshot covering 2026-10-05 → 2026-10-18
   exists, restore it to a **scratch** database and compare with
   `npm run recovery:sources -- --from-db=<scratch>` **before** considering any
   merge into production. See [RECOVERY_WINDOW.md](./RECOVERY_WINDOW.md) §5.
3. **Cluster tier**: M0 (free) has no continuous backups and only manual
   snapshots with limited retention. A dedicated tier (M10+) includes daily
   snapshots and, on paid backup tiers, point-in-time recovery. If the cluster
   is M0, **native backups are not available** and the logical-backup schedule
   in §5 is the primary safety net — upgrading the cluster is an owner decision
   with real cost; do not do it autonomously.
4. **Enable/validate backups**: if on a paid tier, enable cloud backups with
   PITR, a retention window (recommend ≥ 7 days) and confirm the storage
   region. This is an owner-level setting; nothing in this repository can or
   should do it.
5. **Record** in §10: the tier, whether native backups are enabled, the newest
   snapshot timestamp, and the date the Activity Feed was inspected.

## 9. Evidence trail (auditable)

| Evidence | Where |
|---|---|
| Every recovery point | `<BACKUP_ROOT>/flora-backup-*/manifest.json` + upload receipt `state/last-upload.json` and the remote `state/last-backup.json` |
| Monitoring runs | `state/last-run.json` (status, failing check ids, recovery point) — persisted off-host |
| Accepted baseline | `state/baseline.json` (counts, acceptance time, recovery point) |
| Restore drills | `state/drills/<timestamp>.json` + `state/drills/latest.json` (duration, counts, indexes, problems) |
| Alert dedup | `state/alerts.json` |
| Scheduled runs | GitHub Actions run history for *Backup & Integrity (nightly)* |

## 10. Operational log (fill in as things actually happen)

| Event | Date | By | Note |
|---|---|---|---|
| Backup CLI + monitor + drill implemented; 117-assertion suite green | 2026-10-19 | Phase 8 | `npm run test:backup` |
| Nightly workflow committed (inactive until secrets) | 2026-10-19 | Phase 8 | `.github/workflows/backup-nightly.yml` |
| Atlas Activity Feed inspected (Oct 6–18) | _not yet_ | owner | §8.1 |
| Native Atlas backups enabled (tier: _) | _not yet_ | owner | §8.3–4 |
| Off-host bucket provisioned + secrets set | _not yet_ | owner | §5 |
| First scheduled nightly run green | _not yet_ | — | Actions history |
| First baseline accepted | _not yet_ | owner | §5.5 |
| Alert delivery tested to a real channel | _not yet_ | owner | §6 |
| First scheduled restore drill passed | _not yet_ | — | `state/drills/latest.json` |

## 11. Limitations (unchanged by this phase)

- **October 5–17, 2026 remains unrecoverable** from local sources — see
  [RECOVERY_WINDOW.md](./RECOVERY_WINDOW.md). Only an Atlas snapshot, if one
  exists, could change that.
- A logical export is a **point-in-time copy**, not PITR: transactions committed
  between nightly runs are lost in an incident. Native Atlas PITR (§8.4) is the
  only finer-grained option and requires an owner decision.
- The scheduled job depends on its secrets and destination: if the bucket or the
  Atlas allowlist breaks, runs fail loudly (and alert) — but a long-enough
  outage of GitHub Actions themselves would only be caught by the dead-man's
  switch on the next successful run. Atlas-native backups remain the redundant
  layer worth having.
- CI artifacts and developer workstations are **not** backup locations; the
  drill databases are **not** recovery sources; the Git repository stores
  **no** production data — by design.
