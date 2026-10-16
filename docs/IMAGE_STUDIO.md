# 3D Studio — Prepare Images (Phase 1), Generate a Model (Phase 2) & the Customer 3D Experience (Phase 3)

Phase 1 is [below](#phase-1--prepare-images); **Phase 2 — generate, review and approve a
3D model — is in its own section** at [Phase 2 — Generate a model](#phase-2--generate-a-model).

An administrator uploads product photographs — plain studio shots, photos with busy
backgrounds, and promotional flyers — and the portal prepares a clean reference set:
the untouched **original**, a transparent-background **cutout**, and a
neutral-background **preview**, each measured, validated and reviewable before it is
saved with the product.

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
  → create row: status UPLOADING                           models/ProductReferenceImage.js
  ← 201 { image, duplicateOf, setWarnings, setNotes }      (returns immediately)
  ── background job ─────────────────────────────────────
  → optional administrator crop → engine                  services/bgRemoval/index.js
  → transparent cutout + neutral preview (PNG)             (never overwrites the original)
  → measurements, warnings, notes, confidence
  → row: READY | NEEDS_REVIEW | FAILED
```

The client polls `GET /api/references?productSlug=|draftKey=` while any row is
`UPLOADING`/`PROCESSING`. Status vocabulary: `UPLOADING`, `PROCESSING`, `READY`,
`NEEDS_REVIEW`, `FAILED`.

`READY` requires confidence ≥ 0.7 and no warnings; anything else lands in
`NEEDS_REVIEW` with the reason attached, which is where the review screen asks for a crop
instead of quietly shipping a wrong cutout.

### Two engines, one interface

`services/bgRemoval/index.js` is the only entry point; callers never import an engine.

1. **`deterministic`** (default, always available) — `sharp` only, no Python, no model
   weights, no download. A border-seeded flood fill with an adaptive tolerance measures
   the backdrop from the border ring, recovers enclosed background (a wreath's centre,
   a handle) by colour, drops specks, feathers the mask and trims excess whitespace.
   Strong on real product photography against plain/neutral/graded backdrops.
2. **`rembg`** (opt-in) — a real segmentation network via a locally installed
   `rembg`, which handles busy scenes (foliage behind a bouquet, flyers with artwork)
   far better. Selected with `BGREMOVE_PROVIDER=rembg`, or `auto` which uses it when an
   install is reachable and reports which one ran.

Selection is never invented: `GET /api/references/engine` reports the requested engine,
the selected engine, whether rembg probed available and why, and — per image —
`processing.engine`, `processing.model` and `processing.modelLicence` are stored, so any
reviewer can tell what produced a cutout. If rembg is requested but the *install* is
broken, the deterministic engine runs only as a recorded fallback (a warning naming
both engines), and `BGREMOVE_FALLBACK=0` turns even that off.

### What it cannot do

The engine set is deliberately modest, and the code says so rather than guessing:

- No camera-angle detection, no true object matching. The set-level checks compare
  cheap signatures (hue histogram, saturation, aspect) and edge energy, and every
  message is worded as a possibility (“may”, “appears”).
- A colour-only engine can punch out a product region that genuinely matches the
  backdrop (a cream ribbon on cream paper) if that region is large. That is why the
  result is scored, warned about, and routed to review.
- A flyer whose background is text, gradients and artwork is reported as
  low-confidence with a crop request — never silently “cleaned”.

---

## Storage

Reference media lives in its own **private** root, never in `frontend/public/uploads`
(which is world-readable) and never on the ImageKit CDN:

```
<root>/<workspace-slug>/<imageId>/original.<ext>     write once — a second write is refused
<root>/<workspace-slug>/<imageId>/cutout.png
<root>/<workspace-slug>/<imageId>/neutral.png
```

- Root: `REFERENCE_MEDIA_DIR` (default `backend/reference-media`).
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

**Single-instance limitation (stated, not hidden):** the root is a local directory. A
multi-instance deployment (e.g. several Render replicas) needs a shared volume or object
storage mounted at the same path, exactly like any other uploaded file in this project.
Nothing in the API assumes a particular backend — `referenceAssetStorage.js` is the only
module that touches the filesystem.

---

## Setup

### Required

The built-in engine is ready once backend dependencies are installed — no service to run,
no model to download, no Python. `npm run install:all`, then `npm run api:dev`.

**New dependency: `sharp` `^0.35.5`** (Apache-2.0, with platform-specific prebuilt
`libvips` binaries) — the only package this phase adds, and it was not previously a
backend dependency. It is what decodes and encodes every original, cutout and neutral
preview, reads image metadata honestly (format and dimensions come from the decoded
container), and does the mask feathering. The stack has no other image codec, so this
is a need rather than a preference; it needs Node `^18.17 || ^20.3 || >=21` (the
project requires Node ≥18) and installs as ordinary prebuilt binaries on Render.

### Optional — the ML engine (rembg)

Worth doing when the catalogue has flyers, or products photographed against foliage,
workbenches or patterned cloth.

```bash
# From the repository root. rembg needs Python >=3.11,<3.14.
python -m venv tools/bgremove/.venv
# Windows
tools/bgremove/.venv/Scripts/python -m pip install "rembg[cpu]"
# macOS / Linux
tools/bgremove/.venv/bin/python -m pip install "rembg[cpu]"
```

The provider looks for a Python interpreter in this order, so the venv above is found
with no configuration:

1. `BGREMOVE_PYTHON` (an explicit path),
2. `tools/bgremove/.venv/Scripts/python.exe` (Windows) / `tools/bgremove/.venv/bin/python`,
3. `python`, then `python3` on `PATH`.

Then, in `backend/.env`:

```ini
BGREMOVE_PROVIDER=auto          # auto | deterministic | rembg
BGREMOVE_MODEL=u2net            # a commercially-cleared model — see below
```

`auto` picks rembg when the probe succeeds (the probe imports rembg and onnxruntime and
is cached for the process; `BGREMOVE_PROBE=0` disables it). The first processed image
downloads the weights (u2net ≈ 176 MB, into `~/.rembg/models`) — expect that one request
to be slow, and raise `BGREMOVE_TIMEOUT_MS` if the machine is slow:

| Variable | Default | Purpose |
|---|---|---|
| `BGREMOVE_PROVIDER` | `auto` | `auto`, `deterministic` or `rembg`; anything else is a boot-time error |
| `BGREMOVE_MODEL` | `u2net` | model id, validated against the licence table **and** the installed rembg |
| `BGREMOVE_PYTHON` | — | explicit interpreter path |
| `BGREMOVE_PROBE` | enabled | `0` to skip the (cached, seconds-long) rembg probe |
| `BGREMOVE_FALLBACK` | enabled | `0` to forbid the recorded fallback to the built-in engine |
| `BGREMOVE_DECONTAMINATE` | `0` | `1` to strip background colour fringing from soft edges |
| `BGREMOVE_TIMEOUT_MS` | `180000` | per-image timeout |
| `BGREMOVE_ALLOW_UNVERIFIED_MODEL` | — | `1` only if you have obtained permission for an unverified model |
| `BGREMOVE_DEBUG` | — | `1` to log the mask, enclosed regions and per-image engine detail |
| `REFERENCE_MEDIA_DIR` | `backend/reference-media` | private media root |

The provider drives rembg's **library** API (`python -c … ; from rembg import remove,
new_session`), not its CLI: the CLI's `i` subcommand dropped `--output` and takes the
output path positionally, and the package ships no `__main__`, so `python -m rembg` is
not portable. A regression back to the CLI fails the smoke suite (`§J`).

### Licensing — verified 2026-10-14

**Software:** `rembg` itself is **MIT**, which is compatible with this project.

**Model weights are licensed separately from rembg's code** — this is the trap. rembg's
own README says so explicitly, and its *default* model is one this project must not use:

| Model | Weights licence | Status here |
|---|---|---|
| `u2net`, `u2netp`, `silueta` | Apache-2.0 (U-2-Net upstream) | **Allowed — default** |
| `birefnet-general`, `birefnet-general-lite` | MIT (BiRefNet official weights) | **Allowed** |
| `bria-rmbg` — rembg's default | BRIA terms: non-commercial; commercial use needs a BRIA agreement | **Refused in code** |
| `isnet-general-use` | No licence statement found for the weights | **Refused in code** |
| anything else | unknown | **Refused in code** |

Sources: <https://github.com/danielgatis/rembg> (MIT code; model list; the note that
weights carry their own licences; `bria-rmbg` as default and its paid-agreement
requirement), <https://huggingface.co/briaai/RMBG-1.4> (BRIA's non-commercial terms),
<https://github.com/danielgatis/rembg/issues/837> (no licence statement attached to the
redistributed `u2net.onnx`; the Apache-2.0 assessment comes from the U-2-Net repository
the weights were trained in).

Two honest caveats: rembg redistributes the weights as its own `.onnx` downloads and at
least one carries no statement of its own (hence “best available evidence” above), and
the refusal is enforced in code —
`resolveModel()` throws `BGREMOVE_MODEL_NOT_LICENSED` for a non-commercial model **even
when an operator configures it explicitly**, and the smoke suite asserts that, so the
guard cannot be lost by accident.

---

## API

All routes are staff-only (`protect` → `adminOrHandler` → workspace gate → product
permission), except `/cleanup`, which additionally requires the platform owner. Mount:
`/api/references`.

| Method & path | Notes |
|---|---|
| `GET /engine` | requested/selected engine, rembg availability + reason, model, licence |
| `GET /` | `?productSlug=` or `?draftKey=` (exactly one) or `?ids=a,b`; returns `{ images, setWarnings, setNotes }` |
| `POST /` | multipart: `image` (≤ 5 MB, JPEG/PNG/WebP/GIF/AVIF) + `productSlug` \| `draftKey` + optional `label`. `uploadLimiter` applies here only |
| `GET /:id` | one image (404 across workspaces) |
| `GET /:id/file/:kind` | `original` \| `cutout` \| `neutral` bytes, private/no-store |
| `PATCH /:id` | `label`, `isPrimary`, `accepted`; `crop: {x,y,width,height}` re-runs processing, `crop: null` clears it |
| `POST /:id/reprocess` | retry, optionally with a corrected crop; the original is re-read, never rewritten |
| `PATCH /order` | `{ ids: [...] }` — the whole ordered list; a stale list is refused rather than half-applied |
| `POST /attach` | `{ productSlug, productId?, ids?, draftKey? }` — hands a draft's accepted set to a saved product |
| `DELETE /:id` | removes the row and its files |
| `POST /cleanup` | owner-only; deletes never-attached references older than `olderThanHours` (1–720) |

Upload position in the gate order matters and is asserted: a non-member never reaches
`multer`, so an unauthorised upload writes no bytes.

### Validation

Facts are enforced; heuristics only warn.

- **Enforced:** real decodable image (format read from the decoded container, never the
  MIME claim), allowed format, ≤ 5 MB, ≤ 48 MP, long edge ≤ 12 000 px, non-empty,
  readable dimensions. Failures are `422` with a specific code (`UNREADABLE_IMAGE`,
  `UNSUPPORTED_FORMAT`, `IMAGE_TOO_LARGE`, `EMPTY_FILE`).
- **Warned (wording is deliberately hedged):** “This image appears too blurry for
  reliable 3D reconstruction.”, “This image has very low contrast…”, “This looks like
  the same file as reference N — it will not add a new angle.”, “The product may be
  cropped too tightly.”, “This image may contain multiple products.”, “Product edges
  could not be isolated accurately.”, “These images may show different products.”, plus
  set-level advice such as “A single reference works, but a second view (side or back)
  materially improves 3D reconstruction.” Low long edge (< 500 px) is reported too.
- **Noted, not warned:** specks ignored, pinhole gaps filled, an enclosed loop left
  transparent, a PNG with no transparency, engine fallback, edge decontamination.

### Outputs

Both derived assets are PNG. The cutout has a genuine alpha channel and soft,
anti-aliased edges (the mask is feathered, then the ramp is remapped so the core stays
opaque); the working resolution is capped at 1600 px on the long edge and excess
whitespace is trimmed to the foreground bounding box plus 4 % padding. The neutral
preview composites the cutout over one constant colour, `#F5F2ED`
(`NEUTRAL_BACKGROUND`), so every reference in a set is presented identically for
comparison downstream.

---

## Review UI

`components/admin/ReferenceImageStudio.jsx` (mounted from
`AdminCreateProductPage.jsx` and `AdminProductDetailPage.jsx`):

- drag-and-drop **and** a multi-select file picker; per-file upload progress (the only
  XHR-backed transport, `postForm`), queue with retry;
- thumbnails with remove, replace, reorder (drag, persisted through `PATCH /order`) and
  **primary reference** (promoting is server-side and cannot leave a set with none);
- side-by-side **original** vs **cutout** vs **neutral** preview, with dimensions,
  confidence, engine/model and the file's SHA-256 where relevant;
- the per-image status pill (`UPLOADING` → `PROCESSING` → `READY` / `NEEDS_REVIEW` /
  `FAILED`), warnings and notes, retry-processing, and a crop editor that re-runs
  processing on the original;
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
   `3D_PROVIDER=meshy` and `MESHY_API_KEY` are set. `MESHY_API_KEY` alone does nothing;
   `3D_PROVIDER=meshy` without a key is a refusal. A local failure is **never** followed
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
        │  read from the PRIVATE reference root, cutout first
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

Generated media lives under `THREE_MEDIA_ROOT` (default `backend/uploads/3d-media`),
never in a served public folder and never on the CDN, and the same rules as Phase 1 hold:
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
2. set `3D_PROVIDER=meshy` **and** `MESHY_API_KEY` in `backend/.env` — the server's own
   environment, never a frontend variable;
3. restart the API and check `GET /api/3d/provider` as a staff member: it should report
   `available: true` and pass its own health probe. The studio then shows
   "Meshy 7.1 (hosted, metered)" and warns that each generation bills the account.

**Local provider (preferred, no recurring cost):** run a real engine (TRELLIS.2, TripoSR,
or your own) on a Linux + NVIDIA host, give it the `submit / status / download / cancel`
interface documented at the top of `services/3dModelProvider.js`, and point `3D_PROVIDER`
at that worker. The reason the default build reports is written for exactly this reader.

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

`original` / `cutout` / `neutral` asset metadata (dimensions, format, alpha, bytes,
sha256), `crop`, `processing.engine` / `model` / `modelLicence` / `metrics` /
`foregroundBox` / `durationMs`, `validation` (sharpness, contrast, edge mean, signature),
`warnings`, `confidence`, `order`, `isPrimary`, `accepted`, `status`, `productSlug` /
`productId`, and the workspace.

Phase 2 consumes exactly one thing from that shape: **`accepted: true`**, and prefers the
`cutout` over the `original` because a busy background measurably degrades the mesh. An
unaccepted or foreign reference is **refused** (422) rather than silently dropped —
generating from material a person explicitly did not accept is what Phase 1's review step
exists to prevent.

---

## Testing

`backend/scripts/reference-image-smoke.mjs` — `npm run test:references`, 111 assertions,
its own server (port 4126) and its own `Flora-Alchemy-Test-ReferenceImages` database,
which it drops on the way out. It generates its own images with `sharp` (no fixtures
committed) and covers:

- **§A–§C** one photo, several photos of one product, a flyer with headline text, a
  busy/coloured backdrop, a genuinely transparent PNG, an oversized/corrupt/unsupported
  file, duplicate detection, set-level advice;
- **§D** bad input: corrupt bytes, bad MIME, oversized upload, empty file;
- **§E–§G** the review step: crop re-processing, retry after failure, delete, reorder,
  primary promotion, accept;
- **§H** the product handoff: create carries the accepted set, drafts are cleaned up,
  rename migrates, delete removes rows and files, an unknown id does not break a save;
- **§I** tenancy and auth: cross-workspace 404s (reads, writes, deletes, bytes), and the
  same for a customer, an anonymous caller, a permission-less handler (403 before the
  body is parsed) and a suspended workspace; no payload leaks a path or an id;
- **§J** the licence guard and engine wiring: `bria-rmbg` is refused (even when
  configured), unknown models are refused with the known list, `rembg` requested without
  an install answers `503 BGREMOVE_UNAVAILABLE` instead of substituting silently, and
  the provider drives rembg's library API rather than its CLI.

`BGREMOVE_PROBE=0` is pinned in the suite so “rembg is not available” is a statement
about configuration rather than about the machine — installing rembg per this document
must not turn the suite red.

The suite proves the deterministic engine end-to-end. The `rembg` engine cannot be
proven there (it needs Python ≥ 3.11, < 3.14 and a ~176 MB download), so its wiring and
its failure modes are asserted in-process and the real network path is left to a machine
where the operator has installed it; that gap is a limitation, not a passing claim.

Frontend verification is `npm run build` plus the browser suite and the manual pass
described in [TESTING.md](./TESTING.md); there is no frontend unit runner in this
project.

### What the manual browser pass actually checked (2026-10-14)

Driven through the admin portal against the local dev stack, with real files (a
plain studio shot, a busy/coloured backdrop, a flyer, and a replacement shot):

- upload of three files at once, with per-file progress and a polled
  `PROCESSING → READY` / `NEEDS_REVIEW` transition — the plain photo and the flyer
  came back `READY`, the busy backdrop `NEEDS_REVIEW` with "This image may contain
  multiple products." and "Product edges could not be isolated accurately.", plus
  the set-level "These images may show different products";
- every preview rendered from a real authenticated blob: the two tiles per card
  loaded at their true dimensions, the cutouts measured 88–95 % fully transparent
  pixels with `rgba(0,0,0,0)` corners (the background really was removed), and the
  neutral preview's corner pixel was exactly `rgb(245, 242, 237)`;
- **the original survived processing byte-for-byte**: the served original's SHA-256
  and byte count were identical before and after a crop re-process, while the
  cutout changed from 900×900 to 650×650;
- crop correction (tighten → apply) took the busy image from `NEEDS_REVIEW` to
  `READY` at 80 % confidence; retry re-ran processing with `attempts` incrementing;
- reorder, primary promotion and replace behaved as documented — replacing a card
  left the set size unchanged and put the new photograph (15 472 bytes) in the old
  slot (previously 15 153 bytes);
- accept-all then **Save Product** created the product through the ordinary form,
  and the edit page for the saved product listed the same three images (same byte
  sizes, primary flag intact) — i.e. the accepted set is retrievable later and the
  existing product workflow is unaffected;
- mobile at 390×844: the grid collapses to one column with no horizontal overflow
  (document `scrollWidth` equals the viewport) and the original/cutout tiles stay
  side by side inside the card;
- **two real defects were found this way and fixed** — an unimported icon that
  white-screened the whole studio on first render, and duplicate React keys from a
  warning the engine and the heuristics both emitted (see
  [MEMORY.md](./MEMORY.md#important-historical-fixes)).

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

1. **Still opt-in.** The default is `3D_PROVIDER=local_unavailable`. Nothing selects the
   local worker on the operator's behalf, and `backend/.env` decides it — not a request.
2. **Never a paid fallback.** A local failure fails the job; Meshy is reachable only
   with `3D_PROVIDER=meshy` **and** `MESHY_API_KEY`.
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
| `iou` | Intersection over union of the model's projected silhouette and the cutout's, after removing **translation and uniform scale only** |
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

A low score against a *doubtful* cutout is evidence about the reference as much as
about the model, so the gate records where the reference came from (engine, model,
confidence, Phase 1 warnings, how many disconnected specks had to be dropped) and
changes its behaviour accordingly:

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
