# Flora Alchemy — Testing

> Documents the test system that actually exists in `backend/scripts/`.
> Related: [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](./CONTRIBUTING.md),
> [API.md](./API.md), [ARCHITECTURE.md](./ARCHITECTURE.md),
> [MEMORY.md](./MEMORY.md).

There is **no test framework** (no Jest/Vitest/Mocha). Each suite is a standalone
Node ES-module script that boots a real backend process, drives it over HTTP with
`fetch`, asserts, and reports a `passed / failed` summary line that the orchestrator
parses.

---

## Verified current result

**Current (2026-10-19, after Phase 8 backup work): 2850 assertions, 0 failures
across all 31 suites,** exit **0**, one `npm test` sweep — with the orchestrator
reclaiming each suite's database as it goes, so the shared cluster's 500-collection
cap is never reached. The 31st suite is **Backup & Integrity** (`backup-smoke.mjs`,
117 assertions — export/manifest/checksum round trips, tamper + interruption
detection, AES-256-GCM, freshness, baseline drift, alert delivery/dedup, retention,
and a real restore drill with API sign-in), added by the Phase 8 backup work.
Per-suite numbers for the *Phase 10 release* sweep, the boot-gate result and what
is *not* verified are in
[RELEASE_STATUS.md](./RELEASE_STATUS.md). The tables below are kept as the record of
each phase's own sweep: they are historical, deliberately not restated, and a later
figure never gets added to an older table (that would present arithmetic as evidence).

Last full sweep before this one (3D Studio **Phase 4**, 2026-10-15) — **24 suites,
2114 assertions**, **0 failures**, exit status **0**, executed as ONE `npm test` sweep:

```
  TOTAL PASS 2114  FAIL 0
FULL RUN: ALL SUITES PASSED

```

> **Since Phase 5 there is a 25th suite** — `3D Quality` (84 assertions after Phase 6's
> four added checks). It was first *verified standalone* together with the suites the
> gate could plausibly disturb — and **Phase 6 then ran the complete 25-suite sweep**,
> reported in full under *3D Studio Phase 6* below. The Phase 4 table remains the Phase 4
> record and is deliberately not restated or added to.

The new suite in that run is **3D Worker Provider** (Phase 4's adapter contract,
52 assertions, loopback stand-in, no GPU). Two things the run itself surfaced, kept
here because both are the kind of failure that masquerades as a product defect:

> **The 500-collection cap bites first.** The first attempt at the final suites hit
> `cannot create a new collection -- already using 501 collections of 500` — an
> environmental refusal, not an assertion. `node scripts/db-footprint.mjs
> --drop-leftovers` freed 403 collections from finished-suite databases (it never
> touches `Flora-Alchemy` or `flora_alchemy_dev`) and the suites then ran clean.
>
> **A stale assertion was caught by the sweep, not by review.** `3D Studio`'s teardown
> asserted `listProviders().length === 2`, which Phase 4's third registry entry
> (`local_worker`) invalidated. The check now asserts the exact SET of provider names
> plus that the test double is gone — a count alone would go green again the moment
> another provider is added. Re-run alone after the fix: **188 / 0**.

### 3D Studio Phase 5 — the quality gate (2026-10-16)

Phase 5 adds **one** suite, `3D Quality` (`scripts/3d-quality-smoke.mjs`, **80** assertions),
and changes how no other suite runs. It was verified **standalone**, together with every suite
the gate could plausibly disturb, all on the same tree:

| Suite | Result | Elapsed |
|---|---|---|
| 3D Quality (Phase 5) — new | ✅ 80 / 0 | 20.9s |
| Multi-view references | ✅ 79 / 0 | — |
| 3D Studio (Phase 2–3) | ✅ 188 / 0 | — |
| 3D Worker Provider (Phase 4) | ✅ 52 / 0 | — |
| `npm run build` (from `frontend/`) | ✅ clean | — |

> **The cumulative table below is NOT restated.** It is the record of the Phase 4 sweep
> (24 suites / 2114 assertions), and the Phase 6 sweep is reported separately in its own
> section rather than merged into it. Adding a standalone count to that total would
> present arithmetic as evidence; each table above is what was actually executed. Reproduce
> the quality suite alone with `node scripts/run-all.mjs --only="3D Quality"` (≈ 24 s).

**The gate refused the existing Phase 2 fixtures, and that was the correct outcome.**
`3D Studio`'s approval assertions ran against a deliberately minimal 1-triangle GLB, which the
new structural gate blocks. Rather than weaken the gate or the assertion, the **fixture** was
upgraded — `scripts/lib/meshFixtures.mjs` now builds credible watertight meshes — and every
existing assertion kept its intent. The suite is back to **188 / 0**. A fixture that a quality
gate cannot object to is a fixture that cannot test one.

**What the new suite covers** — the 15 scenarios the phase specifies, across six sections,
using deterministic geometry and silhouette fixtures whose answer is knowable in advance
(no GPU, no credits, no network, its own `Flora-Alchemy-Test-*` database):

| Section | Covers |
|---|---|
| §A Measurement & decisions | PASS / REVIEW / BLOCKED arithmetic, silhouette metrics and view selection, vertex-colour findings, a missing or unreadable source cutout, an invalid GLB, an uncertain alignment |
| §B Approval is gated server-side | `QUALITY_BLOCKED`, `QUALITY_REVIEW_REQUIRED`, the review acknowledgement, the administrator-only override and its audit record, and a client-submitted `quality` field being ignored |
| §C Staleness | A report describes exact bytes and reference ids; changing either invalidates it and clears the review and override |
| §D Replacement | A BLOCKED or failed replacement never removes the live approved model |
| §E Public surface | Every unapproved candidate is a 404 through the storefront routes |
| §F Tenancy | Cross-workspace read / assess / approve is a 404, never a 403 |

**Evidence, not just fixtures.** `scripts/3d-quality-report.mjs` measures a **real** model and
writes down what it found, so a genuine result is reproducible by anyone holding the two files:

```bash
node scripts/3d-quality-report.mjs --glb=<model.glb> --cutout=<cutout.png>  # preferred: the exact mask the model was made from
node scripts/3d-quality-report.mjs --glb=<model.glb> --photo=<photo.jpg>    # otherwise Phase 1's engine cuts one out here
```

It needs no database, no worker and no GPU — only the files — and writes into the ignored
`audit/phase5-quality/` (a machine-readable `*.quality.json` plus a
`reference | model | overlay` diagnostic image). Its exit codes keep "could not measure"
distinct from "measured badly": **0** = assessed (read the decision from the report),
**1** = the assessment itself failed, **2** = an input was unavailable. It is never part of
`npm test`.

---

### 3D Studio Phase 6 — validation & hardening (2026-10-16)

**The first complete 25-suite sweep.** Phase 5 recorded 24 suites and verified its new
suite standalone, because no 25-suite sweep had been run. Phase 6 ran the whole thing
serially as ONE `npm test`, on the same tree as the changes below:

```
  TOTAL PASS 2198  FAIL 0
FULL RUN: ALL SUITES PASSED
```

| Suite | Assertions | Result | Elapsed |
|---|---|---|---|
| Environment Guard (Phase 4) | 30 | ✅ 30 / 0 | 0.2s |
| Pricing | 22 | ✅ 22 / 0 | 26.8s |
| API | 125 | ✅ 125 / 0 | 46.0s |
| Integration | 81 | ✅ 81 / 0 | 68.3s |
| Payment (mock Razorpay) | 45 | ✅ 45 / 0 | 27.1s |
| Conversation | 34 | ✅ 34 / 0 | 25.4s |
| Provisioning (Phase 20.6.1) | 84 | ✅ 84 / 0 | 58.6s |
| Activation (Phase 20.6.2) | 44 | ✅ 44 / 0 | 30.8s |
| Invitation Link | 82 | ✅ 82 / 0 | 28.2s |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | 146 | ✅ 146 / 0 | 54.7s |
| Portal Auth (Phase 21.1–21.2) | 58 | ✅ 58 / 0 | 47.8s |
| Personnel Lifecycle (Phase 21.4–21.7) | 110 | ✅ 110 / 0 | 43.8s |
| Application Flow (Phase 20.6.6) | 82 | ✅ 82 / 0 | 44.0s |
| Tenant Core (Phase 22.2) | 117 | ✅ 117 / 0 | 75.0s |
| Tenant Matrix (Phase 22.3) | 190 | ✅ 190 / 0 | 67.4s |
| Admin Onboarding (Phase 22.4–22.5) | 141 | ✅ 141 / 0 | 52.3s |
| Staff Permissions | 119 | ✅ 119 / 0 | 44.8s |
| Action Center | 84 | ✅ 84 / 0 | 46.7s |
| Legacy Backfill | 32 | ✅ 32 / 0 | 41.0s |
| Multi-view references | 79 | ✅ 79 / 0 | ~55s |
| 3D Studio (Phase 2–3) | 188 | ✅ 188 / 0 | 90.0s |
| 3D Worker Provider (Phase 4) | 52 | ✅ 52 / 0 | 42.0s |
| **3D Quality (Phase 5, now 84)** | 84 | ✅ 84 / 0 | 24.3s |
| Security | 105 | ✅ 105 / 0 | 39.1s |
| Production | 32 | ✅ 32 / 0 | 55.2s |

