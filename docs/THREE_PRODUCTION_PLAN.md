# 3D Studio — Production Plan (Storage + Provider)

_Investigated 2026-10-19. **Nothing in this plan has been purchased, provisioned or
enabled.** The production 3D pipeline is not operational; this is the plan and the
exact approvals required to make it so._

Two independent blockers stand between "code-complete" and "a customer can rotate a
product in 3D":

1. **Durable private media** — reference originals, prepared cutouts and approved
   GLBs live inside the deploy directory, which Render wipes on every deploy.
2. **A reachable generation provider** — the only working provider today is a
   loopback GPU worker (`tools/3d-worker/worker.py`, TripoSR). Render cannot call a
   developer machine's `127.0.0.1`.

Both are configuration decisions with a cost. Neither is a coding gap.

---

## 1. Verified current state

| Dimension | State | Evidence |
|---|---|---|
| Implemented in source | **Yes** — 13 backend modules, 4 frontend components, 22 suites covering references, provider policy, storage, approval, quality gate, public delivery | `npm run 3d:readiness` → `implemented (code) yes` |
| Operational on this machine | **Yes, today** — real TripoSR generation on the RTX 4050: 12.4 s end to end, 478 KB GLB, watertight, 9 398 verts | `npm run test:3d-real -- --require-worker` → generated + measured (gate: REVIEW) |
| Operational in production | **No** — `3D_PROVIDER` unset, no worker reachable, `MESHY_API_KEY` absent | readiness report → `generation provider unavailable` |
| Durable media in production | **No** — `REFERENCE_MEDIA_DIR` / `THREE_MEDIA_ROOT` unset, both roots inside the app tree, reference root not even writable (`EACCES`) | readiness report + `/api/health` → `media.*.durable: false` |
| Reference images in production | **0** | readiness report |
| Generation jobs in production | **0** | readiness report |
| Approved, readable GLBs in production | **0** (0 approved of 0 assets) | readiness report |

The local evaluation is a genuine result, not a fixture: a real catalogue photograph
went through the real Phase 1 cutout, the real job, the real provider, real TripoSR
inference, real container validation and the real quality gate. The gate returned
REVIEW (IoU 0.080) — the documented limitation of comparing an orthographic
projection with an angled photograph, unchanged bands, not a regression.

---

## 2. Blocker A — durable private media

### What to create

One persistent disk on the `flora-alchemy-api` web service.

