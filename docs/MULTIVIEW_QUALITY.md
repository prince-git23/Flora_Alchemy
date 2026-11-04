# MULTI-VIEW QUALITY — silhouette evidence, fragmentation, colour and ReLi3D readiness (Phase 13)

This document records what Phase 13 changed, what it measured, and what remains
genuinely blocked. Every number below was produced on the owner's machine
(RTX 4050 Laptop, 6 GB, driver 591.91) from the repository's own code paths; the
commands that reproduce them are in each section.

Summary of the position:

| Question | Answer |
|---|---|
| Does Hunyuan3D-2mv now have genuine silhouette evidence? | **Yes** — one bounded PNG per named view, produced from the photographs themselves by the shipped segmentation, carried with the photograph's SHA-256. |
| Is the 59-component fragmentation understood? | **Yes** — it is a 99 %-of-surface body plus 58 sub-0.1 % pieces; the distribution is measured per piece, not inferred from the count. |
| Is the geometry acceptable? | **No.** The verdict stays `REVIEW`; no threshold was raised, no pieces were deleted. |
| Is there a colour/texture strategy? | **Yes, as a plan with measured constraints** — not implemented, and not implementable on this GPU. |
| Is ReLi3D ready? | **No** — CUDA toolkit, MSVC, checkpoint and calibrated captures are all absent. The adapter stays disabled. |
| Is TripoSR still working? | **Yes** — unchanged single-image path; its suite passes. |

---

## 1. Silhouette evidence (Workstream 1)

### What the gate could see before

The quality gate compares a projection of the mesh with ONE mask: the accepted
reference's own alpha, or — when the reference is an ordinary opaque photograph —
the worker's mask of the single photograph TripoSR consumed. Hunyuan already
computed a foreground mask per view to prepare its inference input, but threw it
away, so a three-view reconstruction could only ever be compared against one
frame, and the report could not say which mask it had used.

### What it sees now

`tools/3d-worker/engines/hunyuan3d.py` keeps the mask it already computed, packs it
to a **bounded 1-bit PNG at 128 px** (the same canonical size the TripoSR path
uses), and attaches, per view:

| Fact | Why it is there |
|---|---|
| `referenceId` | which reference row the mask belongs to |
| `slot` | the named view it was prepared for (`front`/`left`/`back`/`right`) |
| `width`, `height` | the source photograph's dimensions |
| `inputSha256` | the photograph's own hash — the mask is tied to those bytes |
| `maskSource` | `source-alpha` or the segmenter actually used (`rembg-isnet-general-use`) |
| `maskVersion` | `phase13-1`, so a future change to the packing is visible |
| `maskPngSha256`, `maskPngBytes`, `maskPx` | the evidence's own integrity and size |

**Measured size** (real masks of the three supplied photographs): 423 / 448 / 439
bytes per PNG at 128 px, 1,664 base64 characters for all three. A three-view
result's whole diagnostics payload is 5,288 characters of JSON — 7,074 once
URL-encoded, which is why the agent's result-stats ceiling moved from 6,000 to
12,000 characters (`RESULT_STATS_LIMIT`). At the old ceiling the evidence would
have been dropped silently; at 12,000 it fits well inside the 16,000-character
request limit the backend enforces.

### What is measured, and what is not

These are ordinary photographs. **No calibrated camera pose exists for any of
them**, and none was invented. So:

- **The anchor view** (`front` when the set has it, else the first supplied slot)
  is the mask the verdict compares against; it is the only one that counts.
- **Every other view** is measured against the mesh's *best-matching* orthographic
  projection and reported as a **consistency check**, with
  `countsTowardVerdict: false`, `alignment: "best-match-orthographic"` and an
  explicit `uncalibrated: [{slot, reason: "NO_CALIBRATED_CAMERA_POSE"}]` entry.

`report.evidence` therefore discloses: the masks used and where each came from,
which views were measured, the alignment method, and the reason each unmeasured
view is unmeasured. `report.silhouette.views[]` carries, per view, IoU, aspect
error, coverage delta, contour distance and the projection it was compared with.

Masks are validated before they are believed (`readMaskEvidence`): the slot must be
a real named view, the reference id must belong to the job's own reference set, the
bytes must be a PNG under 200 KB, and the claimed SHA-256 must equal the SHA-256 of
the bytes that arrived. Anything else is dropped, and the report says one fewer
view was available rather than attributing a mask to a photograph it may not have
come from.

