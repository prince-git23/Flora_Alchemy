# Production Database Recovery Runbook

_Last executed: 2026-10-18 · Tool: `backend/scripts/recovery.mjs` (`npm run recovery`)_

This runbook is the repeatable form of the October 2026 production recovery: the
`Flora-Alchemy` database was found with all 22 collections present and every
document missing (except the default settings singleton), and it was restored
from a local Extended-JSON export. Do not re-derive that procedure from scratch
in an incident — follow the steps below.

---

## Safety rules (non-negotiable)

1. **Never print credentials** — no `.env` contents, URIs, password hashes or
   API keys in logs, reports, or commits.
2. The recovery tool acts on **`Flora-Alchemy` only**, on the verified cluster
   (`RECOVERY_EXPECTED_HOST`, defaults to the cluster used in 2026-10). Any
   other cluster is refused outright.
3. Every destructive path needs **both** `--apply` **and**
   `CONFIRM_RESTORE_PRODUCTION=Flora-Alchemy`.
4. **`--export` runs first.** Nothing overwrites production before a
   pre-restore artifact exists.
5. Never drop and recreate `Flora-Alchemy`. The tool never drops anything —
   writes are idempotent upserts on `_id`, so an interrupted restore resumes.
6. Never run `db-footprint.mjs --drop-leftovers`, a seed script, or a test
   suite against production.
7. Keep every previous export and the pre-restore artifact until the recovery
   is independently verified.

## Recovery sources

| Source | Path | Recovery point |
|---|---|---|
| Full production export (primary source) | `~/flora-alchemy-backups/20261006T013747/` | 2026-10-05 (112 documents, 19 collections) |
| Settings-only export | `~/flora-alchemy-backups/20261006T172243/` | 2026-10-06 |
| Pre-restore artifact (auto-generated) | `~/flora-alchemy-backups/pre-restore-<timestamp>/` | state immediately before the restore |
| Checksums | `~/flora-alchemy-backups/SHA256SUMS-20261006T013747.txt` | integrity of the primary source |

### Was there anything newer?

Answered systematically in [RECOVERY_WINDOW.md](./RECOVERY_WINDOW.md): every
artifact was dated three ways and diffed by `_id` against production, and **no
source on this machine holds a document newer than the October 5 export** (apart
from the incident settings singleton). Use `npm run recovery:sources` to re-run
that investigation read-only before ever planning an incremental merge.

Files are **MongoDB Extended JSON** (`EJSON`), not BSON or plain JSON — the
tool decodes with `BSON.EJSON.parse(..., { relaxed: false })` so ObjectIds,
dates, decimals and binary survive the round trip.

If a newer **Atlas point-in-time snapshot** exists that is verified and
restorable, prefer it over the October 5 export, restore it to a scratch
database first, verify, and only then cut over. Changes made after 2026-10-05
that were not in any snapshot are **not recoverable** — record that limitation
in the incident report.

## Procedure

Run from `backend/` with the production `MONGO_URI` configured.

```bash
# 1. Preserve the CURRENT production state (rollback artifact — always first)
npm run recovery -- --export

# 2. Dry run: plan + manifest, writes nothing
npm run recovery -- --restore --source=$HOME/flora-alchemy-backups/20261006T013747

# 3. Apply the restore (only after the dry-run plan looks right)
CONFIRM_RESTORE_PRODUCTION=Flora-Alchemy \
  npm run recovery -- --restore --source=$HOME/flora-alchemy-backups/20261006T013747 --apply

# 4. Independent post-restore audit (counts, owner, indexes)
npm run recovery -- --verify --source=$HOME/flora-alchemy-backups/20261006T013747
```

### What `--restore` refuses to do

- run on any cluster other than the verified one;
- write before `--export` has produced a rollback artifact (source is
  checksum-verified against the manifest immediately before writing);
- write when production is in a state it does not recognise (anything other
  than the documented incident-empty state or a state already matching the
  manifest) — a materially different production **stops the run**;
- create duplicate singleton `Settings` documents or duplicate unique keys —
  duplicate-key/validation problems are surfaced as errors, never ignored;
- regenerate `_id`s, so cross-references (users ↔ customers ↔ orders ↔
  workspaces ↔ inventory) stay intact.

## Rollback

```bash
CONFIRM_RESTORE_PRODUCTION=Flora-Alchemy \
  npm run recovery -- --rollback=$HOME/flora-alchemy-backups/pre-restore-<timestamp> --apply
```

This restores the exact pre-restore state captured in step 1.

## Post-restore verification checklist

- [ ] `--verify` reports `VERIFIED: production matches the export manifest.`
      (A live count **below** the manifest fails — that is missing restored
      data. A count **above** it is reported as documents created after the
      recovery point — post-restore activity such as a staff sign-in event —
      and does not fail, but it is always printed so foreign writes cannot
      hide.)
- [ ] Owner record present **exactly once**, active, `isFixture=false`, hash
      unchanged (compare presence only — never print the hash).
- [ ] Unique indexes intact on every collection (spot-check `users.email`,
      `settings.key`, `products.slug`, `orders.orderId`).
- [ ] Live API returns the recovered catalogue
      (`GET /api/products`, `GET /api/settings`).
- [ ] Owner signs in manually at `/owner/login` with the **original**
      password — no password reset, no `.env` fallback login.
- [ ] `node scripts/three-readiness-report.mjs --db=Flora-Alchemy` for the
      3D feature state (read-only).

## Recovered production vs. the scratch copy — do not conflate them

| | `Flora-Alchemy` (recovered production) | `Flora-Alchemy-Recovery-Scratch` (inspection copy) |
|---|---|---|
| Role | **The primary database Render uses** | An earlier ad-hoc copy made during incident triage |
| Contents | Full 5 Oct export, restored and verified | A structurally partial copy (112 docs, 15 non-empty collections, `_id_` indexes only) |
| Status | Verified: counts, indexes, single owner record, live API, owner sign-in | **Never a restore source and never a cutover artifact** |
| Disposal | Never dropped | **Preserve** until the owner explicitly authorizes disposal — it contains a copy of the owner hash and is therefore sensitive |

Only `Flora-Alchemy` is production. If both exist, never rename the scratch
over the real database: its structure is incomplete and it would silently
lose collections and indexes.

## Related safeguards

- **Data-presence alarm** — `server.js` warns loudly at boot when a production
  process is connected to a database with zero users or zero products, so an
  emptied production database can never again masquerade as a normal empty
  storefront.
- **Cleanup selection is pure and tested** — `scripts/lib/cleanupTargets.mjs`
  decides what `db-footprint.mjs --drop-leftovers` may delete; protected names
  (`Flora-Alchemy`, `flora_alchemy_dev`), the currently-configured database
  and unknown/unmarked databases are never disposable. Covered by
  `npm run test:guard`.