| Setting | Value |
|---|---|
| Disk name | `flora-alchemy-data` |
| Mount path | `/var/data` |
| Size | **5 GB** (start here — see the estimate below; disks can grow, never shrink) |
| Cost | **$0.25 / GB / month** → **$1.25 / month** for 5 GB, on top of the `starter` compute plan ([Render pricing](https://render.com/pricing), [Persistent Disks](https://render.com/docs/disks)). Confirm the size selector's allowed values in the dashboard — the published docs reviewed here do not state the minimum. |

### Environment variables (set only after the disk exists and is mounted)

```
REFERENCE_MEDIA_DIR=/var/data/flora-alchemy/references
THREE_MEDIA_ROOT=/var/data/flora-alchemy/3d-media
```

`render.yaml` already carries these lines, commented out, with the reason: the
blueprint must not declare `disk:` because a blueprint change creates a **new empty
disk** and the old bytes are not carried over. Create the disk in the dashboard,
then uncomment the two variables and deploy.

### Why 5 GB

| Content | Unit size | Assumption | Total |
|---|---|---|---|
| Accepted reference originals | 1–6 MB | 22 products × 3 images | ~250 MB |
| Prepared cutouts / variants | 0.2–1 MB | 3 per reference | ~65 MB |
| Candidate GLBs (kept for history) | 0.5–3 MB | 22 products × 10 versions | ~600 MB |
| Approved GLBs (one per product) | 0.5–3 MB | 22 products | ~45 MB |

≈ 1 GB today's worst case, ×4 headroom for real photography and version history.
1 GB would work initially and is the usual minimum in the dashboard, but version
history grows without pruning, so 5 GB avoids a second migration.

### Render constraints that must be respected

- Disks require a **paid** instance. `plan: starter` qualifies; a free plan does not.
- A disk is attached to **one** instance — the service cannot scale to multiple
  instances while the disk exists. At this traffic level that is fine.
- Disk-backed services do **not** get zero-downtime deploys: Render stops the old
  instance before starting the new one, so expect a few seconds of unavailability.
- Only paths under the mount survive deploys. Everything else in the filesystem is
  still ephemeral.

### Migration (today: none needed)

Production holds **zero** reference images and **zero** 3D assets, so there is
nothing to copy. If that ever changes before the disk is attached:

```bash
cd backend
npm run media:migrate                  # dry run: lists every file and checksum
npm run media:migrate -- --apply       # copy + verify checksums
```

Never delete the source until the destination is verified, and never point a media
variable at a path with no disk behind it — the files would be written into the
ephemeral tree and vanish on the next deploy.

### Verification that it actually persists

1. Deploy with the disk and both variables set.
2. `GET /api/health` → `media.reference.durable: true` and `media.threeD.durable: true`.
3. Upload one reference image in the portal; confirm the prepared images render.
4. **Redeploy** the service (or restart it) and reopen the same reference.
5. `npm run 3d:readiness` → `private media storage durable`.
6. On the server: `df -h /var/data` → usage well under capacity.

### Monitoring and backup

- Render's disk page shows usage; set a reminder or external check at 80 %.
- There is no automatic disk snapshot. Once real media exists, add an off-platform
  copy (download archive or a periodic upload to ImageKit/S3-compatible storage) and
  record the schedule in `DEPLOYMENT.md`.
- Rollback: copy the files off the disk **before** removing or resizing it. Removing
  a disk destroys its contents; unsetting the variables silently falls back to the
  ephemeral tree.

---

## 3. Blocker B — a generation provider

The adapter layer (`services/3dModelProvider.js`) supports exactly two providers,
both explicit, with no paid fallback:

- `local_worker` — `tools/3d-worker/worker.py`, TripoSR, MIT weights, no credential,
  **loopback/private addresses only** (`isLocalWorkerUrl()` refuses a public host,
  as an SSRF guard and to keep "local" meaning "spends nothing").
- `meshy` — Meshy 7.1 over HTTPS, requires **both** `3D_PROVIDER=meshy` and
  `MESHY_API_KEY`; a missing key is a refusal, never a fallback.

### Option A — host the TripoSR worker on a GPU provider

| Item | Detail |
|---|---|
| Fit today | **Requires a code change.** The `local_worker` adapter rejects non-loopback URLs by design, so a remote worker needs a new provider kind (e.g. `remote_worker`) with an allowlisted hostname and a bearer token (`THREE_WORKER_TOKEN` already exists in the worker and the adapter). |
| Compute needed | ~6 GB VRAM for TripoSR defaults; a 16 GB A4000/L4 is ample. Container: Python + CUDA/PyTorch + the ~1 GB weights. |
| Cost, current published rates | RunPod Serverless A4000 16 GB **$0.00016/s ≈ $0.58/h**; L4 24 GB **$0.00019/s ≈ $0.68/h** ([RunPod endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations)). Modal T4 **$0.000164/s ≈ $0.59/h**, L4 **$0.000222/s ≈ $0.80/h** ([Modal pricing](https://modal.com/pricing)). |
| Cost per model | Inference measured today: **8.5 s**, ~12 s per job including cutout. At $0.58/h ≈ **$0.010 per generated model**, plus cold-start time billed at the same rate (tens of seconds if the container and weights are cached). |
| Storage | RunPod container disk ≈ $0.10/GB/month, network volume ≈ $0.07/GB/month ([RunPod serverless pricing](https://docs.runpod.io/serverless/pricing)). Modal Volumes are billed separately (price is shown in the dashboard). |
| Advantages | Marginal cost only when generating; no subscription; weights are MIT; full control of the model and the quality gate; no vendor data retention. |
| Disadvantages | New provider code + container image + deployments to maintain; cold starts; a second platform to secure and monitor; the worker request/response contract must stay compatible with `submit/status/download/cancel`. |

### Option B — enable Meshy 7.1 (already implemented)

| Item | Detail |
|---|---|
| Plan | Pro **$20/month**, 1 000 API credits ([Meshy plan comparison](https://help.meshy.ai/en/articles/12062933-which-meshy-plan-is-right-for-you-free-vs-pro-vs-premium-vs-ultra)) |
| Credit cost (image-to-3D, Meshy 7.1) | **20** mesh only · **30** with 2K/4K textures · 35 with 8K ([Meshy API pricing](https://docs.meshy.ai/en/api/pricing)) |
| Capacity | ≈ **33–50 models/month** on the Pro plan (30-credit textured jobs → 33; 20-credit mesh-only → 50) |
| Rate limits | 20 requests/second, 10 queued tasks (Pro); HTTP 429 + `Retry-After` ([Meshy rate limits](https://docs.meshy.ai/en/api/rate-limits)) |
| Retention | API assets for non-Enterprise are deleted after **3 days** — download into our own storage immediately; the existing job pipeline already stores the GLB privately ([asset retention](https://docs.meshy.ai/en/api/asset-retention)) |
| Commercial use | Paid plans: output can be private and is owned by the customer to the extent the law allows; free plan is CC BY 4.0 ([Terms](https://www.meshy.ai/terms-of-use)) |
| Privacy caveat | Non-Enterprise inputs/outputs **may be used to improve the service** unless otherwise agreed (Terms §2.5/§2.9). Product photographs are already published catalogue images, but this must be accepted deliberately. |
| Advantages | Zero infrastructure; the adapter is already written and tested; no GPU to run; scales to a burst. |
| Disadvantages | Recurring $20/month even in a month with no new models; per-model credits; 3-day vendor retention; training-use caveat; supplier dependency. |
| Pricing caveat | Meshy's public pricing page displayed region-specific currency at the time of research. Confirm the amount at checkout before paying. |

### Recommendation

**Option B (Meshy) first**, for three reasons:

1. The pipeline is already implemented and tested against the Meshy adapter; the
   only work is two dashboard variables and one approval.
2. At the shop's actual volume (2 products live, a handful of candidates), $20/month
   covers 33–50 models — more than a season of work — with no second platform to
   operate. Option A's marginal-cost advantage only wins above roughly 100+ models
   per month, where $0.01/model beats $0.40–0.60/model.
3. The local worker remains fully available for free evaluation and regression
   (`npm run test:3d-real`), so no capability is lost by not hosting a GPU.

If the owner wants **zero recurring subscription** and expects high volume later,
choose Option A — but budget the container work and a new provider adapter first.

---

## 4. Approvals required (owner only)

Nothing below has been done.

- [ ] Approve **Render persistent disk**, 5 GB at `/var/data` (+$1.25/month).
- [ ] Approve **`REFERENCE_MEDIA_DIR`** and **`THREE_MEDIA_ROOT`** values above.
- [ ] Choose the provider: **Option B (Meshy, $20/month)** or **Option A**.
- [ ] For Option B: create the Meshy account, subscribe, create the API key, and add
      it in Render as `MESHY_API_KEY`, plus `3D_PROVIDER=meshy`. The key never enters
      the repository, a log or a chat.
- [ ] For Option A: approve the GPU platform, its budget and the new adapter work.
- [ ] Confirm the privacy/training terms are acceptable for catalogue photography
      (Option B).

## 5. End-to-end verification after provisioning

Run only against a controlled test product and an accepted sample reference; do not
consume a customer's upload.

1. Upload a reference image; confirm the ORIGINAL is written once, the cutout is
   private, and `immutable` holds on a second write attempt.
2. Accept the reference (human review).
3. Create a generation job; confirm the provider is the one configured and the key is
   not exposed by any endpoint.
4. Poll to `READY_FOR_REVIEW`; confirm the GLB was written under the durable root.
5. Confirm the candidate is validated as a GLB and carries a quality verdict.
6. Approve it (with a review note if the verdict is REVIEW); confirm the previous
   approved asset is deprecated, not deleted.
7. `GET /api/products/:slug` → `product3d` present with `delivery.glb`.
8. Open the storefront product page → 3D View renders; a product with no approved
   model still shows no 3D toggle.
9. Confirm an unapproved candidate and the private files return `404` publicly.
10. **Redeploy** the backend; confirm the model still delivers (disk durability).
11. `npm run 3d:readiness` → durable storage, provider available, 1 approved asset.
12. `npm run recovery:sources` is unaffected: the 3D collections are additive.

## 6. What will not happen without separate approval

- No Meshy subscription or API key.
- No GPU instance, container registry or second hosting platform.
- No disk purchase or plan change.
- No generation job in production, and no fabricated `Product3DAsset` or
  `GenerationJob` row.
- No media migration, deletion or path change before a disk exists.
