# Release status — 2026-10-17 (Phase 10 remediation release)

> The single, measured verification record for the current `main` tree. Every number
> here was produced by running the command shown; nothing is copied from an older
> document, and nothing is estimated. Related: [TESTING.md](./TESTING.md) (how the
> suites work), [DEPLOYMENT.md](../DEPLOYMENT.md) (hosts, media disk, rollback),
> [ARCHITECTURE.md](./ARCHITECTURE.md), [MEMORY.md](./MEMORY.md#phase-10--remediation-release-gate--private-media-durability-2026-10-17).
>
> **Superseded as the current-tree record** by the 2026-10-19 sweep taken after
> Phase 8 (backup work): **31 suites · 2850 pass · 0 fail**, exit 0, plus boot gate
> 27/0 and frontend build green — reported in [TESTING.md](./TESTING.md#verified-current-result).
> The tables below remain the Phase 10 release record and are not restated.

## Starting point

| | |
|---|---|
| Release audited | `d7ebf9c` — "fix(release): ship the missing public 3D delivery controller…" |
| Audit | `audit/architecture-baseline-and-full-audit.md` — FD-01…FD-22, B1…B19 |
| Visible symptom | Reference-image upload failed with `500 INTERNAL_ERROR` and a generic message |
| Additional findings | private media not durable, 3D root CWD-relative, no CI, four suites missing from the orchestrator, cross-tenant cleanup sweep, documentation drift |

## Verification of this tree

All commands run from `backend/` unless noted, against the shared MongoDB cluster's
**disposable** `Flora-Alchemy-Test-*` databases (never `Flora-Alchemy`, never
`flora_alchemy_dev`).

### Backend regression — one complete sweep

```
npm test        # scripts/run-all.mjs — 30 suites
  TOTAL PASS 2701  FAIL 0
  30 pass · 0 fail · 0 environmental/timeout · 0 capacity
FULL RUN: ALL SUITES PASSED
```

| Suite | Assertions | | Suite | Assertions |
|---|---|---|---|---|
| Environment Guard | 30 | | Tenant Matrix | 190 |
| Pricing | 22 | | Admin Onboarding | 141 |
| API | 125 | | Staff Permissions | 119 |
| Integration | 81 | | Action Center | 84 |
| Marketplace | 108 | | Legacy Backfill | 32 |
| Shop Services | 122 | | Reference Studio | 120 |
| Checkout | 111 | | 3D Studio | 188 |
| Custom Request | 78 | | 3D Worker Provider | 52 |
| Payment | 45 | | Media Storage | 75 |
| Conversation | 34 | | 3D Quality | 84 |
| Provisioning | 84 | | Security | 105 |
| Activation | 44 | | Production | 32 |
| Invitation Link | 82 | | Staff Lifecycle | 146 |
| Portal Auth | 58 | | Personnel Lifecycle | 110 |
| Application Flow | 82 | | Tenant Core | 117 |

Four of these (`Marketplace`, `Shop Services`, `Checkout`, `Custom Request`) were
standalone scripts before this release and are now part of the orchestrator, so
"all suites" means all of them.

### Frontend

```
cd frontend && npm run build     # ✓ built in 25.98s, exit 0
```

### Release boot gate

```
cd backend && npm run test:boot-gate    # boots the API from a CLEAN committed view
```

This is the gate that would have caught the missing-controller release: it imports
every backend module, checks that every router file is mounted, and boots against a
disposable database. It cannot be satisfied by an untracked file in a working tree.

### CI

`.github/workflows/ci.yml` — build, clean-checkout boot gate, and the full sweep
against a **disposable MongoDB single-node replica set**, plus browser E2E with an
honest Chrome preflight. No production secret is referenced anywhere in it.

**Run 1 (commit `9b09449`) failed at "Initialise the MongoDB replica set" — a
workflow defect, not a product one.** A GitHub Actions `services:` container cannot
be given a custom command, so the official `mongo:7` image started `mongod` without
`--replSet` and `rs.initiate()` answered *not running with --replSet*; every later
step was skipped, so no build or test result exists for that commit. The workflow
now starts the container itself (`docker run … mongod --replSet rs0 --bind_ip_all`),
waits for mongod to answer, initiates, waits for a writable primary, and then
**proves transaction capability by committing a transaction** before any suite runs
— a replica set that cannot transact fails loudly instead of turning order-creating
suites into environmental noise.

The next run on `main` is the evidence for this workflow; check it before trusting
the gate.

## Storage and migration status

| Item | State |
|---|---|
| Private media roots | Absolute and CWD-independent (`services/privateMediaRoot.js`) |
| Durability reporting | Boot log + `GET /api/health` → `media.{reference,threeD}` (`configured`, `insideAppTree`, `durable`, `writable`, `errorCode`) |
| Typed storage failures | `STORAGE_NOT_WRITABLE` / `STORAGE_FULL` / `STORAGE_MISSING` / `STORAGE_EXHAUSTED` / `STORAGE_UNAVAILABLE` → 503, with the code also in the message |
| Migration tool | `scripts/migrate-private-media.mjs` — dry-run default, SHA-256 verified, refuses to overwrite, manifest, re-run safe |
| **Persistent disk** | **NOT ATTACHED — owner action.** `render.yaml` documents the exact steps; the env vars are present but commented so no deploy can point a root at an unprovisioned path |

## Worker / provider status

Production generation is **unavailable by default, truthfully reported**: the bundled
TripoSR worker is loopback-only and not deployed; Meshy is only selected when both
`THREE_PROVIDER=meshy` and `MESHY_API_KEY` are set. There is no automatic fallback
from a missing worker to a paid provider. See
[IMAGE_STUDIO.md](./IMAGE_STUDIO.md#production-availability).

## Not verified, and what would verify it

| Item | Why it is not verified | Required evidence |
|---|---|---|
| Deployed revision | No deploy performed from this session | Render dashboard deploy history for `flora-alchemy-api` after the push |
| Live upload success | Needs an authorized production staff session | One real upload through `/admin` → Reference Studio, then the prepared-image read |
| Production media durability | The disk is not attached | `curl …/api/health | jq .media` after the disk is mounted and the two env vars set |
| Production probe | Needs the deployed host | `PROD_PROBE_BASE_URL=https://flora-alchemy.onrender.com npm run prod:probe` |
| CI run (passing) | Run 1 failed in the replica-set step (workflow defect, fixed in the follow-up commit); no build/test result exists for `9b09449` | The next GitHub Actions run on `main` reaching the "Backend regression" step green |

## Open items requiring the owner

1. **Attach a persistent disk** to `flora-alchemy-api` (mount `/var/data`), set
   `REFERENCE_MEDIA_DIR` and `THREE_MEDIA_ROOT`, redeploy, verify with `/api/health`.
   Steps: [DEPLOYMENT.md](../DEPLOYMENT.md#private-media-reference-images--3d-models).
2. **Migrate existing media** (if any files still exist on the ephemeral disk or in a
   backup) with `media:migrate`, dry run first.
3. **Run the production smoke** (deployed revision + one authorized test upload), then
   delete the test row.
4. **Decide** on a production 3D worker or a hosted provider (or leave generation
   disabled — it fails closed and spends nothing).

## What was deliberately NOT changed

- Quality-gate thresholds: three genuine models measuring REVIEW is a
  measurement-of-a-photograph limitation; tuning bands to samples would be the wrong fix.
- Order lifecycle, pricing authority, inventory hold/release semantics, JWT scope
  separation, rate-limit strategy, public-cache scope, design tokens.
- The E2E database (`Flora-Alchemy-Test-E2E`) is kept by the reclamation script.
