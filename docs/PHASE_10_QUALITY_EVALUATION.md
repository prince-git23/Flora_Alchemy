# Phase 10 — Quality evaluation: texture baking, multi-view, and the geometry that remains

**Status:** evaluation complete. The verification below produced **no pipeline change**, and
this document is the record of why. TripoSR with vertex colours remains the verified
fallback; the single-view limitation is unchanged and still stated everywhere it is shown.

Baseline product: `peony-eucalyptus-bouquet`, accepted reference
`peony-eucalyptus-bouquet-phase9-23460-reference.jpg` (31,717 bytes,
sha256 `2560aece…5711d7`) — the same photograph, the same product and the same prepared
input as the shipped candidate. Nothing here was measured on a stand-in.

---

## 1. Baseline reproduction

The inference input was regenerated through the **shipped** function
(`tools/3d-worker/worker.py: harden_reference`), not a hand-made crop, and had to match
the shipped job's recorded measurements before the comparison was allowed to run:

| fact | shipped record | re-measured | drift |
|---|---|---|---|
| segmenter | rembg `isnet-general-use` | rembg `isnet-general-use` | — |
| `fgFraction` | 0.1285 | 0.1285 | none |
| `crop` | `[138, 17, 366, 286]` | `[138, 17, 366, 286]` | none |
| `cropAspect` | 0.8476 | 0.8476 | none |
| inference input | 316 px square | 316 px square | none |

Hardware: NVIDIA GeForce RTX 4050 Laptop GPU, 6,141 MiB. TripoSR peak during the run was
**2.50 GB** process-side and **5,365 MiB** device-side — the engine fits the 6 GB card with
little headroom, which matters for §4.

---

## 2. A/B — vertex colour vs the official texture bake

Both candidates came from the **same encode** (one 15.4 s encode, two decodes) so only the
export path differs. `B` used `tsr.bake_texture.bake_texture(1024)` — the official bake
path, not a home-grown atlas.

| fact | A — vertex colour (shipped) | B — texture-baked 1024 |
|---|---|---|
| faces | 104,308 | 104,308 |
| surface area | 1.6262 | 1.6262 |
| extents | 0.6831 × 0.8795 × 0.7196 | identical |
| vertices | 52,142 | 83,761 (split for UV seams) |
| watertight | **yes** | **no** |
| GLB bytes | 2,713,168 | 5,435,932 |
| decode time | 9.8 s | 69.3 s |
| attributes | `COLOR_0`, `NORMAL`, `POSITION` | `TEXCOORD_0`, `NORMAL`, `POSITION` + 1 texture |

Geometry is identical by construction (same decode); what differs is the colour.

**Colour, six orthographic views** (share of foreground pixels with saturation > 0.25 /
mean saturation / mean luminance):

| view | A | B |
|---|---|---|
| front | 0.47 / 0.24 / 0.40 | 0.34 / 0.22 / 0.42 |
| back | 0.13 / 0.15 / 0.49 | 0.38 / 0.22 / 0.41 |
| left | 0.56 / 0.26 / 0.38 | 0.42 / 0.24 / 0.40 |
| right | 0.14 / 0.14 / 0.50 | 0.35 / 0.22 / 0.41 |
| top | 0.46 / 0.24 / 0.37 | 0.41 / 0.23 / 0.40 |
| bottom | 0.24 / 0.19 / 0.43 | 0.40 / 0.23 / 0.42 |

The aggregate numbers look like a modest difference. The renders do not: **B is confetti.**
The bake had to fill **481,943 of 1,048,576 texels (46 %)** from the nearest coloured texel
because the atlas was never rasterised there, and the colour it does have is splatted
per-texel rather than continuous. On the front it desaturates the peonies (0.47 → 0.34);
on the back it *invents* saturation the product does not have (0.13 → 0.38), which is worse
than being flat — it makes a wrapped back look floral.

**Verdict: A.** Candidate B is rejected on measured colour, not on preference: it loses
watertightness, doubles the bytes, costs 7× the time, and smears colour in both directions.
No texture-bake path is enabled anywhere in the pipeline, and this is the evidence for why.

---

## 3. Flower heads, petals, wrapping, top and back — measured

Measured on candidate A from the stored GLB (wall thickness by inward ray cast, 2,500
surface samples) and the six rendered views.

**Body.** 1 connected component, watertight, volume 0.0911, surface area 1.6262,
depth ratio 0.777. Thickness relative to the largest extent: median **0.324**, p05 0.038,
p95 0.651. Thin material (< 2 % of the extent) is **0.36 %** of the sampled surface and
sits in **7** distinct cells.

