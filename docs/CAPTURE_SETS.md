# Multi-View Capture Sets (Phase 11)

The operator and engineer reference for the multi-view capture workflow: what a
capture set is, what each reconstruction engine requires, how a camera pose is
recorded, how a submission is planned and audited, and which parts of the quality
question remain unproven.

Implementation: `backend/services/captureSetService.js`,
`backend/services/engineCapabilities.js`, `backend/services/capturePose.js`,
`backend/models/CaptureSet.js`, `backend/controllers/captureSetController.js`,
`backend/routes/captureSetRoutes.js`, `frontend/src/components/admin/CaptureSetPanel.jsx`.
Tests: `npm run test:capture` (`backend/scripts/capture-set-smoke.mjs`).

---

## 1. What a capture set is, and is not

A **capture set** is the set-level record beside a product's reference images:

- the **capture profile** (rig, camera, lens, distance, FOV, background, lighting);
- the **coverage** of labelled views and what is missing;
- a **validation snapshot** the server computed, with a **verdict per engine**;
- an **append-only history** of explicit submissions (engine, exact input ids in
  order, hashes, camera poses, payload fingerprint, job and provider task ids).

It is **not** a replacement for the reference studio. Uploading, cutting composite
sheets, labelling views and accepting photographs stay in
`ReferenceImageStudio.jsx`; a capture set reads the *accepted* rows and writes only
set-level truth.

Two rules are load-bearing:

1. **Uploading never creates, validates or submits a set.** A set changes only in
   response to an explicit staff request.
2. **A pose is recorded, never inferred.** There is no estimation path anywhere in
   this pipeline. A partial pose is refused rather than completed with defaults.

---

## 2. The lifecycle

```
draft ──▶ collecting ──▶ validated ──▶ submitted ──▶ processing ──▶ completed
  │            │             │              │              │
  │            │             │              └──▶ failed ◀──┘
  └────────────┴─────────────┴──────────────────▶ archived
```

| State | Meaning |
|---|---|
| `draft` | No accepted photographs, or the set was just created. |
| `collecting` | Photographs exist but do not satisfy any engine's input contract. |
| `validated` | The PHOTOGRAPHS satisfy at least one engine's contract. |
| `submitted` | A submission was claimed and is being handed to the generator. |
| `processing` | A generation job exists for the submitted plan. |
| `completed` / `failed` | The outcome recorded for the last submission. |
| `archived` | Terminal. |

Two details that matter:

- **`validated` is about the photographs, not the deployment.** A complete five-view
  capture is `validated` even on a deployment with no provider configured.
  "Would an engine accept this?" (`validation.validFor`) and "could I submit right
  now?" (`validation.readyFor`) are separate answers. Conflating them made a default
  install report a complete capture as `collecting`.
- **Transitions are server-enforced.** `PATCH /api/capture-sets/:id` rejects any
  `status` field with `CAPTURE_SET_STATUS_READ_ONLY`; there is no request shape that
  can move a set to `validated` without the server measuring it.

---

## 3. What each engine requires

Single source of truth: `backend/services/engineCapabilities.js`. Every entry
carries an **evidence state** — `measured` (this project ran it), `verified`
(checked against provider docs) or `unverified` (declared, never confirmed).

| Engine | Installed | Input contract | Requires poses | Metered | Evidence |
|---|---|---|---|---|---|
| `local_single_view` (TripoSR) | yes | 1 photograph, unposed | no | no | **measured** — the shipped baseline |
| `meshy_multi_image` (Meshy 7.1) | yes | 2–4 photographs, unposed | no | **yes** | **unverified** — adapter exists, never executed here |
| `hunyuan3d_2mv` | no | 2–4 named views, unposed | no | no | **measured** — three views were *worse* |
| `reli3d` | no | 3–8 views **with** camera-to-world poses + FOV | **yes** | no | **unverified** — never run here |

Consequences enforced in code:

- A capture set is validated **per engine**. The same rows are `valid` for Meshy and
  invalid for ReLi3D; stripping the poses flips only the pose-requiring engine.
- An engine with no adapter (`installed: false`) can be *evaluated against* but never
  submitted to (`ENGINE_NOT_INSTALLED`), and cannot be selected in the UI.
- An engine that is not the deployment's provider reports *why*
  (`ENGINE_DISABLED`), rather than silently disappearing.

### Hunyuan3D-2mv — what was measured

Run twice on the operator's RTX 4050 (6 GB), same checkpoint/seed/steps, only the
input set differing (`phaseD/PHASE_D2_REPORT.md`):

- Three views were **worse** than one: aspect 0.82 → 0.60 (a horizontal slab),
  components 1274 → 1333.
- Peak device VRAM 5708 MiB; GLB 10.96 MB; export is `POSITION` only — no normals,
  UVs, materials or textures. Normals can be added offline (10.96 → 14.62 MB), which
  shades but does not correct.