### What the first real three-view run measured

The stored evidence for the shipped candidate (asset `6aeb6fbca9d3a831dbc02ab3`, GLB
`9555d0dc…1315a5`, 21.2 MB):

| View | Mask PNG | IoU | Aspect error | Coverage delta | Counts toward the verdict |
|---|---|---|---|---|---|
| front (anchor) | `bb86e135…b7aa` | **0.8496** | 0.0663 | 0.0115 | **yes** |
| left | `886a3904…e6a4` | 0.6595 | — | — | no (`NO_CALIBRATED_CAMERA_POSE`) |
| back | `94dd41ad…0db1c` | 0.8291 | — | — | no (`NO_CALIBRATED_CAMERA_POSE`) |

The best-matching projection was `right` with a margin of only **0.0131** over the
runner-up, so the report carries `SILHOUETTE_VIEW_AMBIGUOUS` beside the match: the
model's own frame is an assumption, and the gate says so instead of presenting
0.85 as a camera-resolved fact. Left is the weakest view — the same pattern the
standalone comparison tool measures for every model on this capture.

### The defect this run exposed (and why the version is `phase13-2`)

A worker mask is a **1-bit greyscale PNG with no alpha channel**. The gate's
cutout decoder (correct for a photograph cutout) reads the ALPHA channel; sharp's
`ensureAlpha()` fills alpha with 255 on an opaque mask, so every mask decoded as a
**solid full frame**. The first three-view reports therefore compared the mesh
against a square: all three views returned the identical IoU (0.6057), and the
"reference coverage" was 0.815 — the fit fraction, not the product.

`decodeMaskPng()` now reads the GREY LEVEL, refuses a mask covering more than 98 %
of the frame (`MASK_FULL_FRAME`-equivalent, in words), and is used for the per-view
evidence and for the worker-mask silhouette. The same fix changes the anchor
measurement: 0.6057 (against a square) → **0.8496** (against the bouquet's own
mask), which is why `ASSESSMENT_VERSION` is **`phase13-2`** and why both stored
candidates are re-measured. The regression is pinned in `test:3d-quality`:
"an alpha-less mask PNG is read as the shape it draws", "two different masks do not
normalise to the same silhouette", "a mask that covers the whole frame is refused".

---

## 2. Fragmentation (Workstream 2)

### Why 59 components

The 50-step model is **one body holding 98.98 % of the surface** plus isolated
pieces. Measured per component by `summariseComponents` (faces, area, signed-volume
proxy, bounding box, extents, centroid, distance from the main body, and whether the
piece is itself closed), banded by share of total surface area:

| Model | Triangles | Components | Largest share | Substantial (≥5 %, or ≥25 % box with ≥0.5 % area) | Below 0.1 % | Watertight (union) |
|---|---|---|---|---|---|---|
| Hunyuan 50 steps | 927,870 | 60 | 0.9898 | 1 | 57 | **no** |
| Hunyuan 5 steps | 561,270 | 1,806 | 0.6992 | 1 | 1,771 | yes |
| TripoSR baseline | 110,202 | 35 | 0.9866 | 1 | 31 | yes |

The stored report's own bands for the shipped 50-step candidate (59 components),
with the exclusive ranges the report now uses — the first version's bands were
filtered `share >= min` and were therefore cumulative, so "56 pieces below 0.1 %"
summed to a share of 1.0:

| Band | Pieces | Share of surface |
|---|---|---|
| ≥ 5 % | 1 | 0.9898 |
| 1 % – 5 % | 0 | 0 |
| 0.1 % – 1 % | 2 | 0.0037 |
| < 0.1 % | 56 | 0.0066 |