| band | median rel. thickness | p05 | thin share |
|---|---|---|---|
| flower head (y ≥ 0.70) | 0.287 | 0.032 | **0.62 %** |
| middle (0.30 < y < 0.70) | 0.469 | 0.103 | 0.26 % |
| wrap / base (y ≤ 0.30) | 0.130 | 0.034 | 0.00 % |

This is a **solid body, not a shell** — the defect Phase H3 removed has not returned. The
thin material is the leaf/petal collar at the top, exactly where the photographs put it, and
there is none at the base, where the wrapping is.

**Structure per view** (silhouette coverage / aspect / convexity / boundary roughness /
radial peaks, then flower-colour clusters, their share of the foreground, and the largest
cluster's share of that colour):

| view | coverage | aspect | convexity | roughness | peaks | clusters | flower share | largest |
|---|---|---|---|---|---|---|---|---|
| front | 0.140 | 0.772 | 0.713 | 0.222 | 2 | 3 | 0.231 | 0.762 |
| back | 0.140 | 0.772 | 0.713 | 0.222 | 2 | 8 | **0.015** | 0.443 |
| left | 0.130 | 0.815 | 0.741 | 0.240 | 1 | 6 | 0.129 | 0.774 |
| right | 0.130 | 0.815 | 0.741 | 0.240 | 1 | 8 | 0.086 | 0.723 |
| top | 0.138 | 0.947 | **0.966** | **0.069** | 4 | 3 | 0.121 | **0.793** |
| bottom | 0.138 | 0.947 | 0.966 | 0.069 | 4 | 4 | 0.171 | 0.865 |
| **reference photo** | 0.128 | 0.779 | 0.710 | 0.223 | 2 | **5** | **0.209** | **0.554** |

The colour band (hue 330–20°, saturation > 0.20) was **calibrated on the photograph itself**
before being applied: the reference foreground's hue distribution is 37.5 % at 0–20°, 47.3 %
at 20–40°, 10.2 % at 40–60° — warm rose peonies against cream wrap and sage foliage.

Three findings, in order of how much they matter:

1. **The amount of flower colour is right; its structure is not.** Front flower share
   0.231 against the photograph's 0.209 (+10 % relative — within measurement noise for two
   different renditions). But the photograph separates that colour into **5** regions with the
   largest holding **55 %**, while the model merges it into **3** with one holding **76 %**.
   That is the quantified form of "the individual flowers are not preserved": the peonies are
   not lost, they are *fused*.
2. **From above the heads are a single mass.** The top silhouette is the most convex and
   smoothest of all six views (0.966 convexity, 0.069 roughness) and its flower colour is
   79 % one region. A real bouquet's top is scalloped by individual domes. The engine never
   saw the top — it cannot be expected to invent it, and it does not.
3. **The back reads as wrapping.** Flower share 0.015 — no floral colour bleeding through,
   which is the correct behaviour for a wrapped stem and ribbon. This is the one view where
   the model agrees with the product for the right reason.

**Front silhouette against the photograph's own mask: IoU 0.907**, aspect 0.772 vs 0.779,
convexity 0.713 vs 0.710, roughness 0.222 vs 0.223. A single-image reconstruction copies the
outline it was given, and here it copies it well. **This says nothing about the other five
views** and is not offered as evidence that the object is right.

> The front/back and left/right aggregate rows are identical because they are mirror pairs
> and every aggregate used (coverage, aspect, convexity, roughness, peak count) is
> mirror-invariant. The masks themselves differ: front↔back IoU 0.7245, left↔right 0.4718.
> Do not read the identical rows as "the back equals the front".

---

## 4. A genuine multi-view engine — evaluated, and not runnable here

**ReLi3D** (`Stability-AI/ReLi3D`, Stability AI, ICLR 2026) was verified against its own
repository rather than a summary:

- **Input contract:** each object needs `transforms.json` with a per-view
  `transform_matrix` (camera-to-world), `camera_fov`, and `rgba/<view>.png` at 512².
  **Camera poses are mandatory.**
- **Output:** UV-unwrapped textured mesh + PBR materials + predicted illumination.
- **Licence:** Stability AI Community Licence — free for organisations under USD 1M annual
  revenue, enterprise licence above. (Not a blanket non-commercial block; recorded here
  accurately because the earlier note was imprecise.)
- **Environment:** Python 3.10, two native extensions to compile (`uv_unwrapper`,
  `texture_baker`), checkpoint from a gated Hugging Face repo, no documented ≤ 6 GB VRAM mode.