- The quality gate **could not score it**: the sheet has no alpha, so there is no
  silhouette (`exit 2`, "The model was NOT assessed").
- Licence: Tencent Hunyuan Community Licence — excludes the EU, United Kingdom and
  South Korea; above 1,000,000 MAU a separate written licence is required; the
  texture stage needs 16 GB.

**The failure was the input set, not the model.** A supplier render sheet whose cells
disagree about scale, centring and framing fuses into a slab. That is why a composite
sheet is treated as provenance and never as a view.

### ReLi3D — why it has not run

Its contract asks for `transforms.json` camera-to-world poses plus FOV per view.
No capture in this repository has ever carried one. Inventing poses to launch it
would validate a lie, so it stays declared-and-not-installed. Its blocker is the
**input contract**, not VRAM.

### Meshy 7.1 — how it is gated

Three independent facts, none of which a request can forge:

1. `THREE_D_PROVIDER=meshy` **and** `MESHY_API_KEY` set (existing provider policy);
2. `THREE_D_METERED_SUBMIT=true` — a **deployment** decision;
3. `acknowledgeMetered: true` in the submit request — a **staff** decision made in
   the confirm dialog.

Without 3 → `ENGINE_NOT_AUTHORISED`; without 2 → also `ENGINE_NOT_AUTHORISED`;
without 1 → `ENGINE_DISABLED`. There is no silent fallback to a free engine, and an
upload can never turn into a bill. Product photographs are transmitted to Meshy when
submitted — that is a third-party data transfer and it is stated as such in the
registry's licence block.

---

## 4. Recording a camera pose

Stored on the reference row itself: `ProductReferenceImage.pose`.

```json
{
  "position": { "x": 0, "y": 0, "z": 2 },
  "target":   { "x": 0, "y": 0, "z": 0 },
  "fov": 40,
  "source": "manual"
}
```

| Rule | Value |
|---|---|
| Convention | Camera-to-world, right-handed, Y-up; metres and degrees |
| `source` | `manual` or `imported` — **never** `inferred` |
| `distance` | **Derived** on write from position and target; never supplied |
| FOV range | 5°–120° |
| Distance range | 0.05 m–500 m (a product capture is 0.2–5 m) |
| Coordinates | Finite; `|axis| ≤ 1000` |

Write path: `PATCH /api/references/:id` with `{ "pose": … }`; `null` clears it
explicitly. Refusals: `POSE_INCOMPLETE` (no FOV), `POSE_INVALID` (partial or
non-finite), `POSE_SOURCE_INVALID` (`inferred`), `POSE_DEGENERATE` (camera at its
target), `POSE_OUT_OF_RANGE`. A refused write **never** overwrites a stored pose.

Set-level consistency (`poseConsistency`): a FOV spread over 5° or a camera-distance
spread over 10 % of the mean is reported as *probably two sessions or a moved camera*.
Framing itself is a rendering property this server cannot measure from a photograph;
a recorded FOV/distance is the cheapest detectable proxy for the failure that was
actually measured, and it only ever warns.

Existing rows have `pose: null` — no migration is needed, and a null pose is simply
"not recorded".

---

## 5. The submission plan (one authoritative decision)

`buildSubmissionPlan()` produces, from the accepted rows and the chosen engine:

- the exact **input ids, in order** (deterministic: view priority → studio `order` →
  id, so the same rows always yield the same list);
- whether each input has a pose, plus the pose values when present;
- `viewsSent`, `unusedViews` (truncated by `maxInputs`), and a readable
  `payloadFingerprint` of ids + views + hashes.

View priority: `front, back, left, right, top, three-quarter-left,
three-quarter-right, bottom, wrapping, detail, texture, other` — so truncation drops
detail shots before a side.

**The bug this closes:** an earlier draft returned every view id while the provider
adapter truncated to `maxInputs`, so the audit record and the actual request could
disagree. The ids in the plan are the ids the generator receives and the ids written
to the audit.

Submission sequence (`executeSubmission`):

1. build the plan for **that** engine (validation is per engine);
2. **atomically claim** the set — a state guard on `validated|completed|failed` plus
   `activeJobId === ''`, so a double click cannot bill twice (`CAPTURE_SET_BUSY`);
3. start generation with exactly those ids;
4. **append** the audit entry (never update a previous one);
5. on failure: record `failure` and move to `failed`, appending an entry whose
   outcome is `failed` — a submission that did not start is never reported as sent.

`POST /api/capture-sets/:id/plan` is the **dry run**: same plan, no writes, no
provider contact. Use it to check what a metered run would send.

---

## 6. API