Counts and elapsed times are what each suite itself reported; nothing was recomputed,
and no suite was skipped, folded into another, or re-run to change a number. The
quality suite gained four assertions in Phase 6 (a regression check that re-assessing
an UNCHANGED model cannot re-insert a hydrated subdocument), which is why it reads
**84** rather than 80.

### Verified before the sweep, in isolation

| Command | Result |
|---|---|
| `npm run test:3d-quality` | ✅ 84 / 0 |
| `npm run test:references` | ✅ 79 / 0 |
| `npm run test:3d` | ✅ 188 / 0 |
| `npm run test:3d-worker` | ✅ 52 / 0 |
| `npm run build` (frontend production build) | ✅ clean (14.7s); `three.module` and `Product3dViewer` remain lazy chunks |
| `npm run test:e2e` (build + every browser spec) | ✅ **91 / 0** (11.6 min, exit 0) |

No two sweeps were run at once (fixed ports), and nothing was run against dev or
production data: every suite booted its own backend against its own
`Flora-Alchemy-Test-*` database, and the genuine generation runs used a disposable
database plus OS-temp media roots that were dropped at the end.

### The run before this one (Phase 3, same day)

The Phase 3 sweep — **23 suites, 2062 assertions**, 0 failures — was executed serially
in three `--only` subsets (a full 12-minute run exceeded a single foreground command
then), each with per-suite elapsed time and exit status, and the counts in that table
are what the suites themselves reported. Two suites
reported `ENVIRONMENTAL/TIMEOUT` on the first pass — `Portal Auth` and `Personnel
Lifecycle` hit the shared cluster's 500-collection cap (see *Cluster footprint*), were
reclaimed with `--drop-leftovers`, and **re-ran alone to a clean pass**; their counts in
the table come from that re-run, never from the timeout.
>
> One REAL regression was caught and fixed: the tenant-discipline gate
(`tenant-audit.mjs --strict`, asserted by Tenant Core) flags a document-handle delete
(`product.deleteOne()`) as an unscoped query site, because the 400-character lookahead
could no longer see a tenancy helper after the Phase 3 additions. `deleteProduct` now
deletes through an explicitly SCOPED `Product.deleteOne({ _id, ...workspaceIdScope(...) })`,
which is both what the audit can see and a stronger statement of intent.

| Suite | Assertions | Result | Elapsed |
|---|---|---|---|
| Environment Guard (Phase 4) | 30 | ✅ 30 / 0 | 0.1s |
| Pricing | 22 | ✅ 22 / 0 | 16.2s |
| API | 125 | ✅ 125 / 0 | 28.9s |
| Integration | 81 | ✅ 81 / 0 | 41.5s |
| Payment (mock Razorpay) | 45 | ✅ 45 / 0 | 13.9s |
| Conversation | 34 | ✅ 34 / 0 | 14.7s |
| Provisioning (Phase 20.6.1) | 84 | ✅ 84 / 0 | 46.5s |
| Activation (Phase 20.6.2) | 44 | ✅ 44 / 0 | 25.5s |
| Invitation Link | 82 | ✅ 82 / 0 | 17.2s |
| Staff Lifecycle (Phase 20.6.3–20.6.5) | 146 | ✅ 146 / 0 | 34.7s |
| Portal Auth (Phase 21.1–21.2) | 58 | ✅ 58 / 0 | 36.9s · ⚠️ first pass `ENVIRONMENTAL/TIMEOUT` (cluster cap), **re-run alone: 58 / 0** |
| Personnel Lifecycle (Phase 21.4–21.7) | 110 | ✅ 110 / 0 | 36.9s · ⚠️ first pass `ENVIRONMENTAL/TIMEOUT` (cluster cap), **re-run alone: 110 / 0** |
| Application Flow (Phase 20.6.6) | 82 | ✅ 82 / 0 | 30.3s |
| Tenant Core (Phase 22.2) | 117 | ✅ 117 / 0 | 47.9s · 💡 first pass FAILED (2 assertions) on the `--strict` tenant-audit regression — fixed, then green |
| Tenant Matrix (Phase 22.3) | 190 | ✅ 190 / 0 | 49.2s |
| Admin Onboarding (Phase 22.4–22.5) | 141 | ✅ 141 / 0 | 31.4s |
| Staff Permissions | 119 | ✅ 119 / 0 | 25.6s |
| Action Center | 84 | ✅ 84 / 0 | 29.5s |
| Legacy Backfill | 32 | ✅ 32 / 0 | 29.1s |
| Multi-view references | 79 | ✅ 79 / 0 | ~37s |
| 3D Studio (Phase 2–3) | 188 | ✅ 188 / 0 | 78.2s |
| 3D Worker Provider (Phase 4) | 52 | ✅ 52 / 0 | 37.5s |
| Security | 105 | ✅ 105 / 0 | 24.6s |
| Production | 32 | ✅ 32 / 0 | 52.3s |
| **TOTAL** | **2114** | **✅ 2114 PASS / 0 FAIL** (24 suites) | ~13 min |

Per-suite elapsed times above are the figures each suite last reported (the Phase 4
sweep re-ran every one of them); the 3D Worker row and the total are from that sweep.

```
FULL RUN: ALL SUITES PASSED
```

No suite is folded into that total on trust: the two that timed out were diagnosed
against the shared cluster's 500-collection cap, reclaimed with
`node scripts/db-footprint.mjs --drop-leftovers`, and **re-run alone to a clean pass**,
which is where their numbers come from.

> ⚠️ **Never start a second `run-all.mjs` while one is running, and never kill
> processes by a `server.js`-shaped pattern during a sweep.** Every suite binds a
> fixed port and `bootTestServer` refuses a port already in use, so a concurrent
> run (or a stray kill) makes suites die at boot and the orchestrator reports
> them as environmental. That looks exactly like a broken change and is not one.
> Check for a live orchestrator (`Get-CimInstance Win32_Process` for
> `scripts/run-all.mjs`) before starting another.

