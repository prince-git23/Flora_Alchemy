# Multi-engine local GPU reconstruction

Flora Alchemy's 3D Studio now dispatches to **three local reconstruction engines**
through one authenticated GPU agent:

| Engine | Engine id | Adapter | Input contract | Status |
|---|---|---|---|---|
| TripoSR | `local_single_view` | `triposr` | 1–4 photographs, one consumed after masking | **measured** — the existing baseline |
| Hunyuan3D-2mv | `hunyuan3d_2mv` | `hunyuan3d_2mv` | 2–4 **named** views (`front`, `left`, `back`, optional `right`), shape only | **unverified** — adapter integrated, no real reconstruction recorded here |
| ReLi3D | `reli3d` | `reli3d` | 3–8 **RGBA** frames, each with a recorded camera-to-world pose + FOV | **unverified** — adapter integrated, no real reconstruction recorded here |

"Unverified" is a deliberate evidence state, not a placeholder: an adapter that
has never produced a model on this machine must not be presented as working.
It becomes `measured` only after a real reconstruction is generated, inspected
and recorded (see *Evidence* below).

---

## 1. Why an engine is not a provider

`THREE_D_PROVIDER` names the **transport** that carries work:

```
local_worker      backend ──HTTP──▶ worker on loopback/LAN
local_gpu_agent   agent  ──HTTPS──▶ deployed API, claims a job, runs it locally
meshy             backend ──HTTPS──▶ hosted, metered provider (opt-in)
```

An **engine** is what runs inside a local transport. One `local_gpu_agent`
deployment can therefore offer TripoSR, Hunyuan3D-2mv and ReLi3D at once. The
engine id is persisted on `GenerationJob.engineId` (empty = a legacy job, which
means TripoSR) and copied onto `Product3DAsset.engineId` / `engineAdapter`, so
provenance survives even if the job row is pruned.

`backend/services/localEngineAdapters.js` is the server-side contract registry.
`backend/services/engineCapabilities.js` remains the capture-set registry and
now asks the adapter registry what an installed engine requires.

## 2. Dispatch and queueing

* A job is created for **one engine**, validated before it is written.
* The agent reports, on every heartbeat, which adapters its probe found ready.
* A claim carries `engines: ['triposr', 'hunyuan3d_2mv', …]`; the server hands it
  only jobs whose `engineId` is in that set (plus legacy empty ids for TripoSR).
* The claim payload names `engine.adapter`; the agent resolves that adapter or
  **fails the job**. There is no substitution, no "try TripoSR instead" and no
  paid fallback.
* While the PC is offline, jobs wait in the queue — an honest WAITING state, not
  a failure. A stale lease recovers the job for the next claim.

Security is unchanged: machine token → per-job lease → authoritative job row.
No inference port is exposed; the agent only makes outbound HTTPS calls.

## 3. Input contracts

### Hunyuan3D-2mv — named views, never a sheet

* `front`, `left`, `back` are required; `right` is optional.
* One image per slot. Two rows labelled `front` are refused as ambiguous.
* A confirmed composite sheet is **provenance**, never a view. The server drops
  it before transfer and the adapter refuses it again.
* Shape only (`stages.texture: false`). Octree resolution starts at **256**.
* Records: model, model version, device, GPU, VRAM peak, octree resolution,
  steps/guidance/seed/chunks, input hashes per slot, timing and GLB sha256.

### ReLi3D — RGBA frames and recorded poses only

* 3–8 frames, each a PNG with an alpha channel. RGB and JPEG are refused.
* Each frame needs `pose.position`, `pose.target`, `pose.fov` and a source of
  `manual` or `imported`. `inferred` is not a source, and a missing pose is a
  refusal — never a default.
* `transforms.json` is generated **server-side** from those recorded values:
  4×4 camera-to-world (OpenGL convention, right-handed, +Y up), per-frame
  `camera_fov` and intrinsics derived from FOV and the real pixel size, plus a
  `provenance` block stating `inferredPoses: 0`.