**Why it was not executed:** we do not have camera poses, and we cannot manufacture them
honestly. The accepted references are ordinary photographs of a product; the supplied
12-panel sheet is a *render sheet of one product*, not a capture set with known cameras.
Fabricating a `transforms.json` would mean inventing the one input the engine's quality
depends on — the reconstruction would be measured against a lie. **The blocker is the input
contract, not the GPU**, so no VRAM measurement on this card is claimed.

**Hunyuan3D-2mv** had already been executed and measured in Phases D/D2
(`PHASE_D_REPORT.md`, `PHASE_D2_REPORT.md`): the multi-view path runs, but our own gate judged
the geometry poor, the materials were missing, the licence constrains commercial use, and it
too was being fed a synthesised view set rather than a capture. Same blocker, same verdict.

**Conclusion:** no genuine multi-view candidate can be executed on this product with the
inputs that exist. TripoSR stays the verified fallback, `inputMode` stays `single_view`, and
no UI or document may imply the stored views are used jointly.

---

## 5. What was deliberately *not* changed

- **Thresholds.** No band was moved. Phase 6 records that three genuine models all scored
  REVIEW against an angled photograph and that the bands are provisional; tuning them to this
  product would launder a limitation into a pass.
- **No texture baking by default.** §2 is the evidence.
- **No automatic viewpoint inference.** The measurement now gives a *reason*, not just a rule:
  silhouette is mirror-invariant (front↔back aggregate metrics are identical by construction),
  so any classifier built on outline would have to guess between front and back. The declared,
  human-set viewpoint label (`ProductReferenceImage.label` / `viewAngle`) stays the only
  source of viewpoint truth.
- **No new gate metric for colour-region structure.** The §3 cluster measurement needs a
  *rendered, shaded* projection. The server-side gate projects geometry (silhouettes), and it
  has no renderer. Adding one to compute a new band from a single product is not justified —
  the number is recorded here as evaluation evidence instead.

---

## 6. Review workflow — verified present, not rebuilt

The all-view comparison the brief asks for already ships, and was checked in the working tree
rather than re-implemented:

- the **reference-vs-render strip** (`data-testid="reference-compare"`) shows every accepted
  photograph with its server-reported role — *consumed by the engine*, *refused*, *sent*, or
  merely *stored* — read from `providerExtra.metrics.inputUsed` and `candidateRejections`,
  never inferred by the client;
- the **named camera presets** (front, back, left, right, top, bottom and the three-quarter
  default) framed to the complete model, plus drag/zoom and Reset;
- **orientation** correction that applies to the model everywhere it is shown;
- **material state** spelled out in words: colour per vertex with no texture map, a PBR
  material with no map, or nothing stored;
- the **colour section** from Phase 7 and the **quality gate** panel with its per-metric
  values, stale-verdict warning, review acknowledgement and administrator override.

A better viewer makes these defects easier to see; §3 is what the reviewer will now see when
they look from above.

---

## 7. Evidence index

Outside the repository (measurement workspace, `~/flora-3d/phaseD`):

| file | what it holds |
|---|---|
| `bench_triposr_bake.py` | the A/B harness (shipped worker + official bake path) |
| `out/bench-phase10-ab.json` | A/B record: input reproduction, mesh facts, container facts, VRAM |
| `out/phase10-ab-A-vertex-color.glb` | candidate A bytes |
| `out/phase10-ab-B-baked-1024.glb` | candidate B bytes |
| `six_views_colour.py`, `out/views-phase10-A|B/` | six orthographic colour renders per candidate |
| `out/views-A.json`, `out/views-B.json` | per-view colour statistics |
| `measure_phase10.py` | the §3 measurement (thickness, thin features, structure) |
| `out/phase10-geometry.json` | the §3 record + the reference's own calibration |
| `out/phase10-input/` | the reproduced inference input, the reference mask, the original |

In the repository: `audit/phase4-real-generation/peony-eucalyptus-bouquet-phase9-23460.*`
(the shipped candidate and its provenance) — untouched.

## 8. Limitations

- **One product.** Every structural number here is this bouquet; none of it is a threshold.
- **No camera poses**, so the front silhouette comparison is approximate, and no other view
  can be compared with any photograph at all.
- **316 px inference input**, so fine petal detail is below the engine's resolution before
  reconstruction even starts.
- **Orthographic projection vs photograph** — the comparison family Phase 6 already recorded
  as the reason a genuine model scores REVIEW.
- The gate's own silhouette measure uses the worker's 128 px mask and is coarse by
  construction; the 0.907 above is a 256 px bbox-normalised comparison and is not the gate's
  number.