**One suite failed on the first pass and passed on its own re-run.** `Portal Auth`
hit the shared cluster's **500-collection cap** — its provisioning step could not
create a collection at all, so the failure was about the cluster being full, not
about the code. 285 collections belonging to finished suite databases were
reclaimed with `node scripts/db-footprint.mjs --drop-leftovers` (see "Cluster
footprint" below), after which the same suite passed 58/58. The orchestrator
reports that class distinctly so a cap failure is never read as an assertion
regression:

```
⚠ Portal Auth — ENVIRONMENTAL/TIMEOUT …
  Re-run it on its own and explain it before treating this run as a result
```

**One suite reported failures that were machine load, not code: `Production`.**
Its four "exits in production" checks sampled `child.exitCode` after a fixed
`await sleep(5000)`; a concurrent headless-Chrome responsive sweep kept the
machine busy enough that a freshly spawned server had not finished importing its
module graph inside those five seconds, so a correct server was reported as 8
failures (and 25/25 when the suite was re-run alone). The checks now poll for the
exit with a bounded `waitForExit(child)` — the assertion is unchanged (it did
exit, with this message), it just stops reading machine load as a product defect.

> ⚠️ **A cluster at the collection cap makes suites fail as though they were
> broken.** Run `node scripts/db-footprint.mjs` before a full sweep; it names every
> database that is reclaimable and never touches `Flora-Alchemy`,
> `flora_alchemy_dev`, or a database belonging to another project on the cluster.

> ⚠️ **A green suite does not mean the deployment is safe.** These suites run
> isolated from the real databases (each boots its own server against its own
> `Flora-Alchemy-Test-*` database). Development (`flora_alchemy_dev`) and
> production (`Flora-Alchemy`) are now distinct databases on the shared cluster
> (see [MEMORY.md](./MEMORY.md) and [DATABASE.md](./DATABASE.md)).
>
> There is **no frontend UNIT/component test runner** in this repo (no Jest/
> Vitest/RTL): storefront logic is covered by the Playwright **browser E2E suite**
> described below, which drives the real stack in a real browser, plus
> `npm run build` and the responsive harness (layout-only — synthetic input does
> not reach React handlers). No frontend unit test exists, so never claim one
> passed; and never report the browser suite as covering a flow it does not
> contain.

## Commands

From the repository root:

```bash
npm test          # cd backend && npm test → scripts/run-all.mjs (all 30 suites)
npm run test:e2e  # frontend/admin: E2E build + Playwright (see "Browser E2E suite")
```

From `backend/`:

```bash
npm test                    # all suites (same orchestrator)
npm run test:guard          # 30  — database-identity guard (no server, no DB, no writes)
npm run test:pricing        # 22  — custom gift pricing authority
npm run test:api            # 125 — core API smoke
npm run test:integration    # 81  — admin users, notifications, collections, uploads, custom requests
npm run test:payment        # 45  — payment lifecycle against a local mock Razorpay
npm run test:conversation   # 34  — order-linked messaging
npm run test:provisioning   # 84  — first-owner bootstrap + staff access matrix (Phase 20.6.1)
npm run test:portal         # 58  — portal context + owner gate (Phase 21.1–21.2)
npm run test:lifecycle      # 110 — OWNER → ADMIN → HANDLER personnel lifecycle (Phase 21.4–21.7)
npm run test:applications   # 82  — public application intake → owner review → invitation (Phase 20.6.6, +22.4 business fields)
npm run test:tenant         # 117 — tenant foundation (Phase 22.2)
npm run test:tenant-matrix  # 190 — two-workspace cross-tenant isolation (Phase 22.3)
npm run test:onboarding     # 141 — client admin onboarding + workspace activation (Phase 22.4)
npm run test:security       # 105 — security controls (incl. the CORS allowlist)
npm run test:references     # 79 — multi-view references: originals only (no segmentation), grid detection,
                            #       plus the scoped/dry-by-default cleanup sweep (cross-tenant regression)
npm run test:3d             # 206 — 3D Studio: provider policy (THREE_D_PROVIDER canonical + deprecated
                            #       3D_PROVIDER alias, precedence, unrecognized value), validation, storage,
                            #       approval, tenancy, HTTP, PUBLIC delivery (Phase 3)
npm run test:3d-worker      # 53  — 3D Studio Phase 4: the local_worker adapter contract (loopback stand-in, NO GPU, spends nothing)
npm run test:3d-real        # OPT-IN real generation: drives a LIVE tools/3d-worker/worker.py (TripoSR). Exit 2 if the worker is not running; never in `test:all`

npm run test:3d-quality    # 106 — 3D Studio Phase 5–7: the model quality gate (geometry, fragmentation, depth bands,
                           #       silhouette, colour; measure-decision-approval, staleness, tenancy)
npm run test:3d-agent      # 68  — remote GPU agent protocol: machine token auth (constant-time, HTTPS-in-production),
                            #       atomic provider-scoped claim, lease/heartbeat/abort, input scoping to the claimed
                            #       job, bounded + idempotent result uploads, cancel/failed/release, payload-leak checks
                            #       (fake agent against the real endpoints; no GPU, no credits)
npm run test:supabase-storage # 72 — the Supabase Storage object driver against a local
                            #       Storage-REST-emulating HTTP server (no cloud account):
                            #       endpoint derivation, key-format header rules (apikey-only for sb_secret_ keys), missing-config diagnostics (secret-free), key safety,
                            #       write/read/byte-fidelity, ORIGINAL+ASSET immutability, idempotent retry,
                            #       prefix removal, typed 503s, STORAGE_NOT_DURABLE production guard, fs fallback,
                            #       and the FAIL-CLOSED bucket-privacy guard (private allows; public/missing/
                            #       malformed/foreign/timeout block with no upload and no fallback; cache honesty)
npm run test:razorpay-real  # real Razorpay sandbox; SKIPS (exit 0) without rzp_test_* keys
npm run test:supabase-real  # OPT-IN live Supabase bucket round trip (write → byte-identical
                            #       read-back → stat/list/delete + cleanup). Needs real
                            #       backend/.env credentials; exit 2 without them; the
                            #       secret value is never printed, only its shape.
                            #       Last live run 2026-10-21: 8/8, exit 0 — round trip,
                            #       stat, list AND the bucket-visibility check (the owner
                            #       made the configured bucket private; a public bucket
                            #       still fails the run).

# Phase 10 additions — these four existed only as standalone scripts before:
npm run test:marketplace    # 108 — shop identity / marketplace surfaces
npm run test:shop-services  # 122 — shop serviceability + delivery promises
npm run test:checkout       # 111 — checkout ownership, totals, reservation/release
npm run test:custom-request # 78  — custom request workflow + proposals

# Phase 10 — release-safety gates (both in `npm test`'s neighbourhood, both CI-gated):
npm run test:media-storage  # 75  — private media: absolute/cwd-independent roots, traversal,
                            #       original immutability, typed write failures, missing bytes
                            #       (suites PIN the filesystem driver and blank the SUPABASE_*
                            #       variables for their own child servers, so a developer .env
                            #       with live credentials can never make a suite write into the
                            #       real bucket — see lib/testServer.mjs)
npm run test:boot-gate      # clean-checkout boot/route-registration/contract gate
                            # (no server left running, no DB writes, safe to run anytime)
node scripts/production-probe.mjs   # OPT-IN read-only probe of the DEPLOYED API
                            # (needs PROD_PROBE_BASE_URL; writes nothing, needs no staff session)
node scripts/migrate-private-media.mjs --kind=reference --from=<old> --to=<new>   # DRY RUN by default
                            # (--apply copies + verifies; --kind=three for the 3D root)

# No standalone script — runs inside `npm test` only:
node scripts/activation-smoke.mjs          # 44  — invitation activation (Phase 20.6.2, +22.4 workspace attach)
node scripts/staff-lifecycle-smoke.mjs     # 146 — staff invitation lifecycle (Phase 20.6.3–20.6.5)
node scripts/invitation-link-smoke.mjs     # 82  — invitation link handling
node scripts/staff-permissions-smoke.mjs   # 119 — granular staff permissions
node scripts/staff-action-center-smoke.mjs # 84  — staff action center
node scripts/legacy-backfill-smoke.mjs     # 32  — legacy ownership backfill
node scripts/reference-image-smoke.mjs     # 79 — multi-view reference images (grid, panels, review)
node scripts/3d-studio-smoke.mjs           # 188 — 3D Studio generation + approval + public storefront delivery (Phase 2–3)
node scripts/3d-worker-provider-smoke.mjs  # 52  — 3D Studio Phase 4: local_worker adapter contract (loopback stand-in, no GPU)

node scripts/3d-quality-smoke.mjs           # 84  — 3D Studio Phase 5: the model quality gate (deterministic fixtures; no GPU, no credits)
# Evidence tool (never a test — it measures a REAL model and reports what it scored):
#   node scripts/3d-quality-report.mjs --glb=<model.glb> --cutout=<cutout.png>   (or --photo=<jpg>)
#   exits 0 assessed · 1 assessment failed · 2 input unavailable; writes into the ignored audit/phase5-quality/
```

Maintenance utilities (never tests): `node scripts/backfill-inventory.mjs`, and
`node scripts/db-footprint.mjs` — the read-only cluster footprint report.

## Cluster footprint (`scripts/db-footprint.mjs`)

The shared MongoDB cluster enforces a **500-collection cap**, and every suite
leaves its own database behind (~19 collections each). When the cap is reached,
suites fail with `cannot create a new collection -- already using 500 collections
of 500`, which looks like a product regression and is not one.

```bash
node scripts/db-footprint.mjs                    # READ-ONLY report
node scripts/db-footprint.mjs --drop-leftovers   # reclaim finished-suite databases
```

The report lists every database with its collection count and marks the ones this
script will never touch (`Flora-Alchemy`, `flora_alchemy_dev`, anything in
`PRODUCTION_DB_NAMES`, and any database on the shared cluster that belongs to
another project). `--drop-leftovers` skips the E2E database by default because its
fixtures are expensive to recreate; pass `--keep=` to keep others.

## Isolation model — how suites avoid polluting data

This is the most important property of the suite, and it is what makes
`npm test` safe to run even while production shares the development database.

Every suite calls `bootTestServer()` from **`backend/scripts/lib/testServer.mjs`**,
which:

1. Loads `backend/.env` (`dotenv`, without overriding already-set variables) **before**
   computing URIs.
2. **Derives a dedicated test database** from the configured `MONGO_URI` by replacing
   the database pathname — `testMongoUri(baseUri, dbName)` → `Flora-Alchemy-Test-*`.
   If no base URI exists it **fails loudly** rather than silently falling back to the
   development database (a Phase 16 fix — suites previously wrote to dev data).
3. **Spawns its own `server.js` child process** on its own port with
   `NODE_ENV=development`, its own rate-limit store, and (where relevant) injected
   provider credentials.
4. Waits for `/api/health`, seeds what it needs, and kills the child afterwards.

Consequences:

- No dev server needs to be running; no dependency on ambient state.
- Suites cannot pollute each other — the Security suite may exhaust its own login
  limiter without affecting anything else.
- **The development/production database is never touched by `npm test`.**
- Ports and databases are fixed per suite so failures are reproducible.

| Suite | Backend port | Test database |
|---|---|---|
| Pricing | 4092 | `Flora-Alchemy-Test-Pricing` |
| Security | 4093 | `Flora-Alchemy-Test-Security` |
| Integration | 4094 (+ 4095 `UploadIK`, 4097 `UploadLocal`) | `Flora-Alchemy-Test-Integration`, `Flora-Alchemy-Test-UploadIK`, `Flora-Alchemy-Test-UploadLocal` |
| API | 4095 | `Flora-Alchemy-Test-Api` |
| Provisioning | 4091 | `Flora-Alchemy-Test-Provisioning` |
| Activation | 4090 | `Flora-Alchemy-Test-Activation` |
| Payment | 4097 (+ mock Razorpay 4098) | `Flora-Alchemy-Test-Payment` |
| Conversation | 4099 | `Flora-Alchemy-Test-Conversation` |
| Application Flow | 4100 | `Flora-Alchemy-Test-ApplicationFlow` |
| Staff Lifecycle / Portal Auth | 4101 (sequential) | `Flora-Alchemy-Test-Staff`, `Flora-Alchemy-Test-Portal` |
| Personnel Lifecycle | 4102 | `Flora-Alchemy-Test-Personnel` |
| Tenant Core | 4103 | `Flora-Alchemy-Test-TenantCore` |
| Tenant Matrix | 4104 | `Flora-Alchemy-Test-TenantMatrix` |
| **Admin Onboarding (22.4)** | **4105** | **`Flora-Alchemy-Test-AdminOnboarding`** |
| Production | free port from 4100 / 4110 / 4120…4200 | `Flora-Alchemy-Test-Production-Smoke-<port>` (one per spawned server) |
| Razorpay (real) | 4098 | `Flora-Alchemy-Test-Razorpay` |

*(Port 4096 is deliberately skipped — it is claimed by a local proxy controller on
some development machines.)*

## Orchestrator — `scripts/run-all.mjs`

Runs the suites in a **fixed, deterministic order** and exits non-zero if any suite
did not pass:

```
Environment Guard → Pricing → API → Integration → Payment → Conversation →
Provisioning → Activation → Invitation Link → Staff Lifecycle → Portal Auth →
Personnel Lifecycle → Application Flow → Tenant Core → Tenant Matrix →
Admin Onboarding → Staff Permissions → Action Center → Legacy Backfill →
Security → Production
```

Ordering rationale (from the source): fast functional suites first, **Security last**
because it deliberately exhausts its own server's login rate limiter.

### Suite states (Phase 4)

Every suite is reported as exactly one of five states, and the difference matters —
a run that lost suites to the per-suite cap used to be indistinguishable from one
that failed assertions:

| State | Meaning |
|---|---|
| `PASS` | Exited 0 |
| `FAIL` | Exited non-zero **with** its own summary line (a real assertion failure) |
| `ENVIRONMENTAL/TIMEOUT` | Killed by the per-suite cap, or died before printing a summary (boot failure, port clash, crash) |
| `CAPACITY` | MongoDB refused to create collections — the cluster's 500-collection cap was reached. Not a test failure: free space (`db-footprint.mjs --drop-leftovers`) and re-run. Since Phase 10 the orchestrator reclaims each suite's database as it goes, so a normal full run never reaches the cap |
| `NOT RUN` | Only in `--only` mode, for the suites you excluded |

Elapsed time is printed per suite. A timeout is **never** folded into `FAIL`, and it
is never silently absorbed: the orchestrator prints the exact re-run command for that
suite. Do not raise the cap to make a run look green — re-run the suite alone and
explain it first.

```bash
node scripts/run-all.mjs                       # every suite (5-minute cap)
node scripts/run-all.mjs --timeout=600         # longer cap only when justified
node scripts/run-all.mjs --only="API,Payment"  # serial re-run of a subset
```

## Browser E2E suite (Phase 4) — `frontend/e2e`

Playwright drives the **real** stack: an isolated backend (the same
`bootTestServer` helper every smoke suite uses) plus `vite preview` serving the
production bundle from `frontend/dist`.

```bash
cd frontend
npm run build:e2e    # build ONLY, against the loopback API (no suite)
npm run test:e2e     # build + run every spec
npx playwright test e2e/specs/03-tools.spec.js   # one spec (bundle already built)
```

- **Database:** `Flora-Alchemy-Test-E2E`, derived from `MONGO_URI` by
  `testMongoUri`, which fails closed unless the derived name carries a disposable
  marker **and** differs from the configured database. The stack additionally refuses
  to run at all if either check fails (see "Database safety" below).
- **Backend port:** 4000, **frontend:** 4300. Both children are killed by
  `e2e/stack.mjs` on exit.
- **Providers are blanked:** no Razorpay credentials, so no charge can be made (the
  checkout journey exercises the honest `PAYMENT_NOT_CONFIGURED` path); no ImageKit
  credentials, so uploads land on the local fallback and are verifiable on disk.
- **One worker, no retries.** The suite shares one backend and checkout really
  decrements stock, so parallel workers would race inventory; and a launch gate must
  not hide a flake behind a retry.
- **Browser:** the locally installed Google Chrome (`channel: 'chrome'`).

Specs: `01-discovery`, `02-product`, `03-tools` (gift finder, custom requests),
`04-account`, `05-cart-checkout`, `06-security`, `07-routes-a11y` (cold-load route
matrix, headings, focus rings, reduced motion, dark mode), `08-reviews-admin`,
`09-resilience` (slow / failed / empty catalogue, deterministic via route
interception), `11-image-studio`, `12-product-3d` (the customer 3D journey — see below),
`13-quality-review` (the Phase 5 quality review panel driven in a real browser — see below),
`14-cinematic-home` (FLOW 40–42 plus 40b/40c: the photographic homepage's nine scenes, real
imagery with no failed requests, kinetic-type hooks present, no renderer in the HomePage
chunk or the entry bundle, reduced motion rendering the finished page, the desktop
GooeyNav serving real routes with route-driven active state, and the hero crosshair
mounting only for desktop fine-pointer motion-OK visitors — the old 3D
workshop was removed from the customer path and its spec retired with it), `15-cinematic-stage`
(FLOW 43–51: the homepage's one dedicated WebGL stage — a scroll-driven camera through
six of the repository's own photographs hung as depth-separated planes. Proves the
camera position / look-target / FOV, the planes' projected viewpoint, perspective
parallax and raycast occlusion all change with scroll; that scrolling back restores the
pose; that resize / route-change / unmount leave no duplicate renderer; that
reduced-motion and non-WebGL visitors get a finished still composition and a working
storefront; that no request ever references the deleted model GLB; that captions
never overlap while kinetic-type hooks are present; that every beat is dominated by
one large photograph (frustum-clipped coverage); and that the final caption and exit
veil resolve before the craft section arrives — see
[CINEMATIC_STAGE.md](./CINEMATIC_STAGE.md)).

### The customer 3D journey — `12-product-3d.spec.js` (`npm run test:e2e`)

Six browser tests against the real stack, with the approved model provided by
`e2e/stack.mjs` as a **fixture** (an `APPROVED` asset row plus a real glTF Binary
container built byte-by-byte in `e2e/support/fixtures.js`; the fixture runs no AI
inference and says so in its own log line). Phase 4 added a second, explicit mode:

```bash
THREE_E2E_REAL_GLB=/abs/path/to/generated.glb \
  npx playwright test specs/12-product-3d.spec.js     # from frontend/
```

With that variable the stack publishes bytes a **real TripoSR worker generated**
(see [IMAGE_STUDIO.md — Phase 4](./IMAGE_STUDIO.md#phase-4--real-local-generation),
written by `backend/scripts/3d-real-generation.mjs`), the asset row records
`provider: local_worker`, FLOW 25 asserts the customer downloaded **byte-count-identical**
bytes, and the log line states which mode ran (`rendered the REAL GENERATED model…`
vs `rendered the deterministic fixture`) so neither result can be mistaken for the
other. Both modes were verified 6/6 on 2026-10-15.

| FLOW | What it proves |
|---|---|
| 25 | Photographs are the default; **no GLB request happens before the 3D tab is clicked**; the lazy chunk loads; the visitor's bytes come from the public path; `data-state="ready"` proves three.js **parsed and drew** them; the canvas is really sized; *Back to photos* restores the gallery; Add to Bag still adds exactly one item; no uncaught page errors and no React render errors. |
| 26 | A product with **no** approved model shows **no 3D control at all** (not a disabled one) and its gallery, price and bag behave exactly as before. |
| 27 | **three.js is not in the entry bundle**: every script `dist/index.html` loads on first paint is asserted free of `WebGLRenderer`/`GLTFLoader`/`OrbitControls`, and the `three.module` + `Product3dViewer` chunks must exist so the check cannot pass vacuously. |
| 28 | A model that has become unavailable (the public route answers 404, injected deterministically) lands in the viewer's error state with a visible *Back to photos* escape — then the photographs work. |
| 29 | A browser whose WebGL context **cannot be created** behaves the same way, with no uncaught page error. |
| 30 | At 390×844 the 3D view introduces **no horizontal overflow**, the exit control is reachable, the page still scrolls with a gesture started outside the viewport, and Add to Bag stays usable. |

### The quality review panel — `13-quality-review.spec.js` (`npm run test:e2e`)

Six browser tests (**FLOW 31–36**) that drive the Phase 5 review panel in a real
browser — the panel Phase 5 had only ever checked with a throwaway probe. The
stack provisions a **CANDIDATE for every state the panel renders**
(`QUALITY_FIXTURES`, declared in `e2e/support/fixtures.js` and shared with
`e2e/stack.mjs` so the two cannot drift), each created through the shipped
services (`createCandidateFromGeneration` → `assessAssetQuality`), so the report
the browser reads is the one the server really produced. The stack **asserts each
fixture's intended verdict at boot**: a fixture that drifts fails at startup
instead of quietly making a test vacuous.

| FLOW | What it proves |
|---|---|
| 31 | **PASS** — decision, named metrics and reference provenance (engine + confidence); no acknowledgement or override field; Approve enabled |
| 32 | **REVIEW** — server reason codes, warnings and material state; Approve disabled until a ≥5-character note; and the **server** refuses the identical call with `QUALITY_REVIEW_REQUIRED`, so the UI gate is a courtesy rather than the rule |
| 33 | **BLOCKED** — Approve blocked; a whitespace-only override reason refused; a forged `{ quality: 'PASS', iou: 0.99 }` in the request body changes nothing |
| 34 | a **failed** assessment (stored bytes genuinely gone) renders as REVIEW with `ASSESSMENT_FAILED`; a **stale** verdict is labelled out of date; clicking Approve **re-measures** and publishes with a different fingerprint |
| 35 | **rejecting a replacement** leaves the approved model identical and public, and settles the job |
| 36 | the studio payload carries **no storage path, workspace id or credential** — asserted against a canary provider key the stack configured before boot |

**What is fixture and what is real.** The geometry and cutouts are deterministic
(`scripts/lib/meshFixtures.mjs`) and every fixture row says so in its label.
**Not one is an AI-generated model.** What is real: the reference row, the
candidate row, its private bytes, the job row, the report, the admin session and
every API call. Evaluating genuine models belongs to `npm run test:3d-real` and
to the evaluation set recorded in
[IMAGE_STUDIO.md — Phase 6](./IMAGE_STUDIO.md#phase-6--browser-coverage-genuine-model-evaluation-hardening).

```bash
npx playwright test specs/13-quality-review.spec.js   # from frontend/, after `npm run build:e2e`
```

**Verified 2026-10-16:** 6/6, inside the full 91-test run (11.6 min, exit 0). The suite
is one worker with no retries, so a green run is a real one.

Writing it exposed two shipped defects, both now guarded: the stack and the
backend could disagree about where reference media lives (the stack wrote fixture
cutouts into a root the backend never read, which only surfaced when the *backend*
re-measured a stale candidate and found no bytes), and a failed UI decision
produced an unexplained timeout rather than the server's answer. Both are written
up in IMAGE_STUDIO.md — Phase 6.

### Bounded hydration — what the resilience spec proves

`fetch` has no default timeout, so a **stalled** catalogue request used to pin a
route to its skeleton forever: no error, no retry, no way forward. That was a
measured production symptom (the public catalogue spiked to 11–30 s under modest
concurrency), not a hypothetical, so the critical slices are now bounded in
`DataContext.jsx` (`HYDRATION_SLICE_TIMEOUT_MS`, 25 s) and `09-resilience.spec.js`
reproduces the conditions deterministically with route interception:

| Condition | Required behaviour | Test |
|---|---|---|
| Request fails | honest error naming the failure + working **Retry**; no articles invented | `§4 — a FAILED catalogue request…` |
| Request never answers | the app gives up by itself and offers the same recoverable state (a held response, so only the bound can end it) | `§4 — …NEVER ANSWERS is bounded, not eternal` |
| Response is genuinely empty | reads as empty — **not** as an outage and **not** as a fabricated catalogue, and offers no Retry | `§4 — a genuinely EMPTY catalogue…` |
| A late response from an abandoned request lands after a successful retry | it is **dropped**: `dataStore` keeps a per-slice write epoch and only the last-**started** request may commit, so a 35 s-old payload cannot replace the rows the retry confirmed | `§4 — a LATE response…cannot overwrite fresh data` |

`clearSessionData()` invalidates every in-flight slice write too, so a slow
`/orders` response belonging to the account that just signed out cannot repopulate
the store for a signed-out visitor.

### Database safety (E2E and every suite)

The database identity is the safety boundary, and it is checked in three places:

1. `testMongoUri` refuses a name without a `test`/`qa`/`dev`/`smoke`/`sandbox`
   marker, refuses a missing name, and refuses a derivation that resolves back to the
   configured database.
2. `e2e/stack.mjs` asserts the same two properties **before** it spawns anything, so
   the refusal comes first and is loud.
3. `environmentGuard.assertSafeDatabase` refuses a database listed in
   `PRODUCTION_DB_NAMES` regardless of `NODE_ENV`, and a generic
   `CONFIRM_DATABASE_UNSAFE_OPERATION` (`true`/`1`/`yes`) never authorises anything —
   only the exact database name does, for a deliberate one-off.

`npm run test:guard` (30 assertions, no server and no writes) proves those refusals,
including the production-target case. The E2E build has a fourth gate: the built
bundle's API origin must be loopback, verified against the emitted artifact, so
`npm run build && npx playwright test` can never point the suite at the deployed API.

### Known limitations of the E2E suite

- It talks to the **real Atlas cluster** (the disposable test database), so a
  machine with slow egress makes the whole suite slow. Assertions wait for content
  rather than asserting on the first frame — a route that is merely hydrating is not
  reported as broken.
- Public catalogue reads are cached server-side with a short TTL; the review
  journeys poll the public list instead of assuming instant invalidation.
- Uploads are verified against the **local fallback** storage path. Live ImageKit
  upload is an external check, not part of this suite.
- No automated *frontend unit* test runner exists: storefront logic is covered by
  this browser suite plus `npm run build` and the layout-only responsive harness.

## What each suite verifies

### Pricing — 22 assertions (`custom-gift-pricing-test.mjs`)
Custom Gift Studio **price authority**: a valid configuration is priced from server
constants (base + flower uplifts), a tampered client price is ignored, invalid
base/flower/missing-config inputs are rejected with `422`, and the packaging add-on
resolves from its `addOnId`.

### API — 125 assertions (`api-smoke.mjs`)
The core contract: register, login, `me`, product CRUD **including price integrity**,
order creation with ownership and lifecycle rules, inventory deduction and
adjustment, analytics derivation, settings persistence, and authorization negatives.

### Integration — 81 assertions (`integration-smoke.mjs`)
Cross-feature wiring: admin operator management, notifications, collection CRUD,
upload authorization **plus a real multipart upload** (both the ImageKit path and the
local-storage path, on separate servers), product edit/delete consistency
(including inventory record cleanup), and custom requests.

### Payment — 45 assertions (`payment-smoke.mjs`)
The payment matrix against a **local mock Razorpay server** and the real controllers:
verified payment → paid; failure → failed (never paid); cancelled/retry → same order
and same provider order with no duplicate; invalid signature → rejected; amount
tampering → server amount (from `order.total`) wins; customer A vs B → denied with
no leak; repeated verification → idempotent; repeated webhook → idempotent; a paid
order → **exactly one** inventory movement; a failed payment → no unintended deduction.

### Conversation — 34 assertions (`conversation-smoke.mjs`)
Full messaging lifecycle: customer creates the conversation → staff sees and replies
→ customer sees the reply → cross-customer access denied → unauthenticated access
denied → mark-read changes unread state → status open/close → duplicate-conversation
prevention → empty-body rejection → unread count.

### Provisioning — 84 assertions (`provisioning-smoke.mjs`)
Phase 20.6.1 — first-owner bootstrap (`provision-admin` guarded script) and the
staff access matrix (admin/handler/customer/anonymous across staff endpoints).

### Activation — 44 assertions (`activation-smoke.mjs`)
Phase 20.6.2/22.4 — invitation activation semantics: single-use token, TTL,
revoke/resend, no role escalation, `EMAIL_TAKEN` rollback, and (22.4) an
administrator activation **attaching its newly provisioned workspace** while a
handler activation only inherits one.

### Staff Lifecycle — 146 assertions (`staff-lifecycle-smoke.mjs`)
Phase 20.6.3–20.6.5 — invitation minting/resend/revoke, staff dossier actions,
StaffEvent audit trail, last-admin guards.

### Portal Auth — 58 assertions (`portal-auth-smoke.mjs`)
Phase 21.1–21.2 — portal context (`owner`/`admin`/`staff`), server-derived
`redirectTo`, owner gate, portal-forbidden matrix.

### Personnel Lifecycle — 110 assertions (`personnel-lifecycle-smoke.mjs`)
Phase 21.4–21.7 — OWNER → ADMIN → HANDLER hierarchy: creation, suspension,
reactivation, permission matrix, self-action and last-admin guards.

### Tenant Core — 117 assertions (`tenant-core-smoke.mjs`)
Phase 22.2 — Workspace entity, sparse membership, tenancy helpers, the four
gates, body/query scrub, compat mode, migration script + audit tool. (§32 was
**reversed by Phase 22.4**: admin activation now provisions its own workspace —
`workspaceId` set, ≠ the invitation's, `primaryAdminId` bound — while the
invitation's `workspaceId` stays untouched.)

### Tenant Matrix — 190 assertions (`tenant-matrix-smoke.mjs`)
Phase 22.3 — two real workspaces A/B: gate behaviour, disjoint operational
lists, cross-tenant read/write → 404, customer relationship visibility,
per-workspace settings/analytics, race proofs, suspension mid-request.

### Admin Onboarding — 141 assertions (`admin-onboarding-smoke.mjs`)
Phase 22.4 — client admin onboarding + workspace activation, E2E against an
isolated DB: business name/slug on submission (`SLUG_TAKEN`), owner approval
stamping `workspaceName`/`workspaceSlug`, **two independent workspaces** each
provisioned atomically (Workspace + admin User + Settings) from their own
approved application, slug precedence chain, transaction rollback on conflict
(no partial workspace/account/settings), invitation single-use, handler
activation never provisions, public `GET /api/shops/:slug` 200/404, owner
administrators directory enrichment + application linkage.

### Application Flow — 82 assertions (`application-flow-smoke.mjs`)

Phase 20.6.6 — the owner ←→ public admin application lifecycle, against an
EMPTY isolated database:

- **§23 public intake**: an anonymous submit creates ONLY an `AdminApplication`
  (no User, no Invitation, no JWT); client-supplied `role`/`isOwner`/`status`/
  `userId`/`password` are never honoured; 422 field validation; open duplicate
  → 409 `DUPLICATE_APPLICATION` while a rejected email may re-apply; owners
  notified; StaffEvent recorded; every owner endpoint refuses anonymous callers.
- **§24 owner authz matrix**: customer / handler / plain-admin sessions get
  403 `FORBIDDEN` on list, dossier, approve and reject with zero side effects.
- **§25 lifecycle**: approve mints exactly ONE invitation (role fixed to
  `admin`, only the SHA-256 hash stored — the raw token exists once in the
  approve response), one-way review decisions (409s in both directions),
  lazy `APPROVED → INVITED` on landing lookup, activation → `ACTIVATED` +
  sign-in (the new admin still cannot review), `EMAIL_TAKEN` rolls the claim
  back, dead invitations lazily reconcile to `EXPIRED`.
- **§26 approve race**: two concurrent approvals → exactly one 200 + one 409
  and exactly ONE invitation.

Isolation: own server (port 4100) and `Flora-Alchemy-Test-ApplicationFlow`.

### 3D Studio — 188 assertions (`3d-studio-smoke.mjs`)

The Phase 2 pipeline: an accepted reference set → a generated, validated GLB → a human
approval, plus (Phase 3) the public storefront surface an approved model is served
through (see [IMAGE_STUDIO.md](./IMAGE_STUDIO.md#phase-3--the-customer-facing-3d-experience)).
Port 4127, database `Flora-Alchemy-Test-3DStudio`, dropped on exit; both private media
roots are per-run temp directories the suite removes.

> ⚠️ **This suite performs NO AI inference and does not claim to have.** The provider
> *implementation* is an explicit test double (`registerTestProvider`), registered under
> the `meshy` name so the real opt-in path is exercised, with the transport replaced so no
> network call is possible. **Every other stage is real**: real accepted reference rows and
> files on disk, a real job row, a real atomic claim, the real worker/poll loop, the real
> GLB container validation, the real private write, a real candidate asset, the real
> approval/deprecation rules, the real tenancy scoping and the real HTTP routes and gates.
> The double returns a genuine glTF Binary container the suite builds byte by byte
> (correct magic/version/lengths, a JSON chunk with meshes, a BIN chunk with three real
> vertices), so what is validated and stored is a real GLB. A `POST` to
> `api.meshy.ai` from this suite would be a **suite defect** — it happened on the first
> run because the suite's opt-in env vars leaked into the child server, and the suite now
> restores them, forces them empty in the child, and asserts that it did.

It asserts:

- **§A provider policy** — generation is off by default; the local slot refuses to
  submit; a `MESHY_API_KEY` alone does not switch providers (opt-in needs the flag too);
  `THREE_D_PROVIDER=meshy` without a key describes meshy as unavailable rather than falling
  back; the refusal happens BEFORE a job row is written; no description, status payload
  or HTTP body contains the key; the shipped registry holds exactly the two real
  providers; and `registerTestProvider` is referenced from no controller, route or service;
- **§B validation** — a real GLB passes, and each rejection reason is exercised on a
  real mutation (empty, sub-header, PNG magic, version 1, declared-length mismatch,
  non-JSON first chunk, unparseable JSON, zero meshes, oversize), plus never throwing on
  hostile input;
- **§C private storage** — keys are relative to the root and never contain it, the bytes
  on disk match, a second write to a slot is refused as `ASSET_IMMUTABLE`, traversal and
  absolute keys are refused on both write and read, and removal is scoped to one asset;
- **§D a real run** — the job is claimed and running on return and records *which engine
  was asked* before any result exists; it reaches `READY_FOR_REVIEW`; exactly one candidate
  exists with `hasModel`, the validation facts, the provider identity, a real byte count
  and hash; the stored bytes are byte-identical to what the provider returned; the
  projection exposes no storage key and no tenant id; the provider received real cutout
  bytes; approval makes it live and settles the job;
- **§E a failed replacement** — a non-model download fails the job with a code-bearing
  reason, leaves no candidate behind, and the approved model and its bytes are untouched;
- **§F a rejected replacement** — the candidate is rejected with its reason kept, the
  product still reports an approved model, and the approved row is unchanged;
- **§G approval and archive guards** — a rejected asset, an approved asset and a
  candidate with no validated bytes are each refused; approving a genuine replacement
  deprecates the incumbent, records what replaced it, and keeps its GLB on disk;
- **§H tenancy** — every cross-workspace read, list, stream and plan answers 404 (never
  403); a foreign product slug, a foreign reference id, an unaccepted reference, a
  mismatched product and a malformed id are each refused with the documented code;
- **§I the HTTP surface** against a **separate server running the shipped default
  configuration** — 401 unauthenticated, 403 for a customer and for a permission-less
  handler, the workspace gate for a workspace-less identity, `422 PROVIDER_UNAVAILABLE`
  for an HTTP generation (a default deployment cannot be made to spend money), real
  private/no-store/nosniff GLB bytes to the owner, 404 for a foreign workspace and for a
  rejected model, and a sentinel credential present in that server's environment searched
  for in every response body;
- **§J public delivery (Phase 3)** — the storefront surface, against a **separate server
  process**: the projection's exact key set (so a new field cannot be added silently),
  anonymous/customer/staff reads, a handler without `products.view` refused exactly as
  the catalogue read refuses them, 200-with-`null` for a product with no model, 404 for
  unknown/unpublished products, the byte-level GLB response (type, `nosniff`, a BOUNDED
  cache lifetime), a thumbnail that is a clean 404 when absent and a real PNG when
  present, 404 for candidate / rejected / deprecated / unknown / malformed / foreign-
  product assets, an **intruder row that IS servable in its own workspace but can never
  be projected or downloaded under this product**, a full replacement through the real
  pipeline (unapproved candidate invisible → approval invalidates the running server's
  cache → the new model downloads → the replaced one 404s → the storefront converges
  within the bounded public-read window), and unpublish/republish through the real
  `PATCH` write path.

### Multi-view references — 79 assertions (`reference-image-smoke.mjs`)

The Phase 1 image pipeline end to end (see [IMAGE_STUDIO.md](./IMAGE_STUDIO.md)).
Port 4126, database `Flora-Alchemy-Test-ReferenceImages`, dropped on exit; the
private media root is a per-run temp directory that the suite removes.

It generates its own inputs with `sharp` (a product on a plain backdrop, two views
of the same product, a promotional flyer with headline text, a busy coloured
backdrop, a genuinely transparent PNG, plus corrupt/oversized/unsupported bytes),
then asserts:

- **real processing** — the cutout has a true alpha channel, the background really
  was removed (transparent pixels present), the product is preserved, the neutral
  preview carries the configured neutral colour, and the ORIGINAL is byte-identical
  to what was uploaded after processing (never overwritten);
- **the review step** — crop correction re-runs processing on the original, retry
  after a failure, delete, reorder, primary promotion (and promotion on removal),
  accept;
- **the product handoff** — a create carries the accepted set, unaccepted drafts and
  their files are cleaned up, a rename migrates the set, a delete removes rows and
  files, and a bogus id does not break a product save;
- **tenancy and auth** — cross-workspace reads/writes/deletes/bytes answer 404 (never
  403), the same for a customer, an anonymous caller, a permission-less handler (403
  BEFORE the body is parsed, so no bytes are written) and a suspended workspace, and
  no payload exposes a storage path or an internal id;
- **the engine licence guard** (§J, in-process) — `bria-rmbg` (rembg's default, whose
  weights are non-commercial) is refused even when configured explicitly, unknown
  models are refused with the known list, requesting `rembg` without an install
  answers `503 BGREMOVE_UNAVAILABLE` rather than substituting silently, and the
  provider drives rembg's LIBRARY API rather than its CLI (whose `i` subcommand
  dropped `--output`).

The suite pins `BGREMOVE_PROVIDER=deterministic` and `BGREMOVE_PROBE=0`, so which
engine ran and “rembg is not installed” are statements about configuration rather
than about the machine — installing rembg per IMAGE_STUDIO.md does not turn it red.
What it cannot prove is a real `rembg` inference (needs Python ≥ 3.11, < 3.14 and a
~176 MB weight download); that gap is documented, not papered over.

### Security — 105 assertions (`security-smoke.mjs`)
Every assertion proves a control is enforced **server-side**: authentication and
role enforcement, ownership/404 (no existence disclosure), suspension taking effect
immediately, brute-force login limiting, rejections for tampered pricing, payment
signature enforcement, CORS behaviour, and rate-limit responses.

Its CORS block (27 assertions) is the allowlist contract itself: an allowed origin
is served (200 + `Access-Control-Allow-Origin`, and 204 on preflight), a
disallowed origin is refused with **403 `ORIGIN_NOT_ALLOWED`** and *no*
`Access-Control-Allow-Origin` on preflight, GET, POST and `/health` alike — never a
500, never reflecting the supplied origin, and never reaching a controller (a
refused register creates no account). A request with no `Origin` header and a
`null` origin are covered explicitly, as is allowlist parsing: trailing-slash and
upper-case entries are canonicalized and still match, a sibling port is not, and
`*` / `https://*.example.com` are dropped rather than honoured.

### Production — 32 assertions (`production-smoke.mjs`)
Deployment hardening, verifying the production **boot contract** rather than
business logic:

1. `/api/health` returns 200 with service info
2. `/api/readiness` returns 200 when MongoDB is connected
3. `SEED_ON_START=true` **exits** and exits **non-zero**, naming `SEED_ON_START`
4. Missing `MONGO_URI` exits, exits non-zero, and names `MONGO_URI`
5. Missing `JWT_SECRET` exits, exits non-zero, and names `JWT_SECRET`
6. Missing `CORS_ORIGIN` exits, exits non-zero, and names `CORS_ORIGIN`
7. A `CORS_ORIGIN` that contains **no usable origin** (`*, not-a-url`) also
   refuses to boot — the failure state that would otherwise start a server which
   rejects every browser request
8. Graceful shutdown on `SIGTERM`
9. Graceful shutdown on `SIGINT`
10. Shutdown idempotency (a second signal does not crash)
11. Production startup with valid config (health + readiness)
12. **Negative control:** a process that does NOT exit is NOT reported as exited,
    so the four rejection checks above cannot pass vacuously

It boots servers on dynamically discovered free ports with throwaway
`Flora-Alchemy-Test-Production-Smoke-<port>` databases. Each rejection check
polls with a bounded `waitForExit(child)` (30s) instead of sampling `exitCode`
after a fixed `sleep(5000)`: a wall-clock assumption about how fast a fresh Node
process imports its module graph turned machine load into 8 phantom failures.
Termination is reported for BOTH an exit status and a signal, and the non-zero
exit-status assertion is what keeps that from mistaking a crash for an honest
refusal.

### Invitation Link — 82 assertions (`invitation-link-smoke.mjs`)
The activation-link origin contract: the resolution matrix
(`STAFF_PORTAL_URL` → `CLIENT_URL` → localhost, development only, a missing or
loopback origin in production refused rather than silently becoming localhost),
the shared `activationLink()` builder under an injected production env, a live
issue/resend over HTTP, and a static guard so no other runtime file may build an
activation URL or read an origin variable.

### Staff Permissions — 119 assertions (`staff-permissions-smoke.mjs`)
Granular staff roles: invitation-only onboarding (direct password creation gone),
workspace inheritance from inviter → invitation → activated user, the invitation
lifecycle, and per-request enforcement from the DATABASE (a grant works and a
removal bites on the next call, no re-login), plus workspace/admin boundaries and
catalogue integrity (platform authority is absent and unassignable).

### Action Center — 84 assertions (`staff-action-center-smoke.mjs`)
Phase 23 — the per-OPERATION layer behind the handler workbench, driven with the
handler's own token so "the button is on screen" cannot be mistaken for "the server
allows it": permitted operational actions, administrator/owner-only surfaces
refused with 403, workspace isolation, and the Phase 23 operation policy.

### Legacy Backfill — 32 assertions (`legacy-backfill-smoke.mjs`)
Phase 22.5 — the safety contract of `scripts/backfill-legacy-ownership.mjs`,
driven by `spawnSync` against a disposable database: dry-run writes nothing,
a production-named database fails closed before connecting, attribution comes only
from provable evidence (`Product.workspaceId` / `CustomRequest.workspaceId`; ghost
and cross-workspace orders left untouched), and a shop snapshot is written only
where the historical identity is provable.

### Backup & Integrity — 117 assertions (`backup-smoke.mjs`)
Phase 8 — the backup/monitoring contract of `scripts/backup.mjs`, run entirely
against a disposable `Flora-Alchemy-Test-Backup*` pair and temporary directories:
a good export verifies (manifest, SHA-256, completion marker, Extended-JSON
fidelity); a tampered payload, a missing payload and an interrupted export all
fail verification; AES-256-GCM round-trips and refuses wrong/short/absent keys;
freshness grades 2h/40h/50h/undated recovery points; integrity flags a missing
owner, empty catalogue, missing indexes, baseline-critical drift and an absent
baseline (warning, never pass) while growth never alerts; a REAL restore drill
restores counts + indexes, boots the API, proves sign-in accepts the right
password and refuses the wrong one, and disposes of its database; production,
protected, foreign and same-as-source drill targets are refused; the webhook
alert fires, deduplicates inside the cooldown, and reports delivery failure as
exit 3; retention dry-runs before applying and never touches pre-restore or
foreign artifacts; upload refuses unencrypted payloads.

### Razorpay (real) — `razorpay-real-smoke.mjs`
Talks to the **actual** Razorpay sandbox (never a mock). Requires genuine
`rzp_test_*` credentials via environment or `backend/.env`; **skips with exit 0 when
absent** and **refuses (exit 1) on live keys**. It deliberately strips ImageKit
credentials (for deterministic uploads) while keeping Razorpay credentials real.
Verified end-to-end: Flora order → real Razorpay order with the
server-authoritative paise amount, and retry reusing the same provider order id.

## Build & frontend verification

There is **no frontend test suite and no typechecker**. The compile check is the
production build:

```bash
npm run build          # from the repo root → cd frontend && vite build
```

Last verified build (Phase 22.4): **`✓ built` in 10.82 s** — entry chunk
**334.22 kB / 101.44 kB gzip**, shared chunk 70.46 kB / 27.81 kB gzip, CSS
140.70 kB / 21.22 kB gzip. Every portal page is route-split, so a storefront
visitor never downloads staff UI: `PortalGatewayPage` 8.80 kB / 2.45 kB gzip and
`OwnerAdministratorsPage` 27.87 kB / 6.39 kB gzip are separate chunks. The build
also acts as the syntax/module-resolution gate: an unresolved import or JSX
error fails it.

Frontend behaviour is verified **manually in the browser** (storefront and `/admin`),
inspecting console output, network requests, loading behaviour and data correctness.
Because screenshots cannot be captured in the cloud dev environment, visual checks
are done programmatically (computed styles / surface audits) rather than by image
diffing — there is **no visual regression automation**.

## Responsive audit harness

The one piece of automated frontend verification is a headless responsive
audit — it drives real Chrome over CDP and measures layout, so it catches the
regressions a build cannot:

```bash
node frontend/scripts/responsive-audit/run.mjs          # builds, then runs
node frontend/scripts/responsive-audit/run.mjs --no-build --only=owner-dir
```

- **Matrix:** every route in `run.mjs`'s `BASE_ROUTES` / `STATE_ROUTES` /
  `MENU_ROUTES` × up to 13 viewports (320, 360, 375, 390, 393, 412, 430,
  640 @200% zoom, 768, 820, 1024, 1280, 1440), plus a dark-mode pass on the base
  routes at 320/390/768/1440. Viewports are applied with
  `Emulation.setDeviceMetricsOverride` (Chrome clamps `--window-size`).
- **Fixtures, not production.** `scripts/responsive-audit/serve.mjs` serves
  `frontend/dist` with `audit.js` injected as the first child of `<head>`; the
  probe seeds a session, intercepts `window.fetch` and answers every API call
  from local fixtures. Production is never touched and no backend is needed.
- **What it fails on:** horizontal overflow, any JS error, a harness failure,
  and hard (sub-24px) touch targets on phone viewports. Elements between 24 and
  44 px are reported as `touch-small` **advisories** (usually table controls
  inside a deliberate horizontal scroll container), and scrollbar-induced
  viewport deltas as warnings.
- **Result (Phase 22.4):** `runs: 856  fails: 0  advisories: 2482  warns: 722` —
  **0 overflow and 0 JS errors at every viewport**, including the three portal
  logins, `/access`, the owner directory (with its dossiers and suspension
  modal), the owner and staff portal homes, the access-denied states, the
  public workspace route `/shops/:workspaceSlug`, and both admin-activation
  steps. Hard-touch failures on the storefront footer (first matrix route to
  render it) were fixed by widening its link targets to `py-1`.
  Snapshot committed under `scripts/responsive-audit/results/`.
- **The probe fails loudly.** A `window.onerror` trap writes
  `data-audit-error`, which the runner reports as `publish failed: <message>`
  instead of a silent 30-second timeout. Before it existed, one undefined
  fixture constant failed every route in the matrix with
  `timeout waiting for data-audit`.
- **Limitation — it does not exercise interaction.** Synthetic input does not
  reliably reach the app in this environment (even the theme toggle stays
  inert), so the audit proves *layout* and *that the page booted without a JS
  error*, not that a button's handler ran. Behaviour is verified in a real
  browser (see below).

## Required validation after a change

1. `npm run build` (frontend compile check) — for any frontend change.
2. `npm test` — the full sweep, **0 failures**; or the specific suites your change touches
   while iterating, then the full run before committing. Suite and assertion counts grow
   with each phase: read the latest recorded sweep in
   [AGENTS.md](../AGENTS.md#testing-commands) rather than trusting a number copied here.
3. Manual browser verification of the affected flow (storefront and/or `/admin`),
   including console and network inspection.

**Never weaken an assertion to make a suite pass.** If a suite fails, find out
whether the code or the expectation is wrong — these suites encode real security and
business invariants (server-authoritative pricing, ownership/404, idempotency,
exactly-one-deduction). Deleting or loosening such an assertion hides a real defect.

## Adding a test

- Prefer extending the closest existing suite; only add a new suite file if the
  domain is genuinely new.
- Follow the `bootTestServer({ port, db, env })` pattern and pick an **unused port
  and a dedicated `Flora-Alchemy-Test-*` database** — never the dev database.
- Always `stopTestServer(child)` in a `finally` block.
- Print a summary line matching the orchestrator's regex
  (`<NAME> RESULT: (\d+) passed, (\d+) failed`) and register the suite in the
  `SUITES` array of `scripts/run-all.mjs` so it runs in `npm test`.

### 3D Studio Phase 7 — colour fidelity (2026-10-23)

Phase 7 changed one measurement (`measureColourTier`), one verdict input (colour
as its own section of the quality gate), one projection (`quality.colour` on the
staff asset payload), the worker's export (`ensure_dielectric_material`) and the
viewer's lighting. No suite was renamed, skipped or loosened.

Verified on this tree, each suite run alone against its own disposable
`Flora-Alchemy-Test-*` database:

| Command | Result |
|---|---|
| `npm run test:3d-quality` | ✅ 106 / 0 (colour section 19, projection 3; Phase H3 adds fragmentation + depth-band checks) |
| `npm run test:3d` | ✅ 206 / 0 (plan-notes honesty, candidate inputs, no-bytes guards) |
| `npm run test:3d-agent` | ✅ 68 / 0 (candidate payload, `viewPolicy.inputMode`, metrics recorded before assessment) |
| `npm run test:3d-worker` | ✅ 53 / 0 (loopback stand-in, no GPU; candidate selection + fail-closed masking) |
| `npm run test:references` | ✅ 90 / 0 |
| `npm run test:security` | ✅ 111 / 0 |
| `npm run test:boot-gate` | ✅ 29 / 0 |
| `cd frontend && npm run build` | ✅ exit 0 |
| `npx playwright test specs/13-quality-review.spec.js` | ✅ 6 / 0 |
| `npx playwright test specs/11-image-studio.spec.js specs/12-product-3d.spec.js` | ✅ 8 / 0 |

**The browser suite earned its keep.** Its first run failed `FLOW 32` with
"element not found" for the colour block: the gate measured colour and stored it,
but the staff projection did not forward it, so the reviewer never saw it. The
backend suite could not catch that — it asserted the stored report. The
projection was fixed, three projection checks were added to the quality suite,
and the browser test now asserts the block and the server's own
`MATERIAL_MISSING_DIELECTRIC` reason on a real page.

Phase 7's colour bands (`maxNearBlackFraction` 0.35, `minMeanSaturation` 0.04)
are **provisional for the same reason Phase 5's were**: they were chosen from
measurement, not from a calibrated sample set, and a well-shaped dark model must
land in REVIEW rather than be passed. `THREE_QUALITY_MAX_NEAR_BLACK_FRACTION` and
`THREE_QUALITY_MIN_MEAN_SATURATION` override them for an experiment.

### Phase H3 — the input policy, verified against a REAL GPU run (2026-10-26)

Suites, each run alone: `test:3d` 206/0 · `test:3d-quality` 106/0 ·
`test:3d-agent` 68/0 · `test:3d-worker` 53/0 · `test:references` 90/0 ·
`test:security` 111/0 · `test:boot-gate` 29/0 · `cd frontend && npm run build` exit 0 ·
`npx playwright test specs/12-product-3d.spec.js specs/13-quality-review.spec.js` 12/12.

Then a genuine inference on the local RTX 4050 (`npm run test:3d-real`, artefacts in the
gitignored `audit/phase4-real-generation/`), on the SAME photograph that previously
produced the reconstructed-room shell:

| Fact | Before (2026-10-25) | After |
|---|---|---|
| input | `rgb-as-prepared` (the whole photo) | `segmented`, rembg `isnet-general-use`, 2.4 s |
| foreground share | n/a — nothing removed | 7.5% of frame, solid core 7.5% (ratio 1.0) |
| mask islands | n/a | 2 → 1 kept, 0.34% of the mask dropped as a stray island |
| mesh extents | 0.52 × 0.98 × 0.93 (the photo frame) | 0.44 × 0.45 × 0.94 (a tall thin sprig) |
| components | 43 islands | 8 found → 7 specks dropped, largest holds 99.4% |
| silhouette | `SILHOUETTE_UNAVAILABLE` | IoU 0.6187, aspect error 4.4%, boundary 2.97 px |
| gate | REVIEW (no evidence) | REVIEW (`SILHOUETTE_WEAK_MATCH`) — a human decides |
| mesh | 1 mesh, 1 material, COLOR_0 | 35 429 verts / 70 882 faces, watertight, COLOR_0 + NORMAL, 1 801 KB |
| inference | — | 9.3 s, peak VRAM 2 379 MB |

The model was then inspected from six angles in the shipped admin viewer (headless
Chromium against the real stack): the vase and lavender are correct in colour, the
background shell is gone, and the silhouettes of the reference and the model overlay
closely. The REVIEW verdict blocked approval until a note was typed; the Approve button
was disabled before it and the asset became APPROVED through the shipped service.
Nothing in this step relaxed a threshold or fabricated a mask.