(The tool counts face-adjacency components of the stored mesh; the gate reported 59
for the same file — the difference is a single isolated degenerate face that the
gate's triangle-validity check skips. Both are recorded rather than reconciled away.)

So the count is not "59 flower parts" and not "59 random blobs": it is a body plus
a long tail of pieces each under 0.1 % of the surface. At five steps the same
pipeline produced 1,806 pieces with the body at only 70 % — which is what an
under-converged shape looks like.

### What the analysis can and cannot say

It can say how big each piece is, where it sits, and whether the piece is closed.
It **cannot name a piece** — whether a separated component is a bloom, a leaf, a
stem or an artefact is a visual question. The report states this limit in
`report.fragmentation.limits` instead of implying a judgement.

Three things were deliberately NOT done:

- Not one component was deleted to lower the count.
- `limits.maxComponents` stays **8**; the Phase 13 suite asserts it (a fragmented
  model must not be made to pass by moving the gate).
- No claim of watertightness is made for a fragmented mesh. `report.fragmentation.closed`
  counts pieces that are individually closed and says, in the same object, that
  separate closed shells do not make the union watertight.

---

## 3. Colour and material strategy (Workstream 3)

Today's output is **shape only**: `materialState` is `none` on the Hunyuan exports,
there is no texture map and no UV set, and the viewer's backdrop is CSS. Nothing in
this phase invents colour.

Two future strategies, compared on measured ground:

### A. Texture generation on higher-memory hardware

Hunyuan3D-2's texture stage is a separate pipeline (`Hunyuan3DPaintPipeline`).

- **VRAM:** shape inference already peaks at **5,137 MiB of 6,141 MiB** at octree
  256 on this card — about 1 GB of headroom. The paint stage bundles its own
  diffusion model and is documented by the project's own tests in the 16 GB class.
  Running it here risks the shape path, which is the one thing that currently
  works, so **it was not attempted** and no VRAM figure is claimed.
- **Feasibility:** requires a machine with ~24 GB VRAM. Output would be a textured
  GLB with a UV atlas.
- **Complexity:** low in code (one extra pipeline call, one extra artifact, one new
  validation rule), high in hardware.
- **Quality risk, measured in Phase 10:** the official bake of a reconstruction was
  compared A/B against the vertex-colour export. The bake doubled the bytes
  (5.44 MB vs 2.71 MB), cost 7× the time (69 s vs 9.8 s), broke watertightness at
  the UV seam (83,761 verts) and — after 46 % of the atlas was filled from the
  nearest texel — turned the bouquet into confetti: front saturation 0.47 → 0.34
  while the **back invented saturation 0.13 → 0.38**, i.e. a wrapped back renders as
  if it were floral. That is evidence about baking a *single-view* reconstruction,
  and it is the reason a texture is not treated as an automatic improvement.
- **Licensing:** the model weights are Apache-2.0 (Tencent Hunyuan3D-2). Any paint
  stage must be checked on the same licence test as the shape stage before it can
  ship.

### B. Image-based texture reprojection from real captures

Project the accepted photographs back onto the mesh through calibrated cameras and
blend.

- **Feasibility:** the honest blocker is the same one ReLi3D has — this pipeline
  stores ordinary photographs with **no camera pose**, so reprojection would need a
  capture rig (turntable + fixed camera, or a measured marker board) and a pose
  solve before any texture could be projected.
- **VRAM:** none; this is CPU geometry work.
- **Complexity:** high — pose estimation, visibility per texel, seam handling, and a
  new validation path (a wrong pose paints the wrong petal with no measurable error).
- **Quality:** potentially the best of the two, because the colour comes from the
  real product rather than from a diffusion model's guess.
- **Licensing:** the photographs are the owner's; the pose solver's licence would
  need checking.

**Recommendation:** (A) only on a higher-memory machine and only with the Phase 10
A/B re-run against the new engine's own bake; (B) after a calibrated capture set
exists, which is the same prerequisite ReLi3D has. Neither is implemented, and no
vertex colour or texture has been added to any stored asset.

---

## 4. ReLi3D readiness (Workstream 4)

Measured on the machine that produced the Phase 12/13 models:

| Requirement | Status | Evidence |
|---|---|---|
| CUDA toolkit (`nvcc`) | **absent** | `nvcc --version` not found on PATH |
| Native compiler (MSVC) | **absent** | no Visual Studio installation at either standard path; `cl.exe` unavailable |
| Native extension build | **not attempted** | requires the two above |
| Checkpoint integrity | **absent** | no `RELI3D_HOME`, no entrypoint, no checkpoint on disk |
| Memory | **unknown** | the documented requirement is above this card's 6 GB; never measured here |
| Calibrated camera capture | **absent** | no capture set, no poses |
| `transforms.json` validation | **implemented, unused** | `localEngineAdapters.buildTransformsJson` refuses a frame without a complete pose; no real set has been through it |

The adapter's own health detail names the missing `RELI3D_HOME` / entrypoint /
checkpoint / config pieces. **The adapter existing is not installation**, and the
capture registry keeps `evidence: unverified` for the engine.

Deliberate refusals: no pose was synthesised, no `transforms.json` was fabricated
from image order, and no silhouette-matching was used to *guess* a camera position.
A pose guessed from an outline is a lie the quality gate would then certify.

**Recommendation to unblock it:** a Linux build machine (the official build path is
CUDA + GCC) with a 24 GB-class GPU, CUDA 12.x toolkit and the checkpoint fetched
with its hash recorded; plus a physical capture protocol — 12–24 views around the
product on a turntable with a fixed camera, a measured board for scale, and poses
recorded at capture time (`manual` or `imported` only). Until that capture set
exists, ReLi3D cannot be compared with anything, and no document should imply it
was.

---

## 5. Reproducible visual comparison (Workstream 5)

`tools/3d-worker/compare_models.py` renders each model front/back/left/top as an
orthographic **silhouette** (flat, 1 px outline — no material, colour or lighting is
rendered or implied), measures the same geometry facts the gate measures, computes
silhouette IoU against the worker's own masks, draws a per-component image with the
body underneath and satellites on top, and writes a `manifest.json` carrying the
SHA-256 of every input and every output.

Front silhouettes, measured against the same worker mask the pipeline produced:

| Model | Front IoU | Back IoU | Left IoU |
|---|---|---|---|
| Hunyuan 50 steps | 0.9406 | 0.8815 | 0.7698 |
| Hunyuan 5 steps | 0.6469 | 0.6720 | 0.5404 |
| TripoSR baseline | 0.6489 | 0.6910 | 0.5858 |

Read these as outlines, not as camera-resolved agreement: the mask comes from one
photograph and the model is compared with its best-matching projection. The left
view is systematically lower for all three models, which is what an unposed
photograph and a reconstruction's invented depth look like — not evidence about a
particular engine's accuracy.

Why the front/back IoUs are nearly identical for the two Hunyuan models is a fact
of these meshes (their back is the wrapping, and the projection of a wrapping is
close to its front outline), not a measurement artefact.

**ReLi3D does not appear in the comparison**, because no ReLi3D output exists. The
tool refuses a `--reli3d` argument outright, and the manifest states the absence.

---

## 6. Durable evidence (Workstream 6)

The Phase 12 candidate lived in a temporary media root (`%TEMP%\phase12-pass-*`).
Phase 13 copies, into `~/flora-3d/phase13/durable/` (outside the repository, so no
model binary or private photograph is committed) — for the shipped run, job
`6aeb6e957f69e748c8dd7795`, candidate `6aeb6fbca9d3a831dbc02ab3`, GLB SHA-256
`9555d0dc29bc8302b53542f74fe286e47924b4923516527755ba76125e1315a5`, 22,246,312
bytes, verified equal to `asset.storage.glb.sha256`;

- the candidate and pipeline GLBs, with their SHA-256;
- the job, reference and asset rows as JSON;
- the quality report, including `fragmentation` and `evidence`;
- the extracted per-view masks and their hashes;
- a manifest that states what was verified against the database and what was not.

Verification is a re-hash of the stored bytes against the SHA-256 the database
recorded for that storage key. The temporary root is left in place while the
development database still points at it — deleting bytes a row references would
make the development asset unreadable, and "durable" is about having a second
verified copy, not about breaking the first.

---

## 7. What to run

```bash
# backend
npm test                                  # full sweep
npm run test:3d-quality                   # the gate, incl. §G Phase 13 checks
npm run test:engines                      # multi-engine contracts
npm run test:capture                      # capture sets / submission plan
npm run test:3d-agent                     # GPU agent protocol
npm run test:3d                           # generation + asset + quality
npm run test:security
npm run test:boot-gate

# python adapter contracts (no GPU, no model)
python -m unittest discover -s tools/3d-worker/tests -q

# the comparison sheet (needs numpy, Pillow, trimesh, shapely, rtree)
python tools/3d-worker/compare_models.py \
  --model triposr=<path>.glb --model hunyuan=<path>.glb \
  --references <dir-with-front/back/left.png> \
  --masks <dir-with-worker-masks> \
  --out <out-dir> --views front,back,left,top
```

`npm run test:3d-quality`, `npm run test:engines`, `npm run test:capture`,
`npm run test:3d-agent`, `npm run test:3d`, `npm run test:security`,
`npm run test:boot-gate`, the full `npm test` sweep, the Playwright suite and the
frontend build were run for Phase 13; the pass counts are in the Phase 13 report.
