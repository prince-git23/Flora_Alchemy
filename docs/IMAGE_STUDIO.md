# 3D Studio — Multi-View References, a Generated Model (Phase 2) & the Customer 3D Experience (Phase 3)

> **Read this first (multi-view work, 2026-10-22).** The original Phase 1 ran a
> BACKGROUND-REMOVAL engine on every upload. On real product photography it removed
> the product: a bouquet lost petals, stems, ribbon and wrapping, and the model was
> then reconstructed from that damage. That engine, its endpoints, its controls and
> its model fields' writers have been **removed**, and the studio now collects
> MULTI-VIEW references instead. See
> [Multi-view references](#multi-view-references-2026-10-22) for the current
> behaviour; the Phase 1 sections further down are kept as the historical record of a
> shipped phase and describe cutouts that the product no longer produces.

Phase 1 is [below](#phase-1--prepare-images); **Phase 2 — generate, review and approve a
3D model — is in its own section** at [Phase 2 — Generate a model](#phase-2--generate-a-model).

---

# Multi-view references (2026-10-22)

## What was removed, and why

The automatic background cutout was the defect. It was not merely inaccurate: it
*replaced* the reference a reconstruction model reads with a copy in which the
product's own edges had been classified as background. The contract for the removal
was explicit — do not hide the button while the backend keeps generating cutouts — so
**the execution path is gone**, not bypassed:

| Removed | Where it was |
|---|---|
| The deterministic segmentation engine, the rembg adapter and the cutout metrics | `backend/services/bgRemoval/` (deleted: `index.js`, `deterministicEngine.js`, `rembgProvider.js`, `cutoutMetrics.js`) |
| The licence guard that existed only to refuse non-commercial segmentation weights | same directory |
| `POST /api/references/:id/reprocess` with a crop; `PATCH /api/references/:id` with `crop` | now answers `422 CROP_NOT_SUPPORTED` (`/reprocess` re-measures instead) |
| `GET /api/references/engine` | replaced by `GET /api/references/options` |
| The ORIGINAL/CUTOUT pair, the transparency checkerboard, `Fix crop`, the retry-processing control and the cutout-derived warnings | `frontend/src/components/admin/ReferenceImageStudio.jsx` |
| Background-separation warnings (“the background could not be separated”, “multiple products may be present”, “product may be cropped too tightly”) | `services/referenceImageValidation.js` — they described a cutout that no longer exists |
| Writing `cutout` / `neutral` assets | `services/referenceImageService.js` |

**Kept on purpose**

- `ProductReferenceImage.cutout` / `.neutral` remain declared, with **no writer**, so
  previously stored media can still be read (`GET /api/references/:id/file/cutout`
  still answers for a legacy row) and deleted by the existing cleanup paths. Nothing
  deletes a stored asset.
- `legacyCutout` records that a row predates the removal. No new row can acquire it.
- The ImageKit storefront product-image workflow is untouched.
- The quality gate, staff review, approval, private storage, tenancy and the 32 MiB
  GLB ceiling are untouched (see the note under
  [What the gate now measures](#what-the-gate-now-measures)).

## The three accepted inputs

1. **One ordinary photograph.** Uploaded, stored verbatim, measured. It is never
   segmented, cropped or re-encoded.
2. **One composite sheet** — a grid of views of the same piece (12 panels is a
   supported example, not a rule). The server detects the grid and proposes panels;
   a human confirms or corrects the layout before anything is cut.
3. **Several separate photographs.** Each is its own reference; order, primary,
   viewpoint label, replace and remove all work exactly as before.

A mixture is fine: a composite plus detail shots of the same product is the intended
use. Panels and photographs are views of ONE product; they are never treated as
several products.

## Composite detection and panel extraction

`backend/services/referenceViews.js` does the work, deterministically, with `sharp`
only — no model, no network call.

1. The image is decoded once, EXIF-rotated, greyscaled and downscaled to 768px for
   ANALYSIS (the CROP is always taken from the full-resolution original).
2. **Seams** are found per axis: runs of columns/rows that are both flat
   (`stdev ≤ 4.5`) and gradient-free (`≤ 3.5`). A gutter qualifies; a product edge does
   not.
3. **Periodicity** decides the count: cell spans between consecutive separators (and
   between the separators and the sheet edges) must be roughly equal
   (`coefficient of variation ≤ 0.12`). This is computed from the separators
   themselves, **not** from `width / count` — an outer margin would otherwise shift
   every expected boundary and make a real 4×3 sheet read as 2×1 (a bug the suite now
   pins).
4. A boundary is the **outer edge** of a separator band, so a 16px gutter donates no
   pixels to either neighbour and leaves no white stripe on the panel.
5. Confidence is the weaker axis score. Below `0.55`, or when either axis is
   unexplained, `needsCorrection` is set and **nothing is cut**. The studio opens the
   grid workspace on the proposal instead.

Supported/likely layouts: 3×4, 4×3, 2×2, 2×3, 3×2, 4×2, 2×4, … up to
`GRID_LIMITS.maxPanels = 24`, plus declared layouts up to 8×8 where the count is
within the panel budget. A layout the detector cannot explain is *correctable*, never
invented.

### Confidence and correction

- The proposal is drawn over the original with numbered boxes. Nothing exists as a
  view yet.
- Columns, rows and a border trim (0–100px, applied symmetrically INSIDE each cell)
  can be changed; each change re-asks the server for a preview
  (`GET /api/references/:id/views?columns=…&rows=…&padding=…`) and nothing is written.
- “Create N views” (`POST /api/references/:id/views`) cuts them. Re-confirming the
  same layout **updates** the existing rows (`created: []`, `updated: [...]`), so an
  idempotent retry cannot duplicate views. Shrinking the grid removes the views that
  no longer exist, files included.
- “Not a grid” records `composite: false`. It never deletes views.

### Original vs extracted

- The composite's ORIGINAL is written once and never overwritten. Its sha256 is
  unchanged by cutting panels (the suite asserts this).
- A panel row stores **its own original**: the crop, at full resolution, as PNG, with
  `source.parentId`, `source.panelIndex`, `source.grid` and `source.box` — so every
  view is traceable to its sheet and its coordinates.
- A panel **can never be split again** (`422 PANEL_NOT_COMPOSITE`). Reprocessing a
  panel re-measures it; it never re-crops it. That is the repeated-cropping trap.
- Deleting a sheet deletes the views cut from it (files included). Replacing a view
  keeps its slot, label and primary flag.

### The sheet is provenance, not a viewpoint

Once its views exist, the composite itself stops being a *view*. It is a **source
document**: kept, attached to the product, and never sent to the reconstruction.

- The studio labels its card `Source sheet · N views` and replaces the **Accept**
  button with “Kept for audit — not a view”. **Accept all** skips it.
- When accepted views are handed to a saved product (`POST /api/references/attach`),
  their sheets ride along automatically so the original composite survives the draft
  cleanup and stays traceable. The response reports the two numbers separately:
  `attached` (accepted views) and `sourceSheets` (provenance rows).
- The exclusion is a **server** property, not a UI convention.
  `isSourceSheet()` in `referenceImageService.js` gates `planForProduct()` (what the
  plan counts and lists) and `loadReferenceBuffers()` (what the in-process provider
  receives); `3dAgentService.jobInput()` applies the same filter to the remote GPU
  agent's payload. A client that force-accepts the sheet through a raw `PATCH` still
  gets a plan of exactly the cut views — §J of `npm run test:references` proves this
  adversarial case.
- Why it matters: handing the whole grid to an image-to-3D engine would ask it to
  reconstruct twelve products at once, from one image.

## View labels, order and duplicates

- `viewAngle` is optional and never inferred: `front`, `back`, `left`, `right`,
  `three-quarter-left`, `three-quarter-right`, `top`, `bottom`, `detail`, `texture`,
  `wrapping`, `other`. An unknown label is refused (`422`).
- The whole set is reordered in one call (`PATCH /api/references/order`), and the
  first item becomes primary. The studio always sends the whole ordered list.
- Byte-identical uploads are reported as duplicates (`duplicateOf`) rather than
  silently merged or refused: the row exists and can be removed.
- The set-level “these may show different products” heuristic ignores panels of the
  same sheet (they are one object by construction) and is worded as a colour check.

## Which model is used — and whether it is genuinely multi-view

**The configured reconstruction engine is TripoSR, and it is SINGLE-IMAGE.** That is
not a limitation of our adapter; it is the model. Evidence:

- `tools/3d-worker/worker.py` declares `MODEL_KIND = "single-image reconstruction"`
  and **raises** when more than one image is supplied (`"TripoSR is single-image; N
  views were supplied"`) rather than silently using the first.
- `services/3dGpuAgentProvider.js` and `services/3dLocalWorkerProvider.js` report
  `maxInputs: 1, supportsMultiView: false`.
- `services/3dModelProvider.js` slices the accepted set to `maxInputs` and now says so
  in the plan: *“N accepted views are stored, but <provider> reconstructs from ONE
  image: 1 view is sent…”*, with `unusedViews`.
- `services/3dAgentService.jobInput` sends **only the views the model consumes** and
  returns an explicit `viewPolicy` block (`supportsMultiView`, `acceptedViews`,
  `viewsSent`, `reason`). Passing twelve images to a single-image model would be
  theatre; the protocol now states what happened.

So: **true multi-view reconstruction is NOT operational.** Twelve views are ingested,
stored, labelled and reviewable, and eleven of them are honestly reported as unused.
Nothing in the UI claims otherwise.

### What the gate now measures

The Phase 5 quality gate needed a reference silhouette. With segmentation gone, its
mask can only come from transparency the SOURCE image carries. So:

- a reference PNG with genuine alpha is still measured (IoU, aspect, contour, view
  selection);
- a photograph has no mask → `SILHOUETTE_UNAVAILABLE` + `REFERENCE_MASK_MISSING`,
  which is **REVIEW**, never a silent pass and never BLOCKED. Approval therefore still
  requires a human note; the gate refuses to call a model good on no evidence.
- No mask is fabricated anywhere. `scripts/3d-quality-report.mjs` exits 2 on a
  reference with no alpha.

## Phase D — candidate multi-view engines (research, 2026-10-22)

The brief asked for a defensible local multi-view approach on an RTX 4050 Laptop
(~6 GB VRAM) with commercial-use clearance. Findings, with the constraint that a
non-commercial weight cannot enter this pipeline (the same rule that refused rembg's
`bria-rmbg`):

| Model | Genuinely joint multi-view? | ~6 GB? | Mesh? | Licence | Verdict |
|---|---|---|---|---|---|
| **TripoSR** (current) | **No** — single image | yes | yes | MIT | works, but cannot use the views |
| **Hunyuan3D-2mv** | **Yes** — named views into one shape pipeline | shape ≈ 6 GB | yes (GLB/OBJ) | Tencent Hunyuan 3D 2.0 Community License: commercial use **excluded in the EU, UK and South Korea**; 1M-MAU trigger | **best technical fit; blocked on a licence the owner must accept** |
| InstantMesh | No — it *generates* views from one image | not dependable | yes | repo Apache-2.0, but its Zero123++ component weights are CC BY-NC 4.0 | refused: non-commercial component |
| TRELLIS / TRELLIS.2 | Yes (TRELLIS) / no evidence (2) | no — 16 GB / 24 GB | yes | MIT | too much VRAM |
| Hunyuan3D-2.1 | not reliably (single-image default) | no — 10 GB shape | yes | same territory-restricted licence | too much VRAM |
| Stable Fast 3D | No | yes | yes | Stability Community License (revenue cap, registration) | not multi-view |
| Zero123 / Zero123++ / SV3D / MVDream | No — novel views from one image | mixed | no (images only) | Zero123++ weights CC BY-NC 4.0; SV3D non-commercial | refused |
| VGGT / DUSt3R / MASt3R / MapAnything | Yes — geometry/cameras | ≈ 4 GB (10 frames, VGGT) | **no native mesh**; points/depth | original VGGT NC; VGGT-1B-Commercial gated; DUSt3R/MASt3R CC BY-NC-SA; MapAnything Apache checkpoint exists | only with a separate meshing stage, and 6 GB is unverified |

**Recommendation, stated plainly:** implement the ingestion, panel, management and
protocol work now (done), and treat *multi-view inference* as a separate decision the
owner must make, because the only candidate that uses the views jointly within the
hardware budget carries a territorial licence restriction. No model was downloaded, no
environment was rewritten, and Meshy was not enabled as a fallback.

### What installing it would take

1. Owner decision on the Hunyuan licence (territory, MAU, notice obligations) — or a
   different, licence-cleared checkpoint.
2. A new worker engine alongside TripoSR in `tools/3d-worker/` (its own venv; the
   TripoSR environment stays untouched), and a provider descriptor with
   `supportsMultiView: true` and `maxInputs` matching the model's named-view contract.
3. Nothing else: `jobInput` already sends the full set when `supportsMultiView` is
true, the plan already reports unused views, and the gate/approval path is unchanged.

## Readiness reporting

`npm run report:3d` (`backend/scripts/three-readiness-report.mjs`) reports the six
stages separately instead of one “3D ready” verdict: **reference ingestion**, **composite
panel detection**, **accepted multi-view reference set**, **multi-view reconstruction**
(blocked, with the reason), **generation provider**, **private storage & bucket
privacy**, plus approved models and the GPU-agent heartbeat.

## Tests

`npm run test:references` (90 checks) covers: ordinary upload with no derived image,
byte-verbatim storage, duplicate detection, 4×3 and 3×4 detection, panel geometry
(one cell, no gutter, product kept), preview-writes-nothing, idempotent re-confirm,
uncertain/no-gutter correction, declared layout obedience, grid shrink, oversized and
single-panel refusals, panel-not-splittable, in-place crop refusal, separate-photo sets,
order
and primary, labels, accept/remove cascade, tenancy/404, anonymous/customer/
permission gates, missing-original failure, transparent-PNG preservation, oversized
source refusal, and — §J — source-sheet provenance (the sheet survives the product
handoff un-accepted, and the plan still counts only the cut views even when a raw
`PATCH` force-accepts it).

The quality, 3D, agent, worker, media-storage and boot-gate suites were updated to the
new behaviour rather than weakened: fixtures write their reference as a transparent
ORIGINAL (so the silhouette gate still measures a genuine mask), and the provider
plans now assert the single-image view policy explicitly.

An administrator uploads product photographs — plain studio shots, photos with busy
backgrounds, and promotional flyers — or ONE composite sheet containing a grid of
views, and the portal prepares a clean multi-view reference set: the untouched
**original**, plus one **panel** per detected view when the upload is a composite,
each measured, validated and reviewable before it is saved with the product.

There is no cutout and no neutral preview any more. Those were derived images, and
deriving them is exactly what damaged the product.

**Phase 1 stops at prepared images.** There is no 3D generation, no GLB output and no
third-party generation API here — a fake generate button would be worse than none.
Phase 2 consumes the accepted set (see [Phase 2 interface](#phase-2-interface) below).

The studio is the section **“3D Studio — Prepare Images”** on the admin create-product
page and the product detail (edit) page. It is not a separate application and does not
duplicate the product workflow: existing catalogue photos (`image` / `images`) are
untouched, and reference images are internal working assets.

---

## Implementation map — what was reused vs. added

| Concern | Reused | Added in Phase 1 |
|---|---|---|
| Auth / roles | `protect`, `adminOrHandler`, `requireOwner`, `AdminRoute` | — |
| Tenancy | `requireWorkspace`, `stripClientWorkspaceId`, `getWorkspaceId` (`utils/tenancy.js`) | — |
| Permissions | `requirePermission('products.view' / 'products.update')` | — |
| Rate limits | `uploadLimiter` (applied to the multipart POST only) | — |
| Upload parsing | `multer` memoryStorage, same MIME/size rules as `/api/uploads/product-image` | `referenceUploadMiddleware` in `controllers/uploadController.js` |
| Image decode | `sharp` (already the project's image dependency) | — |
| Storage | local-disk pattern of the existing dev upload path | `services/referenceAssetStorage.js` — a **private** root, served through the API only |
| Data model | Mongoose conventions, `toJSON` id transform, `workspaceId` scope | `models/ProductReferenceImage.js` |
| API shape | `{ success, ... }` / `{ success:false, message, code }`, `ApiError` | `routes/referenceImageRoutes.js`, `controllers/referenceImageController.js` |
| HTTP client | `apiClient` (`api.*` JSON, `postForm` for progress) | `frontend/src/services/referenceImageService.js` |
| UI shell / tokens | `AdminStatusPill`, existing `--color-*` tokens, `Skeleton` conventions | `components/admin/ReferenceImageStudio.jsx` |
| Products | `productController` create/update/delete/rename paths | accept + bind the accepted reference set |

Background removal is **server-side**. No ML model runs in the browser.

---

## How processing works

```
POST /api/references (multipart "image")
  → validate bytes (sharp decode, format, pixels)         services/referenceImageValidation.js
  → write the ORIGINAL (once, immutable)                  services/referenceAssetStorage.js
  → create row: status UPLOADING                          models/ProductReferenceImage.js
  ← 201 { image, duplicateOf, setWarnings, setNotes }     (returns immediately)
  ── background job ─────────────────────────────────────
  → MEASURE only: dimensions, format, alpha, sharpness,   services/referenceImageValidation.js
    contrast, edge mean, colour signature
  → NO segmentation — nothing is cut out, masked or re-encoded
  → row: READY | NEEDS_REVIEW | FAILED
```

The client polls `GET /api/references?productSlug=|draftKey=` while any row is
`UPLOADING`/`PROCESSING`. Status vocabulary: `UPLOADING`, `PROCESSING`, `READY`,
`NEEDS_REVIEW`, `FAILED`.

`READY` requires confidence ≥ 0.7 and no warnings; anything else lands in
`NEEDS_REVIEW` with the reason attached, so a reviewer reads the reason instead of
discovering a wrong result later.

### Measuring, not segmenting

There is no engine any more, and no replacement was put in its place — deliberately.
`services/bgRemoval/` (`index.js`, `deterministicEngine.js`, `rembgProvider.js`,
`cutoutMetrics.js`) was **deleted** with the cutout feature: those engines segmented
petals, stems, ribbon and wrapping out of real product photographs, which is the
defect this phase exists to fix.

What runs instead is measurement only — decode, hash, dimensions, alpha detection,
sharpness, contrast, edge mean and a cheap colour signature. The set-level checks
compare those signatures (hue histogram, saturation, aspect) to ADVISE that two
images may be different products. Every such message is worded as a possibility
("may", "appears"), never as a segmentation verdict, and none of them blocks a
reference.

An in-place administrator crop is no longer supported either: `PATCH /:id` with
`crop` answers `422 CROP_NOT_SUPPORTED`, because a crop written back over a
reference can be re-cropped and re-cropped again. The supported ways to narrow a
reference are a composite panel (traceable to its parent sheet) or a re-upload.

---

## Storage

Reference media lives in its own **private** root, never in `frontend/public/uploads`
(which is world-readable) and never on the ImageKit CDN:

```
<root>/<workspace-slug>/<imageId>/original.<ext>     write once — a second write is refused
<root>/<workspace-slug>/<imageId>/cutout.png
<root>/<workspace-slug>/<imageId>/neutral.png
```

- Root: `REFERENCE_MEDIA_DIR` (default `backend/reference-media`), resolved to an
  absolute path **once at import time** by `services/privateMediaRoot.js` — never
  against `process.cwd()`. Production must point it inside the persistent disk
  (`/var/data/flora-alchemy/references`); a deploy onto an ephemeral filesystem
  keeps the rows and loses the bytes. `/api/health` reports
  `media.reference.{configured,insideAppTree,durable,writable}` and the API logs a
  warning at boot while the root is inside the app tree.
- The workspace segment comes from the **server session** (`req.workspaceSlug`), never
  from the request; `stripClientWorkspaceId` removes a client-supplied `workspaceId`
  before any controller runs.
- Bytes are served only by `GET /api/references/:id/file/:kind`, which re-checks
  identity, role, workspace and permission, answers `404` (not `403`) for another
  workspace's row so existence is not disclosed, and sends
  `Cache-Control: private, no-store`.
- No API payload exposes a `storageKey`, an absolute path, a workspace id or an author
  id — the smoke suite asserts this over every payload shape.
- Deleting a reference removes its directory; removing a product removes its references
  and their files; `POST /api/references/cleanup` (owner-only) sweeps drafts that were
  never attached.

**Two drivers, one contract.** `referenceAssetStorage.js` and `3dAssetStorage.js` keep
their four operations (`write`, `read`, `remove`, `exists` — plus `stat`/`byPrefix`),
and `services/privateObjectStorage.js` is the seam that selects the backend:

| `MEDIA_STORAGE_DRIVER` | Backend | Used for |
|---|---|---|
| unset / `fs` (default) | the private local root above | local development and every isolated test suite |
| `supabase` | a **private** Supabase Storage bucket over its documented REST API (a zero-dependency `fetch` driver) | production — survives deploys without a Render disk |

**Supabase setup (manual, once — a genuinely free tier with no payment method):**

1. Create a **free** Supabase project (supabase.com/pricing documents Free as $0/month;
   no card requirement is documented — confirm at signup);
2. **Storage → New Bucket** → a name like `flora-private`, and leave **Public bucket**
   switched OFF (private is the default);
3. **Project Settings → API Keys** → copy the **secret** key (`sb_secret_...` — the
   current format: a short string, NOT a JWT; it replaces the legacy `service_role`
   JWT, which Supabase says keeps working until deactivated) — a SERVER-ONLY
   credential: never in the frontend, never in Git, never pasted into chat;
4. set (Render secure environment / `backend/.env`):

```bash
MEDIA_STORAGE_DRIVER=supabase
SUPABASE_URL=https://<project-ref>.supabase.co   # the project's own URL
SUPABASE_STORAGE_BUCKET=flora-private            # the private bucket's name
SUPABASE_SECRET_KEY=                             # sb_secret_... — server-only key
```

- **Key header scheme is handled for you:** a new `sb_secret_...` key is sent in the
  `apikey` header ONLY — Supabase parses a Bearer copy as a JWT and rejects it with
  “Invalid JWT” — while a legacy JWT `service_role` key still gets both `apikey` and
  `Authorization: Bearer`. An `sb_publishable_` (public) key placed in
  `SUPABASE_SECRET_KEY` is refused as misconfiguration with an actionable diagnostic.
  Sources: supabase.com/docs/guides/getting-started/migrating-to-new-api-keys and
  …/getting-started/api-keys.

- Object keys are **server-derived** with the same `<workspace>/<imageId>/<kind>` shape
  as the filesystem layout; a client-supplied key is refused (`STORAGE_KEY_INVALID`)
  and traversal never escapes the namespace. The bucket stays **private** — the bytes
  are read back only through the existing authenticated routes (`/api/references/:id/
  file/:kind`, `/api/3d/media/...`) and the approved-model path; nothing is published,
  no presigned browser URLs, no CDN.
- **Bucket privacy is a RUNTIME invariant, not a test result.** Before every write the
  driver reads the bucket's own metadata (`GET /storage/v1/bucket/<id>`) and requires the
  response to name this exact bucket with `public: false` explicitly. A bucket that is
  PUBLIC, missing, unreachable, returns a malformed or foreign response, or times out
  makes the write fail closed (`STORAGE_BUCKET_PUBLIC` / `STORAGE_PRIVACY_UNVERIFIED`):
  no upload is attempted, nothing falls back to the local filesystem, and the bucket's
  visibility is never changed automatically. A confirmed-private result is cached for
  60 s (`BUCKET_PRIVACY_CACHE_TTL_MS`) so a burst of uploads pays one metadata GET;
  failures are never cached, and a cached result is reported as `cached: true` with its
  age so it can never be mistaken for a fresh check. `npm run 3d:readiness` performs a
  fresh check and prints `bucket privacy  private | PUBLIC | unverified`; `/api/health`
  and the boot log report it too (`writesBlocked`, `privacy`).
  **Limit, stated plainly:** the guard prevents *future* writes only. If an owner turns
  the bucket public, every object already in it is exposed until it is made private
  again — which is why the refusal says so and asks for a review of the bucket contents.
- Immutability, SHA-256, byte counts, MIME handling and the upload size caps are
  unchanged — they are enforced above the driver. Unapproved cutouts and candidate
  GLBs remain private exactly as before.
- **Production fails loudly rather than losing bytes:** with
  `NODE_ENV=production` and no usable object storage, private-media writes are refused
  with `STORAGE_NOT_DURABLE` (actionable message) instead of silently landing on the
  ephemeral Render filesystem. `GET /api/health` and `npm run 3d:readiness` report the
  driver, whether it is configured, and whether a bounded probe succeeded — never the
  credentials.
- **Crash consistency:** a write that lands in the bucket but dies before the MongoDB
  update is reconciled by the immutability rules — a retry of identical bytes is an
  idempotent success, and a retry with different bytes is refused, so neither a crash
  nor a re-run can fork an object's history.
- **Free tier (verified 2026-10-20 from Supabase's own docs):** **1 GB** file storage per
  organization, **5 GB uncached + 5 GB cached** egress per month, a **50 MB maximum file
  size**, two active free projects, and no published monthly Storage-operation quota.
  Idle free projects may be **paused after ~7 days of inactivity** (a warning email comes
  first; the dashboard's "Resume project" restores everything within a year). Sources:
  supabase.com/docs/guides/storage/uploads/file-limits ·
  …/platform/manage-your-usage/storage-size · …/platform/manage-your-usage/egress ·
  …/platform/free-project-pausing. GLB uploads are capped at **32 MiB** in code
  (`MAX_GLB_BYTES`, mirrored in worker.py) — comfortably under the 50 MB plan ceiling,
  and ~69× the largest real TripoSR artifact observed on the RTX 4050 (~485 KB).
  At 1 GB, budget roughly 2,000 models before the bucket needs pruning.
- **Migration honesty:** switching the driver never deletes or moves existing files.
  Production currently holds no reference images and no generated GLBs, so there is
  nothing to migrate today; if the filesystem driver is ever retired, copy the old root
  into the bucket with a separately reviewed, gated command first. `scripts/
  migrate-private-media.mjs` remains the fs→fs mover.

**Single-instance limitation (stated, not hidden):** with the `fs` driver the root is a
local directory, so a multi-instance deployment needs a shared volume — or, exactly as
described above, `MEDIA_STORAGE_DRIVER=supabase`. Nothing in the API assumes a particular
backend: the storage services above hide it completely.

**Failure reporting, not 500s.** A write now fails with a typed error instead of
collapsing into `INTERNAL_ERROR`. The code also appears in parentheses at the end of the
message, so a client that only surfaces `message` still shows something actionable:

| Code | `fs` errno | HTTP | Meaning |
|---|---|---|---|
| `STORAGE_NOT_WRITABLE` | EACCES/EPERM/EROFS | 503 | the directory exists but the process may not write it |
| `STORAGE_FULL` | ENOSPC/EDQUOT | 503 | the volume is out of space |
| `STORAGE_MISSING` | ENOENT | 503 | the configured root does not exist and could not be created |
| `STORAGE_EXHAUSTED` | EMFILE/ENFILE | 503 | too many open files |
| `STORAGE_UNAVAILABLE` | EIO / anything else | 503 | the volume is failing |
| `ORIGINAL_IMMUTABLE` | — | 409 | a second write to an existing original slot |
| `ORIGINAL_MISSING` | — | 409 | the row exists but its stored bytes do not (processing) |

Every storage failure says the same thing about the upload itself: *it was not stored,
nothing was kept, so retrying is safe* — an upload that half-succeeded and left a
reference row pointing at nothing would be worse than the error.

A read of a missing file answers `{ available: false, missing: true }` for the asset
instead of a 500, so the studio shows “file missing” rather than “server broken”.

**Moving the root is a migration.** `scripts/migrate-private-media.mjs`:

```bash
# dry run (default): inventory + plan only, writes nothing
node scripts/migrate-private-media.mjs --kind=reference --from=<old> --to=<new>
# copy, then re-hash both sides and write a manifest
node scripts/migrate-private-media.mjs --kind=reference --from=<old> --to=<new> --apply
```

It refuses to overwrite an existing destination file, verifies every copy by size and
SHA-256, and is safe to re-run (already-copied files are skipped). Reads keep using the
old root until you change the env var — the tool never edits configuration for you.

---

## Setup

### Required

The built-in engine is ready once backend dependencies are installed — no service to run,
no model to download, no Python. `npm run install:all`, then `npm run api:dev`.

**New dependency: `sharp` `^0.35.5`** (Apache-2.0, with platform-specific prebuilt
`libvips` binaries) — the only package this phase adds, and it was not previously a
backend dependency. It is what decodes every original and panel, encodes the panel
crops, and reads image metadata honestly (format and dimensions come from the decoded
container). The stack has no other image codec, so this
is a need rather than a preference; it needs Node `^18.17 || ^20.3 || >=21` (the
project requires Node ≥18) and installs as ordinary prebuilt binaries on Render.

### The ML engine was removed with the cutout feature

This section previously described installing `rembg` (Python ≥ 3.11, < 3.14, a ~176 MB
model download, the `BGREMOVE_*` variables and a model-licence table). All of it is
gone: the reference workflow no longer segments anything, so there is no engine to
install, no model licence to clear and no `BGREMOVE_*` variable to set.

`sharp` remains a dependency, because it is what decodes, hashes and measures every
original.

---

## API

All routes are staff-only (`protect` → `adminOrHandler` → workspace gate → product
permission), except `/cleanup`, which additionally requires the platform owner. Mount:
`/api/references`.

| Method & path | Notes |
|---|---|
| `GET /options` | the reference vocabulary the studio renders: supported formats, size limit, panel budget, viewpoint labels. Replaces the old `/engine`, which described a background-removal engine that no longer exists |
| `GET /` | `?productSlug=` or `?draftKey=` (exactly one) or `?ids=a,b`; returns `{ images, setWarnings, setNotes }` |
| `POST /` | multipart: `image` (≤ 5 MB, JPEG/PNG/WebP/GIF/AVIF) + `productSlug` \| `draftKey` + optional `label`. `uploadLimiter` applies here only |
| `GET /:id` | one image (404 across workspaces) |
| `GET /:id/file/:kind` | `original` bytes, private/no-store. A legacy `cutout`/`neutral` row stays readable for old data, but nothing new is ever written |
| `PATCH /:id` | `label`, `viewAngle`, `isPrimary`, `accepted`, `composite: false`. `crop` is refused (`422 CROP_NOT_SUPPORTED`) |
| `POST /:id/reprocess` | retry the measurement; the original is re-read, never rewritten |
| `PATCH /order` | `{ ids: [...] }` — the whole ordered list; a stale list is refused rather than half-applied |
| `POST /attach` | `{ productSlug, productId?, ids?, draftKey? }` — hands a draft's accepted set to a saved product, bringing each view's source sheet along as un-accepted provenance. Returns `{ attached, sourceSheets }`. |
| `DELETE /:id` | removes the row and its files |
| `POST /cleanup` | owner-only; deletes never-attached references older than `olderThanHours` (1–720) |

Upload position in the gate order matters and is asserted: a non-member never reaches
`multer`, so an unauthorised upload writes no bytes.

### Validation

Facts are enforced; heuristics only warn. There is no segmentation verdict any more —
no "product edges could not be isolated", no "background not uniform", no "graphic or
promotional artwork detected", no cutout confidence. Those were messages from the
removed engine, and the engine is gone.

- **Enforced:** real decodable image (format read from the decoded container, never the
  MIME claim), allowed format, ≤ 5 MB, ≤ 48 MP, long edge ≤ 12 000 px, non-empty,
  readable dimensions. Failures are `422` with a specific code (`UNREADABLE_IMAGE`,
  `UNSUPPORTED_FORMAT`, `IMAGE_TOO_LARGE`, `EMPTY_FILE`).
- **Warned (wording is deliberately hedged):** a low long edge ("…a long edge of at
  least N px gives a usable 3D reference"), "This image appears too blurry for reliable
  3D reconstruction.", "This image has very low contrast, so shape and material detail
  may be hard to read.", "This looks like the same file as reference N — it will not
  add a new angle.", and the set-level advice "These views look quite different in
  colour — check that every reference is the same piece…" / "These images look like
  the same view — add a side or back view for better 3D reconstruction."
- **Noted, not warned:** "This PNG has no transparency — it will be treated like a
  photograph.", and, for a lone reference, "A single reference works, but a second view
  (side or back) materially improves 3D reconstruction."

### Outputs

There is exactly one output per reference: the ORIGINAL, written once and never
overwritten. A composite additionally produces one PANEL original per detected view —
the crop at full resolution, as PNG, traceable to its sheet through `source.parentId`,
`source.panelIndex`, `source.grid` and `source.box`.

There is no cutout and no neutral preview, so nothing is composited over `#F5F2ED` and
there is no derived asset to compare downstream. A panel crop trims SEPARATOR pixels
only; the product is never segmented out of any image.

---

## Review UI

`components/admin/ReferenceImageStudio.jsx` (mounted from
`AdminCreateProductPage.jsx` and `AdminProductDetailPage.jsx`):

- drag-and-drop **and** a multi-select file picker; per-file upload progress (the only
  XHR-backed transport, `postForm`), queue with retry;
- thumbnails with remove, replace, reorder (drag, persisted through `PATCH /order`) and
  **primary reference** (promoting is server-side and cannot leave a set with none);
- the ORIGINAL thumbnail with its dimensions and the file's SHA-256. There is no
  ORIGINAL/CUTOUT comparison any more, and no transparency checkerboard unless the
  source image genuinely has alpha;
- the per-image status pill (`UPLOADING` → `PROCESSING` → `READY` / `NEEDS_REVIEW` /
  `FAILED`), warnings and notes, and retry-processing;
- for a composite, the **grid workspace**: the server's proposed layout drawn over the
  untouched sheet with numbered panel boxes, editable columns / rows / border trim that
  re-ask the server for a preview and write nothing, and an explicit **Create N views**
  button — a detected grid is never cut behind the administrator's back. A low-
  confidence proposal opens the workspace instead of cutting;
- source sheets are labelled `Source sheet · N views` and carry "Kept for audit — not
  a view" in place of an **Accept** button, so provenance can never be mistaken for a
  viewpoint;
- an explicit **Accept** step; accepting is what a product save will carry forward, and
  unaccepted drafts are cleaned up rather than lingering;
- responsive layout on the existing tokens; the review screen fetches each asset with
  the admin bearer token and turns it into a blob URL (an `<img src>` cannot send a
  token, which is why the service — not a component — owns that fetch).

---

# Phase 2 — Generate a model

Phase 2 turns an **accepted** reference set into a generated GLB, puts it in front of an
administrator, and only makes it a product's model when a person approves it.

## The rules this phase is built around

1. **Generation is OFF by default, and the default is honest.** No local 3D engine is
   compiled into this build, and the hosted adapter costs money per call. So a fresh
   deployment reports `available: false` with a reason that names what is missing, and
   the studio shows that reason instead of a button that pretends to work.
2. **The hosted adapter is opt-in, never a fallback.** It is reachable only when BOTH
   `THREE_D_PROVIDER=meshy` and `MESHY_API_KEY` are set. `MESHY_API_KEY` alone does nothing;
   `THREE_D_PROVIDER=meshy` without a key is a refusal. A local failure is **never** followed
   by a silent paid retry.
3. **Nothing is previewable or approvable unless it was really generated.** Preview and
   approval both gate on the same predicate — a stored, header-validated GLB. A row
   without those bytes is not a model, and no screen will draw a placeholder in its place.
4. **A replacement can never destroy the live model.** Approving a new candidate
   *deprecates* the previous one (row and files kept), and a failed or rejected
   replacement changes nothing at all.
5. **Credentials stay server-side.** The key is read from the process environment in
   `services/3dModelProvider.js` and is never returned by an endpoint, logged, or
   shipped to the browser.

## The pipeline

```
accepted reference images (Phase 1)
        │  read from the PRIVATE reference root — the ORIGINAL of each accepted view
        ▼
GenerationJob  QUEUED → GENERATING → POST_PROCESSING → READY_FOR_REVIEW
        │                                             ↘ FAILED / CANCELLED
        │  provider.submit() · poll() · download()
        ▼
GLB bytes ── validateGlb() ──► invalid: job FAILED with the reason, nothing written
        │      valid
        ▼
Product3DAsset  CANDIDATE (private files written under THREE_MEDIA_ROOT)
        │  a human looks at it
        ├── approve ─► APPROVED   (previous approved asset → DEPRECATED, files kept)
        └── reject  ─► REJECTED   (the approved model is untouched)
```

`READY_FOR_REVIEW` is deliberately **not** "done": a generated mesh is a candidate that
a person has to accept. That is what makes "only a genuinely generated, validated asset
may be previewed or approved" an enforced property rather than a promise.

## Where the code lives

| Concern | Module |
|---|---|
| Job life cycle, tenancy-scoped reads | `models/GenerationJob.js` |
| Asset life cycle + the one-approved invariant | `models/Product3DAsset.js` |
| Provider policy, local/hosted adapters | `services/3dModelProvider.js` |
| Orchestration (job → provider → candidate) | `services/3dGenerationService.js` |
| Asset operations (approve / reject / purge) | `services/3dAssetService.js` |
| GLB container validation | `services/3dModelValidation.js` |
| The private GLB media root | `services/3dAssetStorage.js` |
| HTTP surface (`/api/3d`) | `routes/3dModelRoutes.js` + the three `3d*Controller.js` |
| Interactive preview | `components/admin/ThreeGlbPreview.jsx` |
| Studio screen | `components/admin/GenerationJobsForProduct.jsx` |

`services/3dModelProvider.js` follows the `services/bgRemoval/index.js` pattern from
Phase 1: **one entry point, engines behind it, and what actually ran recorded on the
result**. The registry is frozen to the real providers; the test double is registered
only by the test harness (see Testing) and is asserted not to be referenced from any
controller, route or service.

## Validation — what "validated" actually means

`validateGlb()` inspects the **bytes**, never a filename, a content-type or a provider's
word for it. In order: it is ≥ 12 bytes; the magic is `glTF`; the container version is 2;
the declared total length equals the real byte length (this is the check that catches a
redirect page or an error body saved as a model); the first chunk is JSON and parses; and
the glTF declares **at least one mesh** — a valid but empty scene is not a model, and
approving one would put an invisible product in front of a customer. Failures are
recorded on the job and the asset rather than thrown away, so the studio shows a reason.

## Storage and serving

Generated media lives under `THREE_MEDIA_ROOT` (default `<backend>/uploads/3d-media` —
anchored to the backend directory; it previously resolved against the process CWD and
produced `backend/backend/uploads/3d-media`), never in a served public folder and never
on the CDN, and the same rules as Phase 1 hold:
a storage key is relative to the root, every read resolves it back inside the root and
refuses traversal, and a second write to a slot is refused (`ASSET_IMMUTABLE`).

**The only reader is `GET /api/3d/media/:productSlug/:assetId/:kind`**, which re-derives
the workspace from the session and answers `private, no-store`. The staff projection
(`publicAssetProjection`) deliberately omits the storage key — screens address media by
URL shape, not by path — and the reference plan returned by the studio endpoint is
projected down for the same reason, so no payload carries a private path.

## Setup

There is nothing to install for the default (disabled) state.

**Hosted adapter (metered, opt-in):**

1. get a Meshy API key;
2. set `THREE_D_PROVIDER=meshy` **and** `MESHY_API_KEY` in `backend/.env` — the server's own
   environment, never a frontend variable;
3. restart the API and check `GET /api/3d/provider` as a staff member: it should report
   `available: true` and pass its own health probe. The studio then shows
   "Meshy 7.1 (hosted, metered)" and warns that each generation bills the account.

**Local provider (preferred, no recurring cost):** run a real engine (TRELLIS.2, TripoSR,
or your own) on a Linux + NVIDIA host, give it the `submit / status / download / cancel`
interface documented at the top of `services/3dModelProvider.js`, and point `THREE_D_PROVIDER`
at that worker. The reason the default build reports is written for exactly this reader.

**The production shape on this project** is `THREE_D_PROVIDER=local_gpu_agent`: TripoSR runs
on the owner's Windows PC (`tools/3d-worker/agent.py`) and drives itself over the
deployed API — see [Remote GPU agent](#remote-gpu-agent-the-production-shape) below.

### The variable name (renamed 2026-10-21)

The provider flag is **`THREE_D_PROVIDER`**. It was originally `3D_PROVIDER`, but
Render (in common with POSIX shells) rejects an environment name that begins with a
digit, so the deployed service could never be configured with it — the fix belongs in
code, not in the dashboard. The old spelling is still read as a **deprecated alias**
for existing local setups, and `THREE_D_PROVIDER` always wins when both are present;
the server logs a deprecation warning when the alias is what configured it, and a
second warning when the value is not a recognized provider. No deployment value may
rely on the old name.

## Remote GPU agent (the production shape)

Render cannot dial `127.0.0.1`, and a developer machine must not expose a worker port
to the internet. So the direction is reversed: **the PC dials the deployed backend over
outbound HTTPS** and the backend never connects to the PC.

```
staff clicks Generate ──► GenerationJob (QUEUED, provider=local_gpu_agent)  [MongoDB is authoritative]
                              ▲                                               │
agent.py on the PC ───────────┴── claim ── heartbeat ── input ── TripoSR/CUDA ── result (GLB)
   (outbound HTTPS only, authenticated with the machine token + a per-job lease)
```

The lifecycle is unchanged from Phase 2: accepted references → queued job → claimed by
the agent → real inference → the GLB is validated **from the bytes** → a candidate asset
is persisted and measured by the quality gate → a human reviews → explicit approval →
storefront delivery. Inference success never publishes a model.

### Protocol (all at `/api/3d/agent`, machine-token only)

| Step | Route | Guarantee |
|---|---|---|
| Poll for work | `POST /jobs/claim` (bounded long-poll ≤20 s) | Atomic claim, provider-scoped: an agent only ever takes `local_gpu_agent` jobs. A job whose lease expired (crashed PC) is re-claimable. |
| Read inputs | `GET /jobs/:id/input` | Only the **claimed** job's accepted references, re-read from the job's own `source.referenceIds`, filtered to `accepted: true`, capped by a transfer budget (413). There is no browse/list route. |
| Heartbeat | `POST /heartbeat` | Renews the lease and answers `continue` / `abort` (cancelled) / `lost` — cancellation reaches an agent minutes into an inference. |
| Upload result | `POST /jobs/:id/result` | Bounded body (413 over the cap), empty body refused (422), GLB validated from the bytes (422), idempotent: a retried upload of the same result is a `duplicate`, never a second candidate. |
| Report failure / release | `POST /jobs/:id/failure`, `POST /jobs/:id/release` | Bounded, sanitized, lease-guarded. Release returns the job to the queue with no penalty (agent shutdown, model failed to load). |

**Security model.** Two secrets, distinct from customer and admin JWTs:

- `THREE_WORKER_AGENT_TOKEN` — one long machine secret shared by this PC and the
  backend. Compared in constant time, required on every agent route (401 without it),
  refused under `NODE_ENV=production` without HTTPS, rate-limited, **never logged and
  never present in any HTTP payload** (the smoke suite asserts that over the studio
  response). A configured token does **not** mean the PC is online.
- A per-job **lease token** minted at claim time. It binds every input read, heartbeat
  and result write to the one job that machine actually holds; a second agent presenting
  a wrong lease gets 409. It is stripped from every staff serializer — the studio shows
  *which machine* holds the lease and since when, never the token.

Tenancy follows the usual rule: the job's workspace comes from the job document (never
from anything the agent sends), and the agent sees no workspace identifiers, no customer
data and no admin surface.

### Backend setup (Render dashboard, secure environment)

```bash
THREE_D_PROVIDER=local_gpu_agent
THREE_WORKER_AGENT_TOKEN=<long random secret — same value on the PC>
THREE_WORKER_AGENT_URL=https://flora-alchemy.onrender.com/api   # display/diagnostics only
# optional timing (defaults shown)
# THREE_AGENT_LEASE_MS=120000            # job survives this long without a heartbeat
# THREE_AGENT_HEARTBEAT_TIMEOUT_MS=60000 # heartbeat older than this = machine offline
# RATE_LIMIT_AGENT_MAX=600               # agent requests per 15 min, per IP
```

Generate the token (32 random bytes):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### PC setup (Windows + NVIDIA)

```powershell
# one-time: Python 3.11+, a CUDA build of PyTorch, and the TripoSR checkout.
# An existing TripoSR environment (e.g. the ~/flora-3d venv used for Phase 4) works as-is.
py -3.11 -m venv .venv3d
.venv3d\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cu124   # match your driver
pip install -r <TripoSR checkout>/requirements.txt trimesh

# the agent's environment (never commit these; never print them)
set THREE_WORKER_AGENT_URL=https://flora-alchemy.onrender.com/api
set THREE_WORKER_AGENT_TOKEN=<same secret as the backend>

# credential-free readiness report: CUDA availability, GPU name, model checkout,
# backend reachability. It prints the TOKEN NEVER — it only says set/unset.
python tools\3d-worker\agent.py --diagnose

# normal operation (one inference at a time — this GPU has limited VRAM)
python tools\3d-worker\agent.py --triposr-home <path-to-TripoSR> --device cuda:0

# one-shot smoke: handle exactly one job, then exit
python tools\3d-worker\agent.py --once
```

### Verification checklist (do these once, in order)

1. `python agent.py --diagnose` reports CUDA available, the GPU name, and
   `backend: reachable, heartbeat accepted`.
2. Start the agent, then open the 3D Model Studio: the agent chip shows **online** with
   its worker id and a fresh `lastSeenAt`. (Or run `npm run 3d:readiness` — the
   “GPU agent” row reports `THREE_D_PROVIDER`, whether the token is set, and the last
   heartbeat age. It deliberately reports *configured* and *online* as different facts.)
3. Prepare at least one accepted reference image on a product, click **Generate**, and
   watch the job move `QUEUED → GENERATING` (claimed by your worker id) →
   `POST_PROCESSING → READY_FOR_REVIEW`.
4. Review the candidate and **approve** it (the quality gate may answer REVIEW/BLOCKED —
   that is the gate working; an administrator override needs a recorded reason).
5. Verify the GLB is served on the storefront (`3D View` on the product page).
6. **Shut the PC down** and reload the product page: the approved model must still load.
   That works only when `MEDIA_STORAGE_DRIVER=supabase` is configured — this is the test
   that the bytes are in the bucket, not on the Render disk.

### Operating notes

- **Offline behaviour is honest.** No heartbeat for `THREE_AGENT_HEARTBEAT_TIMEOUT_MS`
  ⇒ the studio reports the machine offline; jobs stay `QUEUED` and recoverable; the
  Generate button explains that work will queue until the PC returns (the backend never
  marks the provider “available” just because a token exists, and there is no paid
  fallback — ever).
- **One job at a time.** The agent runs a single inference loop (VRAM), heartbeats while
  working, and releases the lease cleanly on `Ctrl+C` so the job returns to the queue
  instead of waiting for lease expiry.
- **Rotation:** change `THREE_WORKER_AGENT_TOKEN` on both sides and restart both. The
  agent fails fast with an explicit “token rejected” message and never echoes the value.
- **Failures are visible:** a refused upload, a validation failure or a crash leaves a
  truthful terminal job state with a bounded reason a human can read; an interrupted
  inference strands nothing (the lease expires and the job is re-claimable).

### What this does NOT prove

Ordinary CI runs on mocks: a fake agent against the real endpoints (auth, claim, lease,
input, result, cancel, idempotency) and a local Storage-REST-emulating HTTP server for
the object driver (`npm run test:supabase-storage`, 72/0) — the SAME wire shapes the
documented Supabase API uses, but not a Supabase server. Live round trips DO run against
the owner's real free project (`npm run test:supabase-real`; **2026-10-21: 8/8**, exit 0 —
connect → bucket exists and is private → unique key absent → write → byte-identical
read-back → `exists`/`stat` metadata → prefix listing → delete → post-delete absence,
with cleanup in `finally`). They caught three live-only wire details — a missing object
answers `400 NoSuchKey`, the MIME arrives as snake_case `content_type` (top-level, not
under `metadata`), and `last_modified` is the field a stat can rely on — which the driver
and the mock now both encode.

**The visibility check is part of the eight, not a footnote.** The first live run on
2026-10-20 reported 7/8 because the bucket probe answered
`{"ok":true,"public":true}` — a **PUBLIC** bucket makes every byte this driver writes
readable by anyone who can guess a key, which contradicts the private-media rule above.
The owner turned **Public bucket** off in the Supabase dashboard and the same command then
reported 8/8. Do not “fix” a public bucket by treating it as acceptable in code: the
check must keep failing until the bucket itself is private.

What has NOT run yet: a real GPU generation, and a storage write through the deployed
Render service (the Render environment receives its own `SUPABASE_*` values; nothing in
the repository carries them).

## The admin experience

The **3D Model Studio** panel sits on the product page (below the prepared images) and
contains: the provider decision (with the server's own explanation when generation is
off), a reference picker limited to **accepted** references, a quality selector, a free-text
note, the generate button, a live job list (status, provider progress when the provider
reports one, cancel, retry), an approve/reject decision for the candidate awaiting review,
and the full version history with which version is live.

The interactive preview is a real three.js viewport: **drag to rotate, scroll/pinch to
zoom, pan, and a Reset view button**, with loading, error and empty states. It is
lazy-loaded — `three` plus the GLTF loader and OrbitControls are pulled in with dynamic
`import()` inside the mount effect, so they land in their own chunks (~705 KB + ~46 KB +
~19 KB) and the portal's initial bundle stays **clean of three.js** (verified against the
production build). It renders the candidate under review when there is one and the
approved model otherwise, and the page keeps exactly **one** live WebGL context — the
studio panel reports which asset should be on screen rather than creating a second one.

Because GLB bytes are private, the viewer takes an async **loader**, not a URL: the bytes
are fetched with the admin bearer token by `services/threeGlbService.js` and handed over as
an object URL, which the viewer revokes on unmount. An `<img src>`/`GLTFLoader` request
cannot carry a token, which is why that fetch lives in the service and no component
performs it.

## API

All routes are staff-only: `protect` → `adminOrHandler` → `requireWorkspace` →
`requirePermission` (`products.view` to read, `products.update` to change). There is
**no public route** — a generated model belongs to the workspace that made it until a
later phase defines how a customer may see an approved one. A workspace mismatch is a
**404**, never a 403.

| Method & path | Purpose |
|---|---|
| `GET /api/3d/provider` | Is generation possible, and with what? Never costs anything. |
| `GET /api/3d/products/:slug/studio` | The whole screen in one request: provider, plan, jobs, assets, approved. |
| `GET /api/3d/products/:slug/jobs` | Job history. |
| `POST /api/3d/products/:slug/jobs` | Start a generation (write-limited). |
| `GET /api/3d/jobs/:jobId` | One job. |
| `POST /api/3d/jobs/:jobId/retry` | Re-queue a failed/cancelled job. |
| `POST /api/3d/jobs/:jobId/cancel` | Cancel, and stop the provider task. |
| `POST /api/3d/jobs/:jobId/approve` | Approve the job's candidate (`assetId` optional when unambiguous). |
| `POST /api/3d/jobs/:jobId/reject` | Reject the candidate; keeps any live model. |
| `GET /api/3d/products/:slug/assets` | Every version + which one is approved. |
| `GET /api/3d/products/:slug/assets/current` | The single approved model, or `null`. |
| `GET /api/3d/assets/:assetId` | One asset (projection). |
| `DELETE /api/3d/assets/:assetId` | Remove a non-approved candidate and its files. |
| `GET /api/3d/media/:slug/:assetId/:kind` | `model` \| `thumbnail` — the private bytes. |

## Testing — and exactly what is NOT proven

`backend/scripts/3d-studio-smoke.mjs` — `npm run test:3d`, **143 assertions**, its own
server (port 4127), its own `Flora-Alchemy-Test-3DStudio` database and its own private
media roots under the OS temp directory, both removed on the way out.

> **No AI inference is run by this suite, and it does not claim to be.** The provider
> *implementation* is replaced with an explicit test double (`registerTestProvider`, which
> exists for this purpose and is asserted to be referenced from no controller, route or
> service). **Every other stage is real**: real accepted reference rows and real files on
> disk, a real job row, a real claim, the real worker/poll loop, the real GLB container
> validation, the real private storage write, a real candidate, the real approval and
> deprecation rules, the real tenancy scoping and the real HTTP routes and gates. The
> bytes the double returns are a genuine glTF Binary container the suite builds byte by
> byte (correct magic/version/lengths, JSON chunk with meshes, BIN chunk with three real
> vertices), so what gets validated and stored is a real GLB.
>
> The suite registers its double under the `meshy` name so the **real opt-in path** is
> what gets exercised, with a literal placeholder key and the transport replaced — no
> network call can occur. **Should this suite ever reach api.meshy.ai, that is a defect in
> the suite**: on its first run it did exactly that, because the suite left its opt-in env
> vars set and `bootTestServer` inherits `process.env`. It now restores them and forces
> them empty in the child, and asserts that it did.

Sections: **§A** provider policy (off by default, both-variables opt-in, no key in any
payload, no fake in the shipped registry, no fake referenced from application code);
**§B** validation (accept, plus every rejection reason, and never throwing on hostile
input); **§C** private storage (relative keys, immutability, traversal refusal, scoped
removal); **§D** a real end-to-end run; **§E** a failed replacement keeping the live
model; **§F** a rejected replacement keeping the live model; **§G** approval and archive
guards (no bytes → not approvable, approved → not deletable, replacement archives and
keeps files); **§H** tenancy (every cross-workspace read is a 404); **§I** the HTTP
surface against a **separate server running the shipped default configuration**, which
must refuse to generate — with a sentinel credential present in that server's environment
and searched for in every response body.

The suite drops its own database and its own media roots on the way out, and
`node scripts/db-footprint.mjs --drop-leftovers` reclaims the database if a run is killed.
**No frontend unit test exists in this project**, so the
viewer's behaviour is covered by `npm run build` (which is also the check that three.js
stays out of the entry chunk) plus the browser suite; nothing here claims automated
frontend coverage of the WebGL path.

## Known limitations — Phase 2

1. **The local provider is a slot, not an implementation.** No local engine ships, so on
   a default deployment generation is genuinely unavailable. This is reported, not faked,
   and the reason string tells an operator what to run.
2. **In-process background worker.** The run is fire-and-forget inside the API process, so
   a restart mid-generation leaves the job to be retried rather than completed (its claim
   expires and a non-final job is retryable). A durable queue is the right production
   answer and is not pretended away here.
3. **Polling, not webhooks.** The worker polls the provider every 5 s for up to 20 minutes.
   A webhook receiver would remove that ceiling for a long job.
4. **No thumbnails from the provider path.** The storage layer supports and serves a
   thumbnail, but the hosted adapter only returns the GLB, so a candidate previews the
   GLB itself and the empty/error states fall back to the product's photograph.
5. **Single approved model per product.** Enforced by a partial unique index plus the
   deprecation rule; there is no side-by-side "compare versions" view.
6. **No customer-facing surface.** Nothing in *Phase 2* renders a generated model on the
   storefront; the approved asset is reachable only as staff. **Phase 3 changed this** —
   see *Phase 3 — the customer-facing 3D experience* below.

---

# Phase 3 — the customer-facing 3D experience

Phase 3 connects an **approved** model to the storefront product page, without exposing
anything an administrator has not signed off on. It does not touch Phase 1 or Phase 2's
pipeline: approval, deprecation and versioning behave exactly as documented above, and
the customer surface only *reads* the resulting state.

## What a customer may see — and what they may never see

`services/product3dPublicResolution.js` is the only place the storefront learns that a
product has a 3D model. It returns a fixed, narrow projection:

```json
{
  "id": "<assetId>", "version": 3, "provider": "E2E Fixture Model", "hasModel": true,
  "bytes": 684, "thumbnail": "/api/3d/products/<slug>/model/<assetId>/thumbnail",
  "delivery": { "glb": "/api/3d/products/<slug>/model/<assetId>/glb" },
  "validation": { "ok": true, "gltfVersion": 2, "meshes": 1, "materials": 1, "textures": 0 },
  "settings": { "quality": "standard" }
}
```

Never present, in any state of the product: a candidate, a rejected asset, a deprecated
(replaced) asset, a generation job, a source reference image, a provider task id, the
internal `_id`/`_v`, a storage key, a filesystem path, a workspace id, an administrator
identity, the approval trail, or the file hash. The key set is **asserted** in the suite,
so a future field cannot be added to the projection without that assertion failing.

The model is resolved **per product**, from the product's own `workspaceId` — not from
the caller's identity (a visitor has none). That is what stops a second workspace's
approved row naming the same slug from ever being the model a customer is shown.

## Serving the model

`GET /api/3d/products/:slug/model/:assetId/glb` (and `/thumbnail`) is deliberately **not**
a public directory: the private media root stays private, and the route names only
`(productSlug, assetId, kind)`. On every single request the controller:

1. re-resolves the product and refuses an unknown / `Hidden` product or one whose shop is
   not `ACTIVE` (404) — an unpublished product loses its model immediately, cached client
   or not;
2. re-resolves the asset by `_id` **and** product slug **and** the product's workspace, and
   requires `APPROVED`;
3. reads the file and **re-validates the bytes** as a glTF Binary container, so a row whose
   file was truncated, replaced or corrupted is refused instead of handed to a browser as
   a "model";
4. answers with the right type (`model/gltf-binary` / `image/png`), `nosniff`, an exact
   `Content-Length`, `Accept-Ranges: none`, and `Cache-Control: public, max-age=600,
   must-revalidate`.

Every refusal is the same `404 ASSET_NOT_FOUND`: existence is never disclosed, and a
mismatch is never a 403 (a 403 would confirm something is there). A missing **thumbnail**
is also a 404 by design — it is a derived poster frame, never a reason to refuse the
model.

## Caching and invalidation

The two caches involved answer different questions, so they are invalidated differently:

| What | Where | Lifetime | Invalidated by |
|---|---|---|---|
| The `product3d` metadata projection | `utils/publicCache.js` (`3d:model:<slug>`) | 30 s, like every other public read | **Explicitly**, on approve / reject / delete and on any product create/update/delete, which covers renaming, unpublishing (`visibility: Hidden`) and moving a product off an active shop. A miss (no model) is never cached, so publishing the *first* model is visible immediately. |
| The GLB / thumbnail bytes | The browser (and any intermediary) | `max-age=600`, then revalidation | The URL carries the **asset id**, so a replacement is a different URL — and after 10 minutes the browser revalidates against a route that re-checks visibility, so an unpublish cannot keep a model alive beyond that window. Express' ETag makes the revalidation a 304. |

The 30-second metadata window is the same staleness every other public read accepts, and
it is **bounded**, not "eventually": the suite polls a replacement through the running
server and asserts it converges.

## The viewer: loading, fallback and lifetime

The gallery is extended, not replaced. Photographs remain the default view, and a
**3D View** toggle appears only when the projection says an approved model exists (no
model → no button, not a disabled one).

- **Three.js never reaches the entry bundle.** The storefront viewer
  (`components/Product3dViewer.jsx`) is a `React.lazy` chunk, and it reuses Phase 2's
  viewport (`components/admin/ThreeGlbPreview.jsx`) rather than re-implementing orbit
  controls, GPU disposal and state handling — that component pulls `three`,
  `GLTFLoader` and `OrbitControls` in with dynamic `import()` of its own. The emitted
  `index.html` entry chunk is asserted in the browser suite to contain no three.js code,
  and the existence of the `three.module` chunk is asserted alongside it so the check
  cannot pass vacuously.
- **The GLB downloads only when the customer asks.** Opening a product page fetches a few
  hundred bytes of metadata; the browser suite asserts that **no** `/model/…/glb` request
  happens before the 3D tab is clicked.
- **Fallbacks are real.** A model that has become unavailable (404) and a browser whose
  WebGL context cannot be created both land in the viewer's error state, with a
  *Back to photos* control that is rendered **outside** the viewport's state machine — so
  the escape exists even when nothing rendered.
- **Lifetime is explicit.** The object URL created for the GLB is revoked on unmount and
  on reload (a leaked object URL is tens of megabytes), the renderer disposes geometries,
  materials and textures, and the canvas is removed from the DOM.
- **Nothing animates on its own** (no idle rotation), so reduced-motion preferences are
  honoured without a separate code path; the model moves only when the customer drags it.
  The canvas sets `touch-action: none` **inside its own box only**, so page scrolling,
  variant selection and Add to Bag keep working — the 390×844 layout is asserted to have
  no horizontal overflow and a reachable exit.

## Testing — and what is a fixture

`backend/scripts/3d-studio-smoke.mjs` §J (`npm run test:3d`, 188 assertions total) covers
the public contract against a **separate server process**: the projection's exact key set,
it serving an anonymous visitor, a customer and a staff session (and refusing a handler
without `products.view`, exactly as the catalogue read does), the byte-level GLB response,
404 for candidate / rejected / deprecated / unknown / foreign-workspace assets, an
**intruder row that is genuinely servable in its own workspace but must never be shown
under this product**, a real replacement through the pipeline (unapproved candidates
invisible → approval invalidates the cache → the old model 404s → the storefront
converges), and unpublish/republish through the real `PATCH` write path.

`frontend/e2e/specs/12-product-3d.spec.js` (`npm run test:e2e`) drives the **real browser
against the real stack**: photographs are the default, the lazy chunk loads, the visitor's
GLB is fetched from the public path, `data-state="ready"` proves three.js **parsed and
drew** the bytes, *Back to photos* restores the gallery, Add to Bag still works, a product
without a model shows no 3D control at all, three.js is absent from the entry bundle, a
404 model and a no-WebGL browser both fall back cleanly, and the phone-sized layout has no
overflow.

**The model those tests use is a FIXTURE, and this is the honest statement about it:**
`e2e/stack.mjs` writes an `APPROVED` asset row plus a real glTF Binary container built
byte-by-byte in `e2e/support/fixtures.js` (`makeGlb`, one triangle, validated by the
server's own `validateGlb`). **No AI inference runs anywhere in Phase 3's tests** — a
generated product model needs a GPU host, and no hosted call is ever made (the backend
suite substitutes the provider with an explicit test double and says so). So these tests
prove the entire *customer* path against real bytes; they do **not** prove that any
provider produces a good mesh.

## Deployment / configuration

- Nothing new is required to serve an approved model: `THREE_MEDIA_ROOT` (or the default
  under `UPLOAD_DIR`) is the same private root Phase 2 writes to, and it must be readable
  by the API process. **It must never be published as a static directory** — the bytes are
  served only through the authenticated media route and the approved public route.
- A multi-instance deployment needs that root on a shared volume (same limitation as
  Phase 1 and Phase 2).
- The storefront's 3D metadata read is public and cheap; it is not rate-limited separately
  from the rest of the public catalogue, and no CDN configuration is required for it.

## Known limitations — Phase 3

1. **The delivery route is not a CDN.** `max-age=600` is a bounded, boring cache; putting
   an actual CDN in front of it would be a deployment decision (the URL is already
   content-addressed by asset id, so it would be safe).
2. **One approved model per product** (inherited) — no customer-facing side-by-side
   version comparison.
3. **The fixture caveat above.** Automated coverage of the customer path uses a generated-
   by-construction GLB, not a provider-produced mesh; a real approved product model has
   been exercised only through the same routes.
4. **A product with no model shows nothing at all** — no teaser, no "coming soon". That is
   deliberate, and it means an administrator has to approve a model before the storefront
   can advertise one.
5. **The 30 s metadata window** is a real (if small) staleness: a customer who loaded the
   page just before an approval may see the previous model's button until a reload. The
   *bytes* they get are always the live approved ones, and an unpublish is effective
   immediately for new deliveries.

---

## Phase 1 → Phase 2 handoff (what Phase 2 consumes)

Attaching a draft set to a saved product migrates the rows to that product
(`productId` + `productSlug`), so Phase 2 never needs a re-upload. Each row carries:

`original` asset metadata (dimensions, format, alpha, bytes, sha256),
`processing.engine` / `metrics` / `durationMs`, `validation` (sharpness, contrast, edge
mean, signature), `warnings`, `confidence`, `order`, `isPrimary`, `accepted`, `status`,
`source` (`type`, `parentId`, `panelIndex`, `grid`, `box`), `composite` (the sheet's
detected and confirmed layout), `viewAngle`, `label`, `productSlug` / `productId`, and
the workspace. The `cutout` / `neutral` / `crop` fields are still DECLARED on the
schema with no writer, so an old row keeps reading honestly; nothing new is ever written
to them.

Phase 2 consumes two things from that shape: **`accepted: true`**, and **not being a
source sheet**. It reads the **`original`** — always. (The old “prefer the `cutout`
because a busy background degrades the mesh” rule went with the removed feature: that
preference is exactly what fed a deliberately damaged copy of the product into the
reconstruction.) A source sheet is provenance, never a viewpoint, so even a
force-accepted sheet is excluded from the plan and from the bytes handed to the
provider. An unaccepted or foreign reference is **refused** (422) rather than silently
dropped — generating from material a person explicitly did not accept is what Phase
1's review step exists to prevent.

---

## Testing

`backend/scripts/reference-image-smoke.mjs` — `npm run test:references`, 90 assertions,
its own server (port 4126) and its own `Flora-Alchemy-Test-ReferenceImages` database,
which it drops on the way out. It generates its own images with `sharp` (no fixtures
committed) and covers:

- **§A** one ordinary photograph: stored verbatim, measured (sharpness, contrast,
  edge mean, signature), never segmented — no cutout, no neutral preview, no engine;
- **§B** the original is immutable: the bytes never change, a second write is refused
  (`ORIGINAL_IMMUTABLE`), and identical bytes are reported as a duplicate;
- **§C–§D** composite ingestion: a 4×3 and a 3×4 sheet are recognised on the right
  axes (an ordinary photograph is not), previewing writes nothing, and confirming
  cuts one row per view inside the separators — never across them — while keeping the
  parent sheet; re-confirming updates rather than duplicating;
- **§E** correction: an ambiguous sheet reports low confidence and creates nothing, an
  explicit declared layout is obeyed, and a panel can never be split again
  (`PANEL_NOT_COMPOSITE`);
- **§F** multi-view sets: several separate photographs, ordering, primary selection,
  optional viewpoint labels, and an unknown label refused;
- **§G** accept / remove: acceptance is explicit, and deleting a sheet deletes the
  views cut from it, files included;
- **§H** tenancy and auth: cross-workspace 404s (reads, writes, deletes, bytes), and
  the same for a customer, an anonymous caller and a permission-less handler (403
  before the body is parsed); no payload leaks a storage path;
- **§I** failure recovery: a reference whose bytes are gone reports `ORIGINAL_MISSING`
  instead of a fake success, a failed row stays visible and cannot be accepted, a
  genuinely transparent PNG is kept verbatim (alpha included), and an oversized source
  image is refused with a code;
- **§J** source-sheet provenance: the composite survives the product handoff as an
  un-accepted source document, and the reconstruction plan still counts and lists only
  the cut views — proved against a raw `PATCH` that force-accepts the sheet, so the
  exclusion is a server property and not a UI convention.

`rembg` and the whole background-removal engine were REMOVED with the cutout feature;
there is no `BGREMOVE_*` configuration to pin any more, and a reference upload runs no
segmentation at all.

Frontend verification is `npm run build` plus the browser suite and the manual pass
described in [TESTING.md](./TESTING.md); there is no frontend unit runner in this
project.

### Browser verification

`frontend/e2e/specs/11-image-studio.spec.js` drives the real stack through the admin
portal (this project has no frontend unit runner), against a backend booted on its own
disposable database:

- **FLOW 23 — a composite sheet end to end.** A generated 3×2 sheet is uploaded; the
  server's proposal auto-opens the grid workspace with the detected columns/rows and
  numbered panel boxes drawn over the untouched sheet, and NO view exists yet. The
  original is fetched back and asserted byte-identical to the upload. Confirming cuts
  the views server-side; the spec then draws each cut panel back in the browser and
  measures its share of non-background pixels, so a panel that lost its product (the
  removed defect) or was cropped across a gutter into an empty band fails the test.
- **The removed feature stays removed**: the studio contains no cutout text, no
  `Fix crop` control and no "background removed" image.
- **The source sheet is provenance**: after **Accept all** the sheet card still reads
  "Kept for audit — not a view", a real view reads "Accepted ✓", and the product ends
  up with SEVEN references — six accepted panels plus the un-accepted sheet.
- **FLOW 24** — a file that only claims to be an image is refused, and ordinary product
  editing still works.
- Every step asserts no uncaught page error and no React key collision, since nothing
  else in the project would catch either.

An earlier manual pass (2026-10-14) checked the ORIGINAL/CUTOUT pair, the crop editor
and the neutral preview. Its description was removed along with the feature, because it
asserted that the background "really was removed" — precisely the behaviour this phase
exists to eliminate.

---

## Known limitations

1. **Local disk storage** — a multi-instance backend needs a shared volume or object
   storage at `REFERENCE_MEDIA_DIR` (see Storage).
2. **5 MB / 48 MP upload cap and 12 references per product** — inherited/conservative
   limits; a 12-image reference set is already generous for reconstruction.
3. **rembg cold start** — each image spawns a fresh interpreter, so the weights are
   loaded per request (seconds, not milliseconds). A resident `rembg s` HTTP service
   would be the scale-up path; the provider boundary is where that would slot in.
4. **No Python ≥ 3.14 support upstream** — rembg declares `>=3.11,<3.14`, so Python 3.14
   is outside its supported range and a future release may break it. On this machine a
   real `rembg`/`u2net` inference run nevertheless **succeeds** (Phase 4 ran the whole
   pipeline through it — see [Phase 4](#phase-4--real-local-generation) and the
   `BGREMOVE_PROVIDER=rembg` run below): the code drives rembg's library API rather than
   its CLI, and it worked against 2.0.85. Treat that as *verified today on an
   undeclared interpreter*, not as a supported configuration.
5. **Heuristics, not vision** — no camera-angle detection and no reliable object
   matching; set-level advice is deliberately hedged, and the copy says “may”.
6. **Async without a queue** — processing runs in the API process (roughly 0.2–2 s per
   image) and a row stuck in `PROCESSING` past 3 minutes is reported as interrupted and
   is re-runnable. There is no job runner in this codebase to reuse; a real queue is the
   Phase 2+ upgrade if throughput ever matters.
7. **No auto-crop suggestion in the crop UI** — the editor opens on the stored crop (or
   the full frame) with pointer-drawn and keyboard-adjustable edges; the engine's own
   `foregroundBox` is stored and shown in the metrics but is not used to pre-seed the
   box, so the first crop is the administrator's judgement rather than a suggestion.

---

# Phase 4 — real local generation

Phase 2 shipped a provider abstraction whose local slot honestly said *not configured*.
Phase 4 fills that slot with a worker that runs **real inference on this machine's GPU**
and adds the two things that keep it honest: an automated **contract suite** for the
adapter (runs anywhere, uses a loopback stand-in, spends nothing) and an opt-in
**real-generation script** that refuses to report success without a live worker.

## What shipped

| Piece | Location |
|---|---|
| The generation worker (HTTP, loopback, TripoSR) | `tools/3d-worker/worker.py` |
| Marching-cubes shim + the test that proves it matches upstream's convention | `tools/3d-worker/shims/` |
| Provider adapter (`local_worker`) | `backend/services/3dLocalWorkerProvider.js` |
| Provider policy — local-first, Meshy opt-in, never a paid fallback | `backend/services/3dModelProvider.js` (rules unchanged) |
| Contract suite — `npm run test:3d-worker` (52 assertions) | `backend/scripts/3d-worker-provider-smoke.mjs` |
| Real end-to-end generation — `npm run test:3d-real` (opt-in) | `backend/scripts/3d-real-generation.mjs` |
| Browser pass against generated bytes — `THREE_E2E_REAL_GLB=<path>` | `frontend/e2e/specs/12-product-3d.spec.js` + `e2e/stack.mjs` |

Nothing in Phases 1–3 was replaced. The worker speaks the **same provider interface** the
Meshy adapter speaks, so the job lifecycle, GLB validation, private storage, review,
approval and public delivery paths are the shipped ones; Phase 4 adds inference, not a
second pipeline.

## Model and licence

**TripoSR** — `VAST-AI-Research/TripoSR` code with weights `stabilityai/TripoSR`,
**MIT** for both (the release states the weights and source are available under MIT,
“allowing commercialized, personal, and research use”), plus the DINO tokenizer
`facebook/dino-vitb16`. This is the licence-cleared choice: no research-only or
non-commercial weights, and no per-generation cost.

Why not TRELLIS.2: upstream (`microsoft/TRELLIS.2`, MIT, weights
`microsoft/TRELLIS.2-4B`) documents **“currently tested only on Linux”** and **an NVIDIA
GPU with at least 24 GB** (A100/H100 are the verified cards), with CUDA 12.4 / PyTorch
2.6 as its default stack. This machine is Windows with a 6 GB laptop GPU, so those
requirements cannot be met here — a fact, not a preference, and no incompatible GPU
dependency was installed for it. TripoSR's own README estimates **~6 GB VRAM** for one
image at default settings, which fits (measured peak below: 2379 MB). The provider
interface is unchanged, so a heavier local model slots in behind the same adapter on
hardware that meets its requirements.

Sources: <https://github.com/microsoft/TRELLIS.2>,
<https://huggingface.co/microsoft/TRELLIS.2-4B>, <https://github.com/VAST-AI-Research/TripoSR>,
<https://huggingface.co/stabilityai/TripoSR>,
<https://stability.ai/news-updates/triposr-3d-generation>.

**Honesty about the method.** TripoSR reconstructs from **ONE** photograph — the primary
accepted reference. The surface it cannot see is a plausible completion, not a
measurement. The plan advertises `maxInputs: 1`, `submit` sends exactly one view, and the
result carries `inputMode: 'cutout'` so “which photograph made this” stays answerable.
No physical dimension or geometric accuracy is claimed anywhere.

## Environment this was verified on (2026-10-15)

| Fact | Value |
|---|---|
| OS / shell | Windows, Git Bash |
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU, **6141 MiB VRAM** (driver 591.91, CUDA 13.1) |
| Python | 3.14.2 (`C:\Python314`) + a dedicated venv at `%USERPROFILE%\flora-3d\venv` |
| torch | **2.9.1+cu128**, `torch.cuda.is_available() == True` |
| Other | transformers 4.57.6, trimesh 5.1.1, scikit-image 0.26.0, rembg 2.0.85, numpy 2.5.4 |
| Model code | TripoSR checkout at `%USERPROFILE%\flora-3d\TripoSR` |
| Weights | cached in `%USERPROFILE%\.cache\huggingface` (`stabilityai/TripoSR`, `facebook/dino-vitb16`) |
| Disk at audit | 132 GB free on `C:` |
| Marching cubes | `shims/torchmcubes.py` — scikit-image, because upstream's `torchmcubes` is a C++/CUDA extension needing MSVC + CMake |

Upstream's `requirements.txt` pins older versions (Pillow 10.1, transformers 4.35) than
what is installed; the newer set above is what actually ran, and it produced valid
watertight meshes. That is a divergence from upstream's pins worth recording, not
hiding.

## Running it

```bash
# 1. one-time environment (already done on this machine)
python -m venv "$USERPROFILE/flora-3d/venv"
"$USERPROFILE/flora-3d/venv/Scripts/python" -m pip install torch==2.9.1+cu128 \
  --index-url https://download.pytorch.org/whl/cu128
"$USERPROFILE/flora-3d/venv/Scripts/python" -m pip install numpy pillow trimesh einops \
  omegaconf "transformers<5" huggingface_hub "imageio[ffmpeg]" scikit-image rembg
# plus a TripoSR checkout (the model code):
git clone https://github.com/VAST-AI-Research/TripoSR "$USERPROFILE/flora-3d/TripoSR"

# 2. start the worker (loopback only; loads the weights, then listens)
"$USERPROFILE/flora-3d/venv/Scripts/python" tools/3d-worker/worker.py \
  --triposr-home "$USERPROFILE/flora-3d/TripoSR" --device cuda:0 --preview

# 3. prove a REAL generation end to end (isolated database + temp media, dropped after)
cd backend && npm run test:3d-real

# 4. browser pass against those exact bytes
THREE_E2E_REAL_GLB="$PWD/../audit/phase4-real-generation/<slug>.glb" \
  npx playwright test specs/12-product-3d.spec.js   # from frontend/
```

**Phase 1's ML cutout** (recommended before generating — a busy background measurably
degrades the mesh) uses the same venv:

```bash
BGREMOVE_PROVIDER=rembg BGREMOVE_PYTHON="$USERPROFILE/flora-3d/venv/Scripts/python" \
  npm run test:3d-real
```

## Measured results (2026-10-15)

Two genuine runs, both `flora-asset-10.jpg` (a wooden hamper box) → Phase 1 cutout →
accepted reference → job → TripoSR → validated GLB → private storage → candidate →
**approved** → public projection:

| | rembg/u2net cutout | deterministic cutout |
|---|---|---|
| Phase 1 | `engine=rembg model=u2net`, confidence **0.749**, `READY`, 425×277 | `engine=deterministic`, confidence 0.544, `NEEDS_REVIEW`, 264×277 |
| Job wall clock | **79.0 s** (task 73.5 s) | 82.0 s (task 76.1 s) |
| Mesh | 9320 verts / 18592 faces, watertight | 9398 verts / 18784 faces, watertight |
| GLB | **485 328 bytes** | 489 812 bytes |
| Peak VRAM | 2379 MB | 2379 MB |

Common to both: marching cubes at resolution 256, GLB attributes `COLOR_0, NORMAL,
POSITION`, generator `trimesh`, **0 materials / 0 textures** (TripoSR's colour lives in
vertex colours, not a UV atlas), model load 9.27 s warm. Approval used the shipped
`approveJobCandidate`; the public projection reported `provider: "TripoSR"` and a
`/api/3d/products/.../glb` delivery URL.

The browser pass then served those bytes to a customer session: **6/6 Playwright tests
passed in real-model mode**, with the run logging “FLOW 25 rendered the REAL GENERATED
model and the public route served 485328 generated bytes”, and 6/6 again in the default
fixture mode — so the default suite's behaviour is unchanged.

Evidence (JSON report with sha256, the GLB itself, and a rendered turntable PNG) is
written to `audit/phase4-real-generation/`, which is **gitignored** — no generated model
is ever committed.

### Re-verified 2026-10-16 — an independent second run

A full repeat the next day reproduced the result without touching anything beneath it:
worker `/health` `ready: true` on `cuda:0` (TripoSR `triposr-1.0`, MIT, weights load
16.28 s) → `rembg/u2net` Phase 1 cutout (confidence 0.749, 425×277) → **READY_FOR_REVIEW
in 80.6 s** (worker task 76.9 s, peak VRAM 2379 MB) → 9320 vertices / 18592 triangles,
watertight, vertex colours → **485 328-byte GLB** (sha256 `d79f9170…`) → **APPROVED** →
public projection `provider: "TripoSR"`.

Two checks were made *outside* the pipeline, so they do not merely restate its opinion.
The delivered container was re-read directly from disk: `POSITION, COLOR_0, NORMAL`,
55776 indices = 18592 triangles, **0 materials / 0 textures**, normalised extents — a real
reconstructed mesh, and no physical scale is claimed. The worker's 256×256 turntable render
was measured against the source: object silhouette 197×126 (**aspect 1.56**) versus the
cutout's 425×277 (**1.53**), i.e. proportions preserved within ~2 %, with object tones
(204,201,197) in the same warm range as the photograph's material (205,192,177).

Same-day suites: `test:references` 111/0 · `test:3d-worker` 52/0 · `test:3d` 188/0 ·
`test:security` 105/0 · `npm run build` clean · browser **6/6 in real-model mode**.

## Testing

- **`npm run test:3d-worker` (52)** — the adapter contract, runs anywhere with no GPU:
  opt-in policy and refusal reasons, loopback-only URL validation (a public host is
  refused with `WORKER_NOT_LOCAL`), the bearer token sent but never echoed in any
  payload, exactly ONE image transmitted and its bytes equal to the primary accepted
  reference's cutout, a full job through the real claim/poll/validate/store loop, four
  failure paths (failed task, non-GLB bytes, a worker lying about its container,
  unreachable worker — each ending the job with a readable code, no asset and no
  orphaned file), cancellation reaching the worker, and a projection with no storage
  key or tenant id.
- **`npm run test:3d-real` (opt-in, never in `test:all`)** — a genuine generation. It
  **skips with exit 0** when no worker is listening and **fails with exit 2** under
  `--require-worker` (what `test:3d-real` passes), so a run that was supposed to prove
  generation cannot quietly pass without one. It uses its own
  `Flora-Alchemy-Test-Phase4Gen` database and temp media roots, and drops them.
- **Browser** — `THREE_E2E_REAL_GLB=<path>` makes the e2e stack publish the generated
  bytes with `provider: local_worker`; the log and the screenshot state which mode ran.

## Safety rules this phase must not regress

1. **Still opt-in.** The default is `THREE_D_PROVIDER=local_unavailable`. Nothing selects the
   local worker on the operator's behalf, and `backend/.env` decides it — not a request.
2. **Never a paid fallback.** A local failure fails the job; Meshy is reachable only
   with `THREE_D_PROVIDER=meshy` **and** `MESHY_API_KEY`.
3. **Loopback only.** `THREE_WORKER_URL` is validated to loopback/RFC1918 before any
   request leaves the process (`WORKER_NOT_LOCAL`), keeping the provider path out of
   SSRF. The URL comes from the environment, never from a request body.
4. **No credential ever leaves the server.** `THREE_WORKER_TOKEN`, when set, is sent as
   a bearer header and appears in no endpoint, description or projection; no key is in
   any frontend bundle.
5. **A candidate is not a publication.** Approval stays an administrator act; a
   rejected or failed replacement still cannot touch the live model (Phase 2/3 rules,
   unchanged).

## Known limitations — Phase 4

1. **Single view, single shot.** One accepted photograph per model; the far side is
   inferred. No multi-view reconstruction, no scale, no dimensions.
2. **No UV texture.** TripoSR stores colour per vertex, so the GLB reports 0 materials /
   0 textures. Fine for a small keepsake in a viewer; a hero asset would want a
   textured remesh or a different model.
3. **One inference at a time, in-process.** The worker serialises tasks, and the job's
   background run lives in the API process — a restart mid-generation leaves the job to
   be retried (Phase 2's documented limitation, unchanged).
4. **The contract suite does not run inference.** CI machines have no GPU; the stand-in
   proves the transport and every stage around it, and `test:3d-real` is the proof of
   inference — run it on GPU hardware.
5. **TRELLIS.2 and hosted providers are unevaluated here.** Meshy remains opt-in and
   unrun (no key, and no paid call is ever made automatically); TRELLIS.2 was ruled out
   for this Windows/6 GB machine rather than measured.
6. **Worker auth is a shared secret, not identity.** `THREE_WORKER_TOKEN` is optional
   and the worker binds loopback by default — it is a local process boundary, not a
   hardened service boundary. Do not expose the worker port.


# Phase 5 — the quality gate

**A valid GLB is not automatically a valid product model.** Phase 2 answers *"are
these bytes genuinely a glTF Binary container?"*. That check
passes for a mesh that looks nothing like the product, so Phase 5 asks the next
question and makes the answer binding: **does this mesh resemble the thing in the
accepted photograph, and may it be published?**

Nothing in Phases 1–4 was replaced. The gate reads the stored bytes with its own
code and sits inside the shipped approval service, so it is enforced wherever an
approval can happen.

## What shipped

| Piece | Location |
|---|---|
| GLB geometry reader + orthographic silhouette projector | `backend/services/3dMeshGeometry.js` |
| Silhouette metrics (masks, normalisation, IoU, contour, view selection) | `backend/services/3dSilhouetteMetrics.js` |
| The assessment service (decisions, thresholds, fingerprint) | `backend/services/3dQualityAssessment.js` |
| Gate enforcement inside the approval path | `backend/services/3dAssetService.js` (`assessAssetQuality`, `ensureQualityReport`, `approveAsset`) |
| Stored verdict on the candidate | `backend/models/Product3DAsset.js` (`quality`) |
| Re-assess endpoint | `POST /api/3d/assets/:assetId/assess` |
| Suite — `npm run test:3d-quality` (84 assertions) | `backend/scripts/3d-quality-smoke.mjs` |
| Deterministic geometry / reference fixtures | `backend/scripts/lib/meshFixtures.mjs` |
| Repeatable evaluation tool for a REAL model | `backend/scripts/3d-quality-report.mjs` |

## The three decisions

- **PASS** — measured, and comfortably inside every band. Eligible for normal approval.
- **REVIEW** — valid but not comfortably good: a borderline score, an uncertain
  viewing angle, a doubtful reference, or a measurement that could not be taken.
  A human must compare the model with the photograph and say so; the note, their
  identity and the time are stored on the asset.
- **BLOCKED** — a critical structural failure or a severe mismatch. Normal
  approval is refused. The only way past is an **administrator override with a
  non-empty reason**, which stores the actor, the time, the reason and *the
  verdict it overrode* — the original BLOCKED report stays on the row.

Material limitations are deliberately **warnings, not blockers**: a vertex-colour
TripoSR asset is a legitimate generated model and is never described as
PBR-textured, but it is not held back for lacking a UV atlas. A deployment that
really needs texture maps sets `THREE_QUALITY_REQUIRE_MATERIALS=1`, which turns
that into a critical failure.

## Metric definitions (each is reproducible from the stored bytes)

| Metric | Definition |
|---|---|
| `iou` | Intersection over union of the model's projected silhouette and the reference mask's, after removing **translation and uniform scale only** |
| `aspectError` | `|model aspect − reference aspect| / reference aspect`, from each shape's own trimmed bounding box |
| `coverageDelta` | Absolute difference in the share of the frame each silhouette occupies after the same normalisation |
| `contourDistance` | Symmetric mean boundary distance between the two silhouettes, in pixels of the 144² canonical grid |
| `viewAgreement` | `clear` when the best view beats the best *different* silhouette by ≥ `minViewMargin`, else `ambiguous` |

**The alignment rule matters.** Only translation and uniform scale are removed.
Non-uniform warping — stretching x and y independently to force a match — is
never used, because it would score an incorrectly proportioned model as correct,
which is the exact failure this phase exists to catch.

**Symmetry is not ambiguity.** A box's front and back views are the *same*
rectangle, so they tie by definition. The first implementation judged agreement by
the margin over the runner-up and therefore called every box, tray and hamper
ambiguous — a bar no symmetric product could clear. Agreement is now measured
against the best *different* silhouette, and a mirrored tie is reported separately
(`tiedViews`).

**Orientation is a measurement problem, not a defect.** Nothing in a stored asset
records which way it faces, so six orthographic views are scored, the best is
chosen, and the report records which one and how clearly it won. A model that
arrived rotated is recognised (`orientationCorrected`) rather than condemned.

## Thresholds — and how provisional they are

Defaults (all overridable by env or by an explicit argument):

| Threshold | Default | Env |
|---|---|---|
| `passIou` | 0.75 | `THREE_QUALITY_PASS_IOU` |
| `blockIou` | 0.35 | `THREE_QUALITY_BLOCK_IOU` |
| `passAspectError` | 0.25 | `THREE_QUALITY_PASS_ASPECT_ERROR` |
| `blockAspectError` | 1.0 | `THREE_QUALITY_BLOCK_ASPECT_ERROR` |
| `minViewMargin` | 0.05 | `THREE_QUALITY_MIN_VIEW_MARGIN` |
| `requireMaterials` | false | `THREE_QUALITY_REQUIRE_MATERIALS=1` |
| `minTriangles` / `maxTriangles` | 200 / 1 500 000 | — |
| `referenceMinConfidence` | 0.6 | — |

**Calibration sample: ONE genuine generated model** (plus deterministic fixtures
whose answer is known). The bands are therefore *conservative and provisional*,
which every report states in `calibration` rather than implying the numbers are
validated. The PASS band is deliberately hard to reach and anything in the middle
is a human decision — the safe direction when a metric is uncalibrated.
Contradictory configuration (`passIou ≤ blockIou`) is refused with
`QUALITY_THRESHOLDS_INVALID` rather than silently honoured.

## Reference quality is part of the verdict

A low score against a *doubtful* reference mask is evidence about the reference as much
as about the model, so the gate records where the mask came from and changes its
behaviour accordingly.

**Where the mask comes from (this changed with the cutout removal).** The gate used to
compare against Phase 1's prepared cutout. Background removal is gone — it destroyed
product detail — so the only honest mask left is transparency the SOURCE IMAGE itself
carries. A PNG with real alpha still yields a silhouette to compare; an ordinary
photograph yields none, and the report says so with `SILHOUETTE_UNAVAILABLE` +
`REFERENCE_MASK_MISSING`, which is a REVIEW, never a silent pass and never a fabricated
mask. The `cutout*` field names are kept because stored reports and the audit tooling
already speak them; they now mean “reference mask”.

- stray disconnected regions are removed from **both** silhouettes before
  comparison (a single speck 200 px away would otherwise define the frame the
  whole comparison happens in), and what was dropped is reported;
- a severe mismatch against a **flagged** reference becomes
  `SILHOUETTE_SEVERE_MISMATCH_DOUBTFUL_REFERENCE` — a **REVIEW**, not a refusal.

That branch is not theoretical; it is what the genuine Phase 4 model produced
below.

## Enforcement — why the frontend cannot fake it

1. The verdict is **associated with exact bytes**: a fingerprint over the GLB's
   sha256, the reference ids and the generation settings. A report can never be
   inherited by a model it did not measure.
2. A **missing or stale** report is re-computed from storage before any approval
   is honoured. Changing the reference set invalidates the report *and clears any
   previous review acknowledgement*, because that acknowledgement was about a
   different model.
3. Any `quality`-shaped field in a request body is **ignored**: the approve route
   reads only `reviewNote`, `overrideQuality` and `overrideReason`, and the suite
   proves it by submitting `{ quality: { decision: 'PASS', iou: 0.99 } }` and
   watching the approval still be refused with the measured verdict intact.

## Measured result on the genuine Phase 4 model (2026-10-16)

> **Historical record, kept as evidence.** These numbers were measured while Phase 1's
> cutout still existed, and the reference mask in the table below is a cutout. The gate
> now derives its mask from the source image's own transparency instead — see
> [Reference quality is part of the verdict](#reference-quality-is-part-of-the-verdict)
> — so a fresh run against an ordinary photograph reports `SILHOUETTE_UNAVAILABLE` and
> lands in REVIEW rather than reproducing these figures. The arithmetic and the
> thresholds are unchanged.

`npm run test:3d-quality` proves the arithmetic on fixtures; this is the real
thing — the TripoSR asset Phase 4 generated and approved
(`heirloom-keepsake-hamper-phase4-mvb0vroo.glb`, 9320 verts / 18 592 triangles /
watertight / 485 328 bytes), assessed against a genuinely re-derived Phase 1 cutout
of `flora-asset-10.jpg`:

| Reference engine | Decision | IoU | Aspect error | Best view | Contour |
|---|---|---|---|---|---|
| `rembg/u2net` (what Phase 4 generated from) | **REVIEW** | **0.4311** | 52.9% | `top` (ambiguous, margin 0.048) | 6.85 px |
| `deterministic` (Phase 1 flagged this cutout) | **REVIEW** | 0.1111 | 104% | `right` (ambiguous, margin 0.019) | 21.56 px |

Reported honestly: **the generated model does not pass the gate.** Its geometry is
valid and watertight, but its silhouette only partially matches the photograph it
was made from, and the view choice was close enough to another orientation to be
an assumption. Under the gate it would have needed an explicit human review rather
than being approved on validity alone — which is precisely the gap Phase 5 was
written to close. With the deterministic engine's cutout the mismatch is severe,
and the gate **declines to refuse** it because that cutout is itself flagged as
doubtful: the reference may be the cause as much as the model.

Evidence (the machine-readable report plus a three-panel diagnostic image —
reference | model | overlay) is written by
`node scripts/3d-quality-report.mjs --glb=<model> --photo=<photo>` into
`audit/phase5-quality/`, which is **gitignored**.

## Running it

```bash
# the gate's arithmetic: no GPU, no provider, no inference
cd backend && npm run test:3d-quality

# a real model, against a prepared cutout or a photograph
node scripts/3d-quality-report.mjs --glb=<model.glb> --cutout=<cutout.png> --label=my-model
node scripts/3d-quality-report.mjs --glb=<model.glb> --photo=<photo.jpg>     --label=my-model
```

The tool exits `0` when the model was assessed (read the decision from the
report), `1` when the assessment itself failed, and `2` when an input was
unavailable — so "could not measure" can never be read as "measured badly".

## Known limitations — Phase 5

1. **One genuine sample set the bands; four have now been measured.** Phase 5's
   bands were chosen against a single genuine model. **Phase 6 measured three
   more** (a rigid/structured object, a floral arrangement, and an irregular
   decorated object — see [Phase 6](#phase-6--browser-coverage-genuine-model-evaluation-hardening)),
   all three landed in REVIEW, and **the bands were left unchanged** rather than
   tuned to the sample. The report's `calibration.genuineSamples: 1` therefore
   still reads 1 on purpose: it records how many genuine models the *bands* came
   from, not how many the gate has since been pointed at. Until a real
   calibration exists the gate errs towards REVIEW, which costs a human decision
   rather than a wrong publication.
2. **Single-view reconstruction is compared against a single photograph.** With
   multi-view generation the comparison should use the *corresponding real
   reference view* for each camera. Today a rear view of the model is compared
   against a front photograph, and the report says the view choice was an
   assumption when that is what it was.
3. **Silhouette is not shape.** Two different objects can share an outline, so a
   high IoU is necessary but not sufficient — which is why geometry, structural and
   material findings are reported alongside it rather than folded into one score.
4. **Ornamental detail cannot be measured** at 144² from one view. Fine engraving,
   weave and colour fidelity are simply not in scope, and no claim is made about
   them.
5. **The diagnostic image is a convenience**, not the measurement: the numbers come
   from the masks, and the PNG exists so a human can see what was compared.
6. **Orthographic projection only.** The stored asset records no camera, so no
   perspective render is attempted.
7. **The browser coverage this entry used to say was missing now exists.**
   Phase 5's probe (run once, then deleted) is replaced permanently by
   `frontend/e2e/specs/13-quality-review.spec.js` — FLOW 31–36, six tests driven
   by the real stack, a real admin sign-in and the real admin product page, with
   the E2E stack provisioning a candidate for **every** state the panel renders.
   What is *fixture* and what is *real* is stated there and in
   [Phase 6](#phase-6--browser-coverage-genuine-model-evaluation-hardening):
   the geometry and cutouts are deterministic, while the reference row, the
   candidate row, its private bytes, the job row, the report and every API call
   are real. The gate's RULES remain proven server-side   by `npm run test:3d-quality`.

---

# Phase 6 — browser coverage, genuine-model evaluation, hardening

Phase 5 shipped the gate. Phase 6 closes the gaps Phase 5 documented: the review
panel had never been drawn by a real browser test, the bands had been set against
one genuine model, and no full 25-suite sweep had been recorded.

Nothing in Phases 1–5 was rebuilt, and **no threshold was changed**.

## What shipped

| Piece | Location |
|---|---|
| Permanent browser coverage of the review panel (FLOW 31–36) | `frontend/e2e/specs/13-quality-review.spec.js` |
| Candidate fixtures for every panel state, via the shipped services | `frontend/e2e/stack.mjs` (`provisionQualityCandidates`), shared with the spec through `frontend/e2e/support/fixtures.js` |
| Media-root pinning + a cutout read-back guard, before any media import | `frontend/e2e/stack.mjs` (`pinMediaRoots`) |
| The provider **credential canary** the payload check asserts against | `frontend/e2e/support/fixtures.js` (`PROVIDER_SECRET_CANARY`) |
| Real generation now retains the accepted cutout and records the gate's verdict **before** approval, and can record a human review note | `backend/scripts/3d-real-generation.mjs` |
| The genuine evaluation set (machine-readable) | `audit/audit/phase6-quality/evaluation-set.json`, rebuilt by `audit/phase6-quality/build-evaluation-set.mjs` |

## Browser coverage of the panel — FLOW 31–36

Run with the rest of the suite: `npm run test:e2e` (from `frontend/`).

| Flow | What it proves in a real browser |
|---|---|
| 27 | a **PASS** candidate shows its decision, the named metrics and the reference provenance (engine + confidence); no acknowledgement or override field is rendered; Approve is enabled |
| 28 | **REVIEW** shows the server's reason codes, warnings and material state; Approve stays disabled until a ≥5-character note is typed — and the **server** refuses the same call with `QUALITY_REVIEW_REQUIRED`, so the UI gate is a courtesy, not the rule |
| 29 | **BLOCKED** cannot be approved; a blank (whitespace-only) override reason is refused; a **forged verdict in the request body** (`{ quality: 'PASS', iou: 0.99 }`) changes nothing — the server answers with its own measured verdict |
| 30 | a **failed** assessment (the stored model file genuinely gone) renders as REVIEW with `ASSESSMENT_FAILED`; a **stale** verdict is labelled out of date; clicking Approve **re-measures** and publishes with a different fingerprint |
| 31 | **rejecting a replacement** leaves the approved model exactly as it was — same row, same bytes, still public — and settles the job |
| 32 | the studio payload carries **no storage paths, no workspace ids and no credential** — the credential assertion uses a canary provider key the stack configured before boot, so it tests a *value*, not the vocabulary of a setup hint |

What is fixture and what is real, stated plainly: the geometry and cutouts are
deterministic (`backend/scripts/lib/meshFixtures.mjs`) and every fixture row is
labelled `e2e-fixture` / `e2e-fixture-engine`. **Not one is an AI-generated
model, and the spec never says otherwise.** What is real: the reference row, the
candidate row, its private bytes on disk, the job row, the quality report, the
admin session and every API call. The gate's *rules* remain proven server-side by
`npm run test:3d-quality` (84).

### Two defects the browser coverage exposed

Both were latent in shipped code; neither was a test bug.

1. **The stack and the backend disagreed about where reference media lives.**
   `services/referenceAssetStorage.js` resolves its root **once, at import time**.
   The E2E stack set `REFERENCE_MEDIA_DIR` inside the fixture block, *after*
   tenant cleanup had already imported the module — so the stack wrote every
   fixture cutout into `backend/reference-media/` while the backend child (given
   the E2E root) looked in `frontend/e2e/.media-references/`. It was invisible at
   fixture time because the first assessment runs in the stack process, against
   the very module the write used, and reported a healthy IoU 1.0. It surfaced
   only when the browser clicked Approve and the **backend** re-measured:
   `QUALITY_REVIEW_REQUIRED … The accepted cutout has no bytes.`
   `stack.mjs` now pins both roots in `pinMediaRoots()` before the first media
   import, **asserts** `mediaRoot()` matches at boot (a reordering fails loudly at
   startup instead of as a mystery 422 later), and reads every fixture cutout
   straight back after writing it.
2. **A failed decision produced an unexplained timeout.** FLOW 34/35 now record
   the approve/reject request, its body and the server's answer
   (`recordDecisionCalls`), so a failure states *whether the call was made and
   what came back* rather than timing out with no diagnosis.

## Genuine-model evaluation — three new samples, all real

Three genuinely generated models of different geometry, produced by the local
worker (TripoSR on an RTX 4050) from real catalogue photographs through the real
Phase 1 pipeline, then measured by `scripts/3d-quality-report.mjs` against **the
exact cutout each model was generated from**:

| # | Subject (photograph) | Mesh | Reference (rembg/u2net) | IoU | Aspect error | Best view (margin) | Contour | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | ceramic vase + lavender (`flora-asset-10.jpg`; the seed names it “Hamper Box”, the photograph is a vase) | 9 320 v / 18 592 tri · 474 KB · watertight | conf 0.749 · 425×277 | **0.4311** | 52.9 % | `top` (0.048) | 6.85 px | **REVIEW** |
| 2 | wrapped floral posy (`flora-asset-01.jpg`) | 55 127 v / 110 202 tri · 2 800 KB · watertight | conf 1.000 · 505×386 | **0.6795** | 43.5 % | `front` (0.003) | 4.96 px | **REVIEW** |
| 3 | flat card with wax seal (`flora-asset-08.jpg`; the seed names it “Chenille Charm”, the photograph is a card) | 35 684 v / 71 364 tri · 1 813 KB · watertight | conf 0.862 · 408×265 | **0.5203** | 59.8 % | `left` (0.024) | 9.69 px | **REVIEW** |

All three are **vertex-coloured with no texture maps** (TripoSR stores colour per
vertex), reported as `MATERIAL_VERTEX_COLOUR` warnings rather than blockers, as
Phase 5 intended. Reasons were `SILHOUETTE_VIEW_AMBIGUOUS` +
`SILHOUETTE_WEAK_MATCH` on every sample. **Nothing passed and nothing was
blocked**; no request was made with a fabricated score.

**Human check — did the verdict match what I could see?** Yes, on all three,
checked by comparing the source photograph, the accepted cutout, TripoSR's own
render of the reconstruction and the gate's reference/model/overlay diagnostic:

- the vase and the card are recognisable as the same objects in the renders, and
  REVIEW is still the right verdict: their silhouettes against the photographs
  really do differ enough that a human should look before publishing;
- the posy is a faithful reconstruction — clearly the same bouquet and wrap —
  and REVIEW (rather than PASS) is honest because its silhouette is fatter than
  the photograph's and the winning view beat the runner-up by only 0.003;
- the card sample is the one the metric **under-reports the most** (60 % aspect
  error against a recognisable object), which is the false-block pressure
  described below.

Two of the three seed photographs do not match the product names they are
attached to (a vase is named “Hamper Box”, a card is named “Sunflower Charm”).
The evaluation records what the photographs actually show.

## Thresholds: unchanged, and explicitly provisional

The Phase 5 defaults stand exactly as they were — `passIou 0.75`, `blockIou 0.35`,
`passAspectError 0.25`, `blockAspectError 1.0`, `minViewMargin 0.05`,
`referenceMinConfidence 0.6`, `requireMaterials false` — and **no band was moved**.

The evidence for leaving them alone:

- every genuine sample sat below the PASS bands on **every** gate criterion
  (IoU, aspect error and view margin), so there is no sample to “fix” without
  tuning to three models;
- there is **no false pass** to correct (nothing passed) and **no false block** to
  correct (nothing was refused — the doubtful-reference branch did its job on the
  sample whose cutout Phase 1 had doubted);
- what the samples *do* show is a property of the metric: the aspect term and the
  view-margin floor compare an **axis-aligned orthographic projection** with a
  **perspective photograph of a posed object**. A genuine single-view
  reconstruction measured against an angled catalogue photograph is therefore
  unlikely to reach `passAspectError 0.25`, whatever its quality.

So the operational truth is: **a genuine model will normally land in REVIEW and a
human decides.** That is the safe direction, and it is stated here rather than
quietly tuned away. `calibration` in every report still reads
`genuineSamples: 1, provisional: true` — that field records how many genuine
models the *bands* were set from, and this evaluation did not re-derive them.

## The human path, exercised on a real model

One of the three was then published through the shipped REVIEW path:

- the gate refused normal approval (`QUALITY_REVIEW_REQUIRED`, IoU 0.6795);
- a human note was supplied after comparing the render with the photograph;
- the asset became APPROVED **with the verdict intact** — `quality.decision`
  stayed `REVIEW`, `quality.review.acknowledgedBy` records who and when;
- the public projection resolved and served the model.

Approval did not overwrite what was measured, which is the rule Phase 5 set.
A BLOCKED model still cannot be approved this way: only an administrator
override with a reason can do that, and it keeps the BLOCKED report.

## Reproducibility — verified, not asserted

The objective asks that results stay reproducible across releases. They do:

- the Phase 6 model generated from `flora-asset-10.jpg` is **byte-identical**
  (`sha256 d79f9170b4e8ea35…`, 485 328 bytes) to all four Phase 4 artifacts of the
  same photograph generated on 2026-10-15 and 2026-10-16 — separate runs,
  separate processes;
- measuring it again in Phase 6 agreed with the stored Phase 5 report on
  **every** value: REVIEW, IoU 0.4311, view `top`, margin 0.0483, aspect error
  0.5289, contour 6.85 px;
- the reviewed run produced `sha256 13cf98339e3f4411…` — byte-identical to the
  posy sample, so only the recorded human acknowledgement differs between them.

Given the same photograph, the same accepted cutout and the same weights, the
pipeline returns the same bytes and the same verdict. `audit/` is gitignored, so
the raw evidence lives on this machine rather than in the repository; the
commands to regenerate it are recorded in `evaluation-set.json`.

## Known risks after this evaluation

- **False pass — none observed.** No genuine model passed. The fixture-only PASS
  cases prove the arithmetic, never that a real model is good.
- **False block — real.** Three recognisable reconstructions all landed in
  REVIEW. That is deliberately the conservative direction, but PASS is
  effectively unreachable for a genuine model measured against an angled
  photograph (see the aspect-term note above).
- **The reference matters as much as the model.** The same gift-box GLB measured
  IoU 0.4311 against the `rembg/u2net` cutout and 0.1111 against the deterministic
  engine's flagged cutout — REVIEW in both cases, which is the behaviour Phase 5
  designed.
- **Silhouette is still not shape**, and the material story is still a warning:
  no genuine model here has texture maps.

## Limits of this environment (recorded, not worked around)

1. **Single input view.** The local worker reports `supportsMultiView: false`,
   `maxInputViews: 1`, so cross-view consistency of the *generation* could not be
   assessed. The gate's own view consistency is still reported as
   `viewAgreement` / `viewMargin` over its six projections.
2. **Three new samples, four measured in total** — all single-object catalogue
   photographs with fairly clean backgrounds. Far short of a calibrated band,
   which is why the thresholds stay provisional.
3. **No Meshy or TRELLIS run.** No key is configured and no paid call is ever
   made automatically, so everything above is the local provider only.
4. **GPU-dependent.** The genuine generation ran on this machine's RTX 4050;
   nothing in CI depends on it — the browser suite provisions deterministic
   fixtures instead, and `test:3d-real` remains opt-in.

---

# Production availability

**Verified 2026-10-17 from the repository, not from a production log.** Two
capabilities in this studio depend on infrastructure that a deployed API does not
get for free.

## Generation (the model worker)

`tools/3d-worker/worker.py` binds **loopback only** (`127.0.0.1:8188` by default)
and runs TripoSR on a local GPU. It is **not deployed** and is not reachable from
the Render API host: `3dLocalWorkerProvider` resolves `THREE_WORKER_URL`, which
defaults to a loopback address that means “this machine”. Production therefore
sits in one of these states, and only one is true at a time:

| State | How to recognise it | What the studio shows |
|---|---|---|
| Worker not configured (the deployed default) | `THREE_PROVIDER` unset or `local_worker`, no reachable loopback worker | an explicit “generation is unavailable” message with the reason; **no job is queued and no credits are spent** |
| Hosted provider configured | `THREE_PROVIDER=meshy` **and** `MESHY_API_KEY` set | generation runs against Meshy 7.1 |
| Private worker deployed | `THREE_WORKER_URL` points at a secured, non-public address | generation runs against that worker |

There is deliberately **no automatic fallback** from one to another: a missing
worker can never silently spend money on a paid provider. The availability
endpoint reports the resolved provider and its reason so an operator can tell the
three states apart without reading the source. Exposing the loopback worker
publicly is not a supported configuration — it has no authentication of its own
by design.

## Media durability

Both private roots must be on a persistent disk (see
[Storage](#storage) and
[DEPLOYMENT.md](../DEPLOYMENT.md#private-media-reference-images--3d-models)).
On an ephemeral filesystem the database keeps working and the studio appears
healthy until the first redeploy, after which every original reports
`missing: true`. This is surfaced at boot, in `/api/health` and in the asset read
response rather than being left to be discovered.

## What is still unproven in production

- No upload has been executed against the deployed API from this repository
  (there is no authorised production staff session here). The upload path is
  proven end to end against a real backend process in
  `scripts/reference-image-smoke.mjs` (including failure injection at the storage
  and database boundaries) and in the browser suite
  (`frontend/e2e/specs/11-image-studio.spec.js`).
- The deployed media roots are unverified until someone reads `media` from
  `GET /api/health` on the live service — see `scripts/production-probe.mjs`.