All routes are staff-only (`protect` → `adminOrHandler` → `requireWorkspace` →
`requirePermission`) and workspace-scoped; a mismatch is a `404`, never a `403`.
There is no public route.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/capture-sets/engines` | `products.view` | Registry + provider facts + metered switch |
| GET | `/api/capture-sets/capabilities` | `products.view` | Full registry |
| GET | `/api/capture-sets?productSlug=` / `?draftKey=` | `products.view` | Live state (no writes) |
| POST | `/api/capture-sets` | `products.update` | Start / reopen a set |
| PATCH | `/api/capture-sets/:id` | `products.update` | Profile + engine (never status) |
| POST | `/api/capture-sets/:id/validate` | `products.update` | Recompute + persist |
| POST | `/api/capture-sets/:id/plan` | `products.view` | Dry-run submission plan |
| POST | `/api/capture-sets/:id/submit` | `products.update` | **The explicit action** |
| POST | `/api/capture-sets/:id/archive` | `products.update` | Archive (refused while processing) |

A `draftKey` is accepted only when the caller already owns reference rows filed under
it in the same workspace (`CAPTURE_SET_DRAFT_NOT_FOUND` otherwise), so a guessed key
cannot be adopted. A `productSlug` must resolve to a real product in the caller's
workspace. Draft sets can be validated and planned but **not submitted** — generation
runs against a saved product (`CAPTURE_SET_NEEDS_PRODUCT`).

---

## 7. The capture workflow, in practice

1. Photograph the product once, in one session, with the arrangement unchanged.
2. Required views: `front`, `back`, `left`, `right`. Add `top` — the crown is the
   least-constrained structure and the first thing a reconstruction loses.
3. Same distance, same lens, same height, product centred, whole bouquet in frame
   including wrap and ribbon tails. Plain background, consistent lighting, no hands
   or clutter behind the flowers.
4. Upload and accept the photographs in the reference studio, label each view.
5. Open **Multi-View Capture** on the product page. Coverage, errors and warnings are
   live; nothing has been generated.
6. Record a pose per view **only if you measured it** (`Record pose`). The panel says
   so explicitly.
7. Choose an engine. The panel lists what that engine requires and whether this set
   satisfies it. Check the **Submission plan**: which images, in what order, how many
   are left out.
8. Submit. For a metered engine, tick the charge confirmation — and only if the
   deployment allows it.
9. Review the candidate in the 3D Model Studio below. **Approval remains manual**;
   the quality gate still runs and can still refuse.

**What is not a capture set:** a rendered turntable, a collage, or a supplier contact
sheet. Cut panels from a confirmed sheet are usable *views*, but the sheet itself is
provenance and never an input.

---

## 8. Tests

`npm run test:capture` — 142 checks, no GPU, no network, no inference. The provider is
an explicit test double; the pose field, capture-set model, lifecycle, deterministic
plan and every HTTP gate are real.

Sections: `§A` registry facts and evidence states · `§B` engine-specific validation
(including the same rows valid for one engine and invalid for another) · `§C` pose
contract · `§D` lifecycle · `§E` persistence and append-only history · `§F` plan
determinism, truncation and double-claim refusal · `§G` HTTP gates, status
read-only, metered refusal, tenancy · `§H` end-to-end submission through the double.

**Browser coverage:** `frontend/e2e/specs/16-capture-set.spec.js` (FLOW 56–58) drives the
mounted panel against the real stack and the real API. It proves that opening the
product page is a READ (no set exists afterwards), that Start is the explicit create, that
a four-view cover is ready for the single-view engine and refused for Meshy/ReLi3D with
the deployment named as the reason, that the plan sends 1 of 4 views, that a recorded
pose persists with its source and a partial pose is refused **without erasing** the good
one, that cancelling the confirmation leaves no submission, that a client-supplied status
is rejected `422 CAPTURE_SET_STATUS_READ_ONLY`, that an anonymous read is `401`, and that
a failed registry load shows the cause and recovers through Retry. The stack selects
`THREE_D_PROVIDER=local_worker` with **no worker running**: the provider path is real but
cannot infer, transmit or spend.

That is workflow coverage, not reconstruction evidence. The fixture views are synthetic
and no engine ran, so nothing here measures a mesh.

---

## 9. Known limitations

- **No calibrated capture exists**, so no multi-view result has been produced or
  inspected. Reconstruction quality is **not** demonstrated.
- **ReLi3D is not integrated** and must not be described as working; it needs poses.
- **`hunyuan3d_2mv` is not integrated**, because the measured three-view result was
  worse and its licence excludes the EU/UK/South Korea.
- **Meshy has never been executed.** Its contract is marked `unverified` and it needs
  explicit authorisation plus credentials.
- **Pose framing cannot be verified from pixels.** Only recorded FOV/distance
  consistency is checked.
- **Browser coverage proves the workflow, not the mesh.** `16-capture-set.spec.js`
  runs against synthetic fixture views and an unreachable worker, so no reconstruction
  is inspected there.
