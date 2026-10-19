# Recovery-Window Investigation (October 5 → October 17, 2026)

_Investigated: 2026-10-19 · Tool: `backend/scripts/recovery-sources.mjs` (`npm run recovery:sources`)_

The October 2026 recovery restored `Flora-Alchemy` to its **2026-10-05** state.
This document records the systematic search for anything created *after* that
recovery point, and the conclusion that none of it is recoverable from any source
available on this machine.

**No merge was applied.** No production write was made during this investigation.

---

## 1. Sources checked

| # | Source | Recovery point | Contents | Integrity | Verdict |
|---|---|---|---|---|---|
| 1 | `~/flora-alchemy-backups/20261006T013747/` | **2026-10-05T20:07:50Z** (newest document 2026-10-05T12:04Z) | 19 collections · 112 documents | SHA-256 verified (20 entries in `SHA256SUMS-20261006T013747.txt`) | The source already restored. A delta comparison against live finds **0 inserts, 0 conflicts** — every document is live. |
| 2 | `~/flora-alchemy-backups/20261006T172243/` | settings only; newest document 2026-09-28T16:00Z | 3 settings documents (`default`, `flora-alchemy`, `flora-alchemy-originals`) | No manifest, no checksums | **Identical to live** (0 inserts, 0 conflicts). It records no change made after October 5. |
| 3 | `~/flora-alchemy-backups/pre-restore-2026-10-18T15-09-58-102Z/` | **2026-10-18T15:10:06Z** — production immediately before the restore | 22 collections · **1 document** (settings singleton `6ad33f0e…`, last updated 2026-10-17T09:25Z) | SHA-256 verified (22 files) | **Key evidence: production already held no business documents when the restore began.** Not a recovery source — it is the rollback artifact for undoing the restore. |
| 4 | `%TEMP%/flora-alchemy-reset-backup-2026-10-01T15-05-08-179Z.json` | **2026-10-01T15:05Z** (newest document 2026-10-01T14:33Z) | 14 collections · 1,374 documents | Single JSON bundle; no manifest | **Disqualified**: predates the recovery point; 32 fixture business documents (`isFixture: true`), password hashes stripped, **no `_id` in common with live** — it is a parallel pre-reset population, not a delta. |
| 5 | `Flora-Alchemy-Recovery-Scratch` (database, same cluster) | copy of the October 5 state | 15 collections · 112 documents, 1 owner record | Structure-only (no source checksums) | **Subset of live**: all 112 `_id`s exist in production; **0 inserts**. Nothing newer. |
| 6 | MongoDB Atlas backup / PITR / Activity Feed | — | — | — | **Not inspectable from this machine**: no `ATLAS_*` API credentials are configured, and the cluster is reached only with the application connection string. Must be checked by the owner in the Atlas UI (Backup → Restore / Activity Feed). Shared-tier clusters generally do not include continuous backups; dedicated tiers do. |
| 7 | Git history, deployment logs, agent scratch output | — | — | — | No data-bearing backups. `audit/` holds probe scripts, a worktree patch and generated models (ignored, never committed). |

## 2. Dry-run comparison (read-only)

Produced by `node scripts/recovery-sources.mjs --compare=<dir>`; nothing was written.

| Source | INSERT candidates | CONFLICTS (source newer) | STALE (live newer) | Verdict |
|---|---:|---:|---:|---|
| October 5 export | 0 | 0 | 112 | fully live |
| October 6 settings export | 0 | 0 | 3 | no change |
| Pre-restore artifact | 0 | 0 | 0 | incident-state rollback point |
| October 1 temp bundle | 1,374 | 0 | 0 (0 shared ids) | parallel dataset — would duplicate identities |
| Recovery-Scratch | 0 | 0 | 112 | subset of live |

`settings` is compared for information only: it is a per-workspace singleton
addressed by `key`, so it is never merged document-by-document.

## 3. What that means for October 5 → 17

- At **2026-10-18 15:10Z** production contained exactly one document (the incident
  settings singleton, last written 2026-10-17T09:25Z). Every business collection
  was empty. The restore did not overwrite October 5–17 records — **they were
  already gone**.
- No artifact on this machine carries a document newer than **2026-10-05T20:07Z**
  except that singleton. Therefore **no October 5–17 business record is
  recoverable here**: products/inventory edits, customers, orders, custom
  requests, proposals, conversations, notifications and staff events created in
  that window are lost.
- The only surviving trace of the window is the settings singleton's
  `updatedAt` (2026-10-17T09:25Z), i.e. the shop was still being configured two
  days before the restore — settings written then are **not** in that document's
  restored counterpart beyond what the October 5 export held.

## 4. Post-recovery activity (not data loss)

`staffevents` is the one collection that legitimately exceeds the export:
69 live vs 67 in the manifest, from two `LOGIN` events (2026-10-18T18:18Z and
2026-10-19T14:06Z). `--verify` reports a surplus as activity and fails only on a
shortfall, so these do not mask a missing document.

## 5. Still open (owner action)

1. **Atlas UI**: check Backup/Restore for a snapshot newer than 2026-10-05, and
   the Activity Feed for the operation that emptied the database. If a snapshot
   exists, restore it to a **scratch** database first, then compare it with
   `scripts/recovery-sources.mjs --from-db=<scratch>` before considering a merge.
2. **Enable backups** on the production cluster once available, so the next gap
   is measured in minutes rather than days. The repository-side nightly
   backup/drill/monitoring schedule is implemented and documented in
   [BACKUP_AND_INTEGRITY.md](./BACKUP_AND_INTEGRITY.md) §5; Atlas-native
   snapshots remain an owner-level decision (§8 there).

## 6. Integrity and rollback

- The restored state is verified: `npm run recovery -- --verify --source=…` →
  `VERIFIED: production matches the export manifest.`
- The rollback artifact for the restore remains
  `pre-restore-2026-10-18T15-09-58-102Z` (the incident state). Do not delete it.
- `Flora-Alchemy-Recovery-Scratch` contains a copy of the owner password hash and
  is preserved until the owner separately authorises disposal.

## 7. Using the tool

```bash
cd backend
npm run recovery:sources                                  # inventory of every artifact
npm run recovery:sources -- --compare="$HOME/flora-alchemy-backups/20261006T013747"
npm run recovery:sources -- --bundle="$TEMP/flora-alchemy-reset-backup-2026-10-01T15-05-08-179Z.json"
npm run recovery:sources -- --from-db=Flora-Alchemy-Recovery-Scratch
npm run recovery:sources -- --db=Some-Candidate --from-db=Flora-Alchemy-Recovery-Scratch
```

It is read-only by construction (no write path), verifies each artifact against
its own checksums, dates it three ways (manifest, bundle header, newest document),
and compares by `_id` rather than by count. It prints no connection strings,
e-mail addresses or hashes.