* The agent writes those exact bytes and invokes the **official entrypoint**
  (`RELI3D_HOME` / `RELI3D_ENTRYPOINT`) as a subprocess.
* Outputs are separate artifacts: `mesh.glb`, `illumination.hdr`,
  `run_info.json`. All three are required; a missing one fails the job.

## 4. Result pipeline (unchanged, shared by every engine)

```
GLB bytes → validateGlb → private storage → quality assessment
          → CANDIDATE asset → human approval → storefront 3D view
```

Artifacts are uploaded after the GLB on a separate, lease-guarded request
(`POST /api/3d/agent/jobs/:jobId/artifacts/:kind`) and stored as their own
private files on the candidate. They are immutable, hashed, and never merged
into the GLB. Approval remains a human action; inference alone cannot publish.

## 5. Health

Readiness is a measurement, never a configuration guess:

* The agent probes package installation, checkpoint availability and CUDA.
* `GpuAgent.engines` stores the latest per-engine probe.
* The studio's engine radio is selectable only when the adapter is installed
  **and** this deployment can run it **and** the agent reports it ready.
* A legacy agent (one that predates engine probes) still reports TripoSR as
  loaded, and is treated as ready for TripoSR only.

## 6. Configuration

| Variable | Purpose |
|---|---|
| `THREE_D_PROVIDER=local_gpu_agent` | select the remote agent transport |
| `THREE_WORKER_AGENT_TOKEN` | machine secret (≥16 chars), both sides |
| `THREE_WORKER_AGENT_URL` | the deployed `/api` base, HTTPS |
| `THREE_WORKER_AGENT_ENGINES` | adapters this agent may run, e.g. `triposr,hunyuan3d_2mv,reli3d` |
| `TRIPOSR_HOME` | TripoSR checkout (existing) |
| `HUNYUAN3D_MODEL_PATH` | local Hunyuan3D-2mv checkpoint directory |
| `RELI3D_HOME` / `RELI3D_ENTRYPOINT` | official ReLi3D checkout and script |
| `RELI3D_CHECKPOINT` | ReLi3D weights (or resolved from `RELI3D_HOME`) |
| `RELI3D_KEEP_WORKDIR=1` | keep the per-run working copy for audit |

No checkpoint is downloaded by CI, the backend or this repository.

## 7. Tests

```bash
python -m unittest discover -s tools/3d-worker/tests -v   # contracts, no GPU
cd backend && npm run test:engines                        # dispatch + pipeline
npm run test:3d-agent                                     # existing agent protocol
npm run test:capture                                      # capture sets
```

The multi-engine suite covers adapter contracts, input validation, provider
health, engine dispatch, GLB compatibility, duplicate uploads, cancellation and
the artifact path. Inference is a fixture GLB: these suites prove the SYSTEM,
never model quality.

## 8. Evidence

* **TripoSR** — measured (Phases 5–10): watertight single component, front
  silhouette IoU 0.907 against the reference's own mask.
* **Hunyuan3D-2mv** — a local three-view shape run on the RTX 4050 was measured
  in Phase D2 (5708 MiB peak, 10.96 MB POSITION-only GLB), but it predates this
  adapter and did not come through the approval pipeline. It is therefore
  **not** evidence for this integration. No pipeline reconstruction is recorded.
* **ReLi3D** — never run in this repository. Its input contract is enforced;
  its output has never been inspected here.

Do not promote either engine to `measured` in
`backend/services/engineCapabilities.js` without a real artifact, a quality
report and a written record of the hardware and timing.

## 9. Non-goals

* No automatic texture stage for Hunyuan3D-2mv (needs ~16 GB VRAM).
* No pose inference or synthetic camera transforms, ever.
* No cloud/paid fallback from a local engine failure.
* No publication without human approval, and no weakening of the quality gate.
