# Phase 11 — Multi-View Capture: implementation status and remaining work

Status as of **2026-10-30**, on `main` (baseline `cfdad76`).

**Verdict: `INFRASTRUCTURE COMPLETE — RECONSTRUCTION VALIDATION PENDING`.**
The capture workflow is implemented, wired, tested and documented. The quality
objective is **not** met: no multi-view reconstruction has been produced, inspected
from multiple angles, and shown to beat the single-image baseline, because no
calibrated capture set exists yet.

Operator/engine reference: [CAPTURE_SETS.md](./CAPTURE_SETS.md).

---

## 1. What was built

| Area | Delivered |
|---|---|
| Pose contract | `backend/services/capturePose.js` — one definition of a valid pose; `manual`/`imported` only, derived distance, every malformed shape refused |
| Pose persistence | `ProductReferenceImage.pose` + `PATCH /api/references/:id` (`{ pose }`), recording who and when; `null` clears explicitly |
| Engine registry | `backend/services/engineCapabilities.js` — per-engine input contracts with an explicit evidence state |
| Capture service | `backend/services/captureSetService.js` — structural validation, per-engine verdicts, lifecycle, deterministic plan, append-only audit, `executeSubmission` |
| Record | `backend/models/CaptureSet.js` — profile, validation snapshot, append-only submissions, workspace-scoped |
| API | `backend/controllers/captureSetController.js`, `backend/routes/captureSetRoutes.js`, mounted at `/api/capture-sets` in `server.js` |
| UI | `frontend/src/components/admin/CaptureSetPanel.jsx` + `frontend/src/services/captureSetService.js`, mounted on the product page between the reference studio and the generation studio |
| Tests | `backend/scripts/capture-set-smoke.mjs` → `npm run test:capture` (142 checks), registered in `run-all.mjs` |
| Docs | this file, [CAPTURE_SETS.md](./CAPTURE_SETS.md), `AGENTS.md`, `backend/.env.example` |

### Corrections made to the earlier draft

These were the audit's findings; each is now fixed rather than documented around:

1. **`POSE_STORAGE_NOTE` pointed at a field that did not exist.** The field now
   exists, with a validated write path and a test that a partial pose cannot
   overwrite a valid one.
2. **`draftKey` was unreachable and unguarded.** A set under a draft key now requires
   the caller to already own reference rows under that key in the same workspace, and
   the ownership check happens before the record is created.
3. **The plan and the request could disagree.** `buildSubmissionPlan` is the single
   decision; the ids it returns are the ids persisted and the ids handed to the
   generator, and a test asserts exactly that.
4. **One global `complete` flag decided everything.** Validation is now per engine, so
   a missing pose blocks ReLi3D and does not block Meshy.
5. **"Complete" was conflated with "an engine is available".** A full capture on a
   provider-free deployment was reported as `collecting`; capture completeness
   (`validFor`) and submission readiness (`readyFor`) are now separate.
6. **Mongoose reserved pathname.** The stored field is `issues`, projected to `errors`
   in the API, because `errors` shadows `Document#errors`.

## 2. Test results (this tree)

| Command | Result |
|---|---|
| `npm run test:capture` | **142 passed, 0 failed** (exit 0) |
| `npm run test:references` | 90 passed, 0 failed |
| `npm run test:3d` | 219 passed, 0 failed |
| `npm run test:security` | 111 passed, 0 failed |
| `npm run test:boot-gate` | 29 passed, 0 failed (the tree boots and mounts what it claims) |
| `npm run test:3d-quality` / `test:3d-agent` / `test:3d-worker` | 113 / 68 / 53 passed, 0 failed |
| `npm run test` (full sweep) | **3160 passed, 0 failed across 34 suites**, 0 environmental, exit 0 |
| `npm run build` (frontend) | success |
| `npm run build:e2e` | success |
| `npx playwright test` (full browser suite) | **119 passed, exit 0** (10.4 min), including the new `16-capture-set.spec.js` FLOW 56–58 |

No AI inference, no GPU and no network call is made by any of these. The provider in
the capture suite is an explicit test double; the child server it also boots has **no
provider selected**, which is how "a default deployment refuses to submit" is proven
rather than assumed.

## 3. Remaining blockers

| # | Blocker | Exact requirement |
|---|---|---|
| 1 | **No calibrated capture set exists** — the load-bearing blocker | One product, one session, one rig: `front`, `back`, `left`, `right` (+ `top`), same distance/lens/height, centred, whole bouquet in frame, plain background, consistent lighting |
| 2 | Poses unrecorded | Position, target and FOV per view, measured — via the panel or an import. Never inferred |
| 3 | No multi-view engine enabled | `hunyuan3d_2mv` measured worse on a sheet; `meshy` needs credentials **and** authorisation; `reli3d` has no adapter |
| 4 | Licence/hardware limits stand | Hunyuan: EU/UK/South Korea excluded, 1M-MAU trigger, 16 GB for texture; local shape generation fits the 6 GB card |
| 5 | ~~No browser coverage for the capture panel~~ | **Closed** — `frontend/e2e/specs/16-capture-set.spec.js` (FLOW 56–58) drives the mounted panel against the real stack. It proves the workflow, not a mesh: the fixture views are synthetic and the stack's worker is unreachable on purpose |

## 4. What would change the answer

Not another model run: **a real capture of a real product**. With it:

1. submit the same product's set to a multi-view engine, keeping the single-image
   TripoSR model as the baseline;
2. compare front, back, left, right and top **separately**;
3. judge flower-head separation, wrapping geometry, colour leakage and
   watertightness — not front silhouette IoU alone;
4. record runtime, peak VRAM and GLB size as measured facts;
5. keep the quality gate and manual approval exactly as they are.

Until then, the honest statement is: the pipeline is ready to receive a capture and
will refuse to pretend an incomplete one is complete. That is preparation, not
evidence, and Phase 11's quality objective stays open.
