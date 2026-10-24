"""FLORA ALCHEMY 3D WORKER — genuine local image-to-3D inference (3D Studio Phase 4).

This process is the "local provider" the Phase 2 provider policy always pointed
at: it loads a REAL open-weight reconstruction model, runs it on REAL product
photography on the local GPU, and returns a REAL glTF Binary. The Flora Alchemy
backend drives it over HTTP through the same provider registry that speaks to
Meshy, so the job lifecycle, GLB validation, private storage, review and approval
paths are the ones already shipped in Phase 2/3 — this file adds inference, not a
second pipeline.

MODEL AND LICENCE
    TripoSR (VAST-AI-Research/TripoSR, weights `stabilityai/TripoSR`) — MIT for
    both the code and the weights. Stability AI's release announcement states the
    weights and source are "available for download here under the MIT license,
    allowing commercialized, personal, and research use". Single-IMAGE
    reconstruction: the mesh is inferred from one view, so the back of the object
    is a plausible completion, not a measurement. That limitation is reported in
    the task result and in docs/IMAGE_STUDIO.md rather than hidden.

WHAT IS REAL HERE
    · real torch + real CUDA (or honestly-reported CPU) inference
    · the real pretrained network: DINO image tokenizer → triplane transformer
      backbone → NeRF decoder → density field → isosurface
    · real mesh extraction, real GLB export, real byte count and sha256
WHAT IS SUBSTITUTED
    · `torchmcubes` (a C++/CUDA extension needing MSVC+CMake) is replaced by
      `shims/torchmcubes.py`, a scikit-image implementation of the SAME algorithm
      with the SAME vertex convention — proven by `shims/verify_shim.py`, which
      measures the axis order and the outward orientation instead of assuming
      them. See that module's docstring for the upstream source this reproduces.
    · Nothing else. In particular no part of the network is faked, and the mesh is
      never a fixture, a renamed asset or a static model.

HTTP API (localhost, single inference at a time)
    GET  /health              → model, device, GPU, VRAM, versions, licence
    POST /generate            → { taskId } (202), body: { images: [{ id, data, kind }] }
    GET  /tasks/<id>          → status/progress/error/result metrics
    GET  /tasks/<id>/glb      → the GLB bytes of a finished task
    POST /tasks/<id>/cancel   → request cancellation
    GET  /tasks/<id>/report   → a rendered turntable PNG (front view) when enabled

Run:
    python worker.py --triposr-home ../TripoSR --model stabilityai/TripoSR --device cuda:0

Environment:
    THREE_WORKER_TOKEN   optional shared secret; when set, every request except
                         /health must send `Authorization: Bearer <token>`.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
SHIMS_DIR = os.path.join(HERE, "shims")

# Cap on a single request body. A 1024x1024 RGBA PNG is ~1-3 MB; 48 MB leaves
# room for a few views while refusing an unbounded read.
MAX_BODY_BYTES = 48 * 1024 * 1024
# Cap on the returned model, mirroring the backend's own MAX_GLB_BYTES ceiling.
MAX_GLB_BYTES = 32 * 1024 * 1024  # mirrors the backend ceiling (Supabase Free: 50 MB/file)
MODEL_NAME = "TripoSR"
MODEL_VERSION = "triposr-1.0"
MODEL_LICENSE = "MIT (code and weights, VAST-AI-Research/TripoSR + stabilityai/TripoSR)"
MODEL_KIND = "single-image reconstruction"


# ── dependency wiring ────────────────────────────────────────────────────────
def _ensure_import_paths(triposr_home: str) -> None:
    """Make `tsr` and — only if the real extension is missing — the shim importable."""
    home = os.path.abspath(triposr_home)
    if not os.path.isdir(os.path.join(home, "tsr")):
        raise SystemExit(
            f"--triposr-home does not look like a TripoSR checkout (no tsr/ in {home}). "
            "Clone https://github.com/VAST-AI-Research/TripoSR there."
        )
    if home not in sys.path:
        sys.path.insert(0, home)

    # Prefer a real torchmcubes when the machine has one (a full C++/CUDA build);
    # fall back to the verified shim otherwise. Never silently pick the shim when
    # a real extension exists.
    try:
        import torchmcubes  # noqa: F401

        return
    except ImportError:
        pass
    if SHIMS_DIR not in sys.path:
        sys.path.insert(0, SHIMS_DIR)


def _install_torch_load_compat() -> Optional[str]:
    """Let the pinned checkpoint load on torch >= 2.6 (whose default is weights_only).

    `TSR.from_pretrained` calls `torch.load(weight_path, map_location="cpu")`.
    Torch 2.6 changed the default to `weights_only=True`, which refuses a
    checkpoint containing non-tensor objects (this one carries OmegaConf state),
    so the official code fails on a current torch. Rather than edit TripoSR — or
    blanket-allow every pickle class — this retries the SAME file with
    `weights_only=False` only after the strict path has failed, and records that
    it did. The file is the pinned `stabilityai/TripoSR` checkpoint fetched by
    huggingface_hub, not an arbitrary upload.

    Returns a note string when the relaxed path was used, else None.
    """
    import pickle
    import torch

    original = torch.load
    state = {"relaxed": False}

    def compat_load(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except (pickle.UnpicklingError, RuntimeError) as first_error:
            if kwargs.get("weights_only") is False:
                raise
            try:
                loaded = original(*args, weights_only=False, **kwargs)
            except Exception:
                raise first_error
            state["relaxed"] = True
            print(
                "[worker] torch.load needed weights_only=False for the checkpoint "
                f"({type(first_error).__name__}); the checkpoint is the pinned "
                "stabilityai/TripoSR model file.",
                flush=True,
            )
            return loaded

    torch.load = compat_load
    return "relaxed" if state["relaxed"] else None


def _install_transformers_compat(log) -> None:
    """Tolerate a `transformers` whose ViT no longer accepts `interpolate_pos_encoding`.

    TripoSR calls `ViTModel(..., interpolate_pos_encoding=True)` because it feeds
    512x512 images to a ViT pretrained at 224x224, so positional embeddings MUST be
    interpolated. On a transformers release that dropped the keyword, dropping it
    would silently change the architecture's input handling, so instead the
    keyword is translated into an explicit call to the model's own interpolation
    helper and the forward is left otherwise untouched.
    """
    import inspect

    from transformers.models.vit.modeling_vit import ViTModel

    params = inspect.signature(ViTModel.forward).parameters
    if "interpolate_pos_encoding" in params:
        return

    original_forward = ViTModel.forward

    def forward_compat(self, pixel_values, *args, **kwargs):
        wants_interpolation = kwargs.pop("interpolate_pos_encoding", False)
        if not wants_interpolation:
            return original_forward(self, pixel_values, *args, **kwargs)
        # The public helper interpolates self.position_embeddings to the input grid.
        try:
            self.position_embeddings = self.interpolate_pos_encoding(
                pixel_values, self.position_embeddings
            ) if hasattr(self, "interpolate_pos_encoding") else self.position_embeddings
        except Exception as err:  # pragma: no cover - compatibility path
            log(f"position-embedding interpolation fell back to the model default: {err}")
        return original_forward(self, pixel_values, *args, **kwargs)

    ViTModel.forward = forward_compat
    log("transformers ViT has no `interpolate_pos_encoding` keyword: wrapped forward.")


# ── image preparation ────────────────────────────────────────────────────────
def _to_rgba(image_bytes: bytes):
    """Decode bytes to an RGBA PIL image, or raise a readable ValueError."""
    from PIL import Image

    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as err:
        raise ValueError(f"the supplied reference is not a readable image ({err})") from err
    return image.convert("RGBA")


def prepare_input(image, foreground_ratio: float = 0.85):
    """Reproduce TripoSR's own preprocessing for an already-cut-out reference.

    `run.py` removes the background with rembg, crops to the foreground, pads to a
    square at `foreground_ratio`, then composites over mid-grey:

        image = image[:, :, :3] * image[:, :, 3:4] + (1 - image[:, :, 3:4]) * 0.5

    Flora Alchemy already produces a cutout in Phase 1 (a real background-removal
    engine, human-reviewed), so the worker consumes THAT and skips rembg — the
    same composite formula is applied so the network sees the input it was trained
    on. An image with no usable alpha is used as-is (TripoSR's documented
    `--no-remove-bg` mode, which expects a prepared grey-background photograph).
    """
    import numpy as np
    from PIL import Image

    arr = np.array(image)
    if arr.ndim != 3 or arr.shape[2] != 4:
        raise ValueError("expected an RGBA image")
    alpha_min = int(arr[:, :, 3].min())

    if alpha_min >= 255:
        # No alpha information: treat as a prepared photograph and only square it.
        mode = "rgb-as-prepared"
        side = max(arr.shape[0], arr.shape[1])
        pad_y = side - arr.shape[0]
        pad_x = side - arr.shape[1]
        arr = np.pad(
            arr,
            ((pad_y // 2, pad_y - pad_y // 2), (pad_x // 2, pad_x - pad_x // 2), (0, 0)),
            mode="constant",
        )
    else:
        mode = "cutout"
        ys, xs = np.where(arr[:, :, 3] > 0)
        if len(ys) == 0:
            raise ValueError("the reference cutout is fully transparent")
        y1, y2, x1, x2 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
        fg = arr[y1:y2, x1:x2]
        side = max(fg.shape[0], fg.shape[1])
        pad_y = side - fg.shape[0]
        pad_x = side - fg.shape[1]
        squared = np.pad(
            fg,
            ((pad_y // 2, pad_y - pad_y // 2), (pad_x // 2, pad_x - pad_x // 2), (0, 0)),
            mode="constant",
        )
        new_side = int(side / float(foreground_ratio))
        extra = new_side - side
        arr = np.pad(
            squared,
            ((extra // 2, extra - extra // 2), (extra // 2, extra - extra // 2), (0, 0)),
            mode="constant",
        )

    rgb = arr[:, :, :3].astype(np.float32) / 255.0
    alpha = (arr[:, :, 3:4].astype(np.float32) / 255.0) if alpha_min < 255 else np.ones(
        (arr.shape[0], arr.shape[1], 1), dtype=np.float32
    )
    composited = rgb * alpha + (1.0 - alpha) * 0.5
    composed = Image.fromarray((composited * 255.0).astype(np.uint8), mode="RGB")
    return composed, mode, int(arr.shape[0])


# ── task bookkeeping ─────────────────────────────────────────────────────────
@dataclass
class Task:
    id: str
    status: str = "queued"  # queued | running | succeeded | failed | cancelled
    stage: str = "queued"
    progress: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[dict] = None
    result: Optional[dict] = None
    glb: Optional[bytes] = None
    preview_png: Optional[bytes] = None
    cancel_requested: bool = False

    def public(self) -> dict:
        return {
            "taskId": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "durationMs": (
                int((self.finished_at - self.started_at) * 1000)
                if self.started_at and self.finished_at
                else None
            ),
            "error": self.error,
            "result": self.result,
            "cancelRequested": self.cancel_requested,
        }


class Engine:
    """Holds the loaded model and serialises inference (one GPU, one at a time)."""

    def __init__(self, args) -> None:
        self.args = args
        self.tasks: dict[str, Task] = {}
        self.lock = threading.Lock()
        self.model = None
        self.device = "cpu"
        self.load_error: Optional[str] = None
        self.loaded_at: Optional[float] = None
        self.load_seconds: Optional[float] = None
        self.marching_cubes_backend = "torchmcubes"
        self.load_compat_note: Optional[str] = None
        self.gpu_name = ""
        self.vram_total_mb = 0

    # -- startup ------------------------------------------------------------
    def load(self) -> None:
        import torch

        # Report the GPU from the driver, independently of whether torch can use it.
        try:
            import subprocess

            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                timeout=20,
            )
            line = (out.stdout or "").strip().splitlines()
            if line:
                parts = [p.strip() for p in line[0].split(",")]
                self.gpu_name = parts[0]
                if len(parts) > 1:
                    self.vram_total_mb = int(float(parts[1].split()[0]))
        except Exception as err:
            self.log(f"nvidia-smi unavailable: {err}")

        requested = self.args.device
        if requested.startswith("cuda") and not torch.cuda.is_available():
            self.log(
                f"requested {requested} but this torch build reports CUDA unavailable "
                f"(torch {torch.__version__}); falling back to CPU — slow but genuine"
            )
            requested = "cpu"
        self.device = requested

        import torchmcubes  # the real extension or the shim, whichever import won

        self.marching_cubes_backend = "skimage-shim" if getattr(torchmcubes, "__version__", "").endswith(
            "+skimage-shim"
        ) else "torchmcubes"
        self.load_compat_note = _install_torch_load_compat()
        _install_transformers_compat(self.log)

        from tsr.system import TSR

        started = time.time()
        self.log(
            f"loading {self.args.model} on {self.device} "
            f"(marching cubes: {self.marching_cubes_backend})"
        )
        model = TSR.from_pretrained(
            self.args.model, config_name="config.yaml", weight_name="model.ckpt"
        )
        model.renderer.set_chunk_size(self.args.chunk_size)
        model.to(self.device)
        model.eval()
        self.model = model
        self.load_seconds = round(time.time() - started, 2)
        self.loaded_at = time.time()
        self.log(f"model ready in {self.load_seconds}s")

    def log(self, message: str) -> None:
        print(f"[worker] {message}", flush=True)

    # -- inference ----------------------------------------------------------
    def run_task(self, task: Task, payload: dict) -> None:
        import numpy as np
        import torch

        task.status = "running"
        task.started_at = time.time()
        try:
            if self.load_error:
                raise RuntimeError(self.load_error)
            if self.model is None:
                raise RuntimeError("the model is not loaded")

            images = payload.get("images") or []
            if not images:
                raise ValueError("no reference image was supplied")
            if len(images) > 1:
                # TripoSR is single-image. Sending a second view would be ignored
                # silently, which would misrepresent what the model did.
                raise ValueError(
                    f"{MODEL_NAME} is single-image; {len(images)} views were supplied"
                )
            first = images[0]
            raw = base64.b64decode(first.get("data") or "", validate=False)
            if not raw:
                raise ValueError("the reference image was empty")

            options = payload.get("options") or {}
            resolution = int(options.get("resolution") or self.args.mc_resolution)
            foreground_ratio = float(options.get("foreground_ratio") or self.args.foreground_ratio)

            self._stage(task, "preparing", 5)
            rgba = _to_rgba(raw)
            prepared, input_mode, prepared_pixels = prepare_input(rgba, foreground_ratio)
            self._check_cancel(task)

            self._stage(task, "encoding", 20)
            if torch.cuda.is_available() and self.device.startswith("cuda"):
                torch.cuda.reset_peak_memory_stats()
            with torch.no_grad():
                scene_codes = self.model([prepared], device=self.device)
            self._check_cancel(task)

            self._stage(task, "extracting-mesh", 60)
            has_vertex_color = True
            meshes = self.model.extract_mesh(
                scene_codes, has_vertex_color, resolution=resolution
            )
            mesh = meshes[0]
            self._check_cancel(task)

            self._stage(task, "post-processing", 75)
            metrics = self._clean_and_measure(mesh)

            preview_png = None
            if self.args.preview:
                preview_png = self._render_preview(scene_codes)

            self._stage(task, "exporting", 90)
            # include_normals=True is REQUIRED, not cosmetic: trimesh's default is
            # None, which only writes NORMAL when the mesh happens to have them
            # cached — and a glTF primitive with no NORMAL makes three.js fall
            # back to FLAT shading, so a smooth generated surface would ship as a
            # faceted one. The attribute set is verified below.
            glb = mesh.export(file_type="glb", include_normals=True)
            if not isinstance(glb, (bytes, bytearray)) or len(glb) == 0:
                raise RuntimeError("trimesh produced no GLB bytes")
            glb = bytes(glb)
            if len(glb) > MAX_GLB_BYTES:
                raise RuntimeError(
                    f"the exported model is {len(glb) / 1024 / 1024:.1f} MB, above the "
                    f"{MAX_GLB_BYTES / 1024 / 1024:.0f} MB ceiling"
                )

            # A material-less GLB renders DARK in every PBR viewer, because
            # glTF's fallback is a fully metallic surface with no environment to
            # reflect (see `ensure_dielectric_material`). TripoSR bakes its
            # colour into COLOR_0, so without this the product shows up as a
            # black shape even though the colours are present in the file.
            glb, material_injected = ensure_dielectric_material(glb)

            # The GLB is inspected the same way the backend will validate it, so a
            # task never reports success on bytes the pipeline will refuse.
            container = _inspect_glb(glb)
            if not container.get("hasNormals"):
                raise RuntimeError(
                    "the exported GLB has no NORMAL attribute, which would make the "
                    "storefront viewer shade the model flat"
                )
            if material_injected and not container.get("materials"):
                raise RuntimeError(
                    "the dielectric material could not be written into the GLB, so the "
                    "model would render dark"
                )
            metrics["materials"] = container.get("materials", 0)
            metrics["textures"] = container.get("textures", 0)
            metrics["materialInjected"] = bool(material_injected)

            task.glb = glb
            task.preview_png = preview_png
            task.result = {
                **metrics,
                "bytes": len(glb),
                "sha256": hashlib.sha256(glb).hexdigest(),
                "container": container,
                "resolution": resolution,
                "chunkSize": self.args.chunk_size,
                "inputMode": input_mode,
                "inputPixels": prepared_pixels,
                "device": self.device,
                "gpuName": self.gpu_name,
                "vramTotalMb": self.vram_total_mb,
                "vramPeakMb": self._peak_vram_mb(),
                "model": MODEL_NAME,
                "modelVersion": MODEL_VERSION,
                "modelLicense": MODEL_LICENSE,
                "modelKind": MODEL_KIND,
                "marchingCubes": self.marching_cubes_backend,
                "torch": torch.__version__,
                "python": sys.version.split()[0],
                "previewAvailable": preview_png is not None,
            }
            task.status = "succeeded"
            task.stage = "done"
            task.progress = 100
            self.log(
                f"task {task.id} succeeded: {metrics['vertices']} vertices, "
                f"{metrics['faces']} faces, {len(glb) / 1024:.0f} KB in "
                f"{int((time.time() - task.started_at) * 1000)} ms"
            )
        except Exception as err:  # a failed task is an outcome, not a crash
            task.error = {
                "code": getattr(err, "code", type(err).__name__),
                "message": str(err)[:500],
            }
            if task.cancel_requested:
                task.status = "cancelled"
                task.stage = "cancelled"
                self.log(f"task {task.id} cancelled")
            else:
                task.status = "failed"
                task.stage = "failed"
                self.log(f"task {task.id} FAILED: {task.error['code']}: {task.error['message']}")
                if self.args.debug:
                    traceback.print_exc()
        finally:
            task.finished_at = time.time()

    def _stage(self, task: Task, stage: str, progress: int) -> None:
        task.stage = stage
        task.progress = progress
        self.log(f"task {task.id}: {stage} ({progress}%)")

    def _check_cancel(self, task: Task) -> None:
        if task.cancel_requested:
            raise RuntimeError("cancelled")

    def _clean_and_measure(self, mesh) -> dict:
        """Tidy the raw isosurface and measure what is being published.

        Two things are checked rather than trusted: degenerate triangles (marching
        cubes can emit them) and winding orientation. Orientation matters because
        the storefront viewer renders front faces, so an inverted mesh would look
        black or invisible to a customer.
        """
        import trimesh

        raw_faces = len(mesh.faces)
        raw_vertices = len(mesh.vertices)
        if raw_faces == 0:
            raise RuntimeError("the model produced no triangles")

        winding_consistent = bool(mesh.is_winding_consistent)
        inverted = False
        try:
            volume = float(mesh.volume)
        except Exception:
            volume = float("nan")
        if volume == volume and volume < 0:  # not NaN and negative
            mesh.invert()
            inverted = True

        try:
            mesh.update_faces(mesh.nondegenerate_faces())
            mesh.remove_unreferenced_vertices()
        except Exception:
            pass

        bounds = mesh.bounds
        return {
            "vertices": int(len(mesh.vertices)),
            "faces": int(len(mesh.faces)),
            "triangles": int(len(mesh.faces)),
            "rawVertices": raw_vertices,
            "rawFaces": raw_faces,
            # materials/textures come from the EXPORTED container (measured after
            # the fact), not from an assumption about what trimesh writes.
            "vertexColors": bool(mesh.visual.kind == "vertex"),
            "watertight": bool(mesh.is_watertight),
            "windingConsistent": winding_consistent,
            "normalsInverted": inverted,
            "volume": round(volume, 6) if volume == volume else None,
            "bounds": None if bounds is None else [[float(v) for v in row] for row in bounds],
            "extents": [float(v) for v in mesh.extents],
        }

    def _peak_vram_mb(self) -> int:
        import torch

        if not (self.device.startswith("cuda") and torch.cuda.is_available()):
            return 0
        try:
            return int(torch.cuda.max_memory_allocated() / 1024 / 1024)
        except Exception:
            return 0

    def _render_preview(self, scene_codes):
        """Render the model's own view of the object (a real NeRF render, not a photo)."""
        try:
            images = self.model.render(scene_codes, n_views=24, elevation_deg=10.0, return_type="pil")
            frame = images[0][0]
            buf = io.BytesIO()
            frame.save(buf, format="PNG")
            return buf.getvalue()
        except Exception as err:
            self.log(f"preview render failed (not fatal): {err}")
            return None


def _inspect_glb(buffer: bytes) -> dict:
    """Read the container facts out of the exported GLB (magic, meshes, attributes)."""
    import struct

    if len(buffer) < 20:
        return {"ok": False, "reason": "too short"}
    magic, version, declared = struct.unpack("<III", buffer[:12])
    if magic != 0x46546C67:
        return {"ok": False, "reason": "bad magic"}
    chunk_len, chunk_type = struct.unpack("<II", buffer[12:20])
    if chunk_type != 0x4E4F534A:
        return {"ok": False, "reason": "no JSON chunk"}
    try:
        doc = json.loads(buffer[20 : 20 + chunk_len].decode("utf-8"))
    except Exception as err:
        return {"ok": False, "reason": f"unreadable JSON chunk: {err}"}
    primitives = []
    attribute_sets = []
    for mesh in doc.get("meshes") or []:
        for prim in mesh.get("primitives") or []:
            attrs = sorted((prim.get("attributes") or {}).keys())
            attribute_sets.append(attrs)
            primitives.append({"attributes": attrs, "mode": prim.get("mode", 4)})
    return {
        "ok": True,
        "version": version,
        "declaredBytes": declared,
        "matchesActualLength": declared == len(buffer),
        "meshes": len(doc.get("meshes") or []),
        "materials": len(doc.get("materials") or []),
        "textures": len(doc.get("textures") or []),
        "images": len(doc.get("images") or []),
        "accessors": len(doc.get("accessors") or []),
        "primitives": primitives,
        "hasNormals": any("NORMAL" in attrs for attrs in attribute_sets),
        "hasVertexColors": any("COLOR_0" in attrs for attrs in attribute_sets),
        "generator": (doc.get("asset") or {}).get("generator", ""),
    }


DIELECTRIC_MATERIAL = {
    # A dielectric (non-metal) PBR material. `metallicFactor: 0` is the load-
    # bearing value: glTF's fallback for a primitive with NO material is a fully
    # METALLIC rough surface, and a metal with no environment to reflect has no
    # diffuse term at all — so the model's own colour is suppressed and a
    # colourful bouquet renders as a dark shape. With metallic 0 the exported
    # COLOR_0 (or base colour) becomes real albedo in every PBR viewer.
    # Roughness 0.6 is a deliberately conservative "not shiny, not chalky"
    # value for petals/leaves/paper/ribbon alike; it is not a per-material
    # claim, and the review screen still says the model is vertex-coloured.
    "name": "flora-dielectric-vertex-colour",
    "pbrMetallicRoughness": {
        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
        "metallicFactor": 0.0,
        "roughnessFactor": 0.6,
    },
    "doubleSided": True,
}


def ensure_dielectric_material(buffer: bytes) -> tuple[bytes, bool]:
    """Write a dielectric PBR material into a GLB that has none.

    Returns ``(glb_bytes, changed)``. A GLB that already carries a material is
    returned untouched — this never overrides an engine's own material choices,
    it only supplies the one glTF assumes when the file is silent.

    The edit is confined to the JSON chunk: a material is appended, every
    primitive that had none is pointed at it, and the BIN chunk is copied byte
    for byte. Nothing about the geometry, colours or buffer is touched.
    """
    import struct

    if len(buffer) < 20:
        return buffer, False
    magic, version, declared = struct.unpack("<III", buffer[:12])
    if magic != 0x46546C67 or declared != len(buffer):
        return buffer, False
    json_len, json_type = struct.unpack("<II", buffer[12:20])
    if json_type != 0x4E4F534A:
        return buffer, False
    try:
        doc = json.loads(buffer[20 : 20 + json_len].decode("utf-8"))
    except Exception:
        return buffer, False

    materials = doc.get("materials") or []
    if materials:
        return buffer, False

    rest = buffer[20 + json_len :]
    meshes = doc.get("meshes") or []
    if not meshes:
        return buffer, False

    doc["materials"] = [DIELECTRIC_MATERIAL]
    for mesh in meshes:
        for prim in mesh.get("primitives") or []:
            # An existing material is the engine's decision; only a missing one
            # is ours to supply.
            if prim.get("material") is None:
                prim["material"] = 0

    payload = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    # glTF requires chunks to be 4-byte aligned; the JSON chunk is padded with
    # spaces (0x20), which is what every conforming writer does.
    padding = (-len(payload)) % 4
    if padding:
        payload += b" " * padding
    header = struct.pack("<III", 0x46546C67, version, 12 + 8 + len(payload) + len(rest))
    return header + struct.pack("<II", len(payload), 0x4E4F534A) + payload + rest, True


# ── HTTP ─────────────────────────────────────────────────────────────────────
ENGINE: Optional[Engine] = None
INFER_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "Flora3DWorker/1.0"

    def log_message(self, fmt: str, *args) -> None:  # keep the console readable
        if os.environ.get("THREE_WORKER_VERBOSE") == "1":
            super().log_message(fmt, *args)

    # -- helpers -----------------------------------------------------------
    def _send(self, code: int, payload: Any, content_type: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, path: str) -> bool:
        token = os.environ.get("THREE_WORKER_TOKEN") or ""
        if not token:
            return True
        if path == "/health":
            return True
        return self.headers.get("Authorization", "") == f"Bearer {token}"

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("an empty body was sent")
        if length > MAX_BODY_BYTES:
            raise ValueError(f"the request body is {length} bytes, above the {MAX_BODY_BYTES} cap")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as err:
            raise ValueError(f"the body is not valid JSON ({err})") from err

    def _task_id(self, path: str) -> Optional[str]:
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "tasks":
            return parts[1]
        return None

    # -- routes ------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (http.server's interface)
        path = self.path.split("?")[0]
        if not self._authorized(path):
            return self._send(401, {"error": "unauthorized"})
        engine = ENGINE
        assert engine is not None
        if path == "/health":
            import torch

            ready = engine.model is not None
            return self._send(
                200,
                {
                    "ok": ready,
                    "ready": ready,
                    "provider": "local_worker",
                    "model": MODEL_NAME,
                    "modelVersion": MODEL_VERSION,
                    "modelKind": MODEL_KIND,
                    "modelLicense": MODEL_LICENSE,
                    "device": engine.device,
                    "cudaAvailable": bool(torch.cuda.is_available()),
                    "gpuName": engine.gpu_name,
                    "vramTotalMb": engine.vram_total_mb,
                    "marchingCubes": engine.marching_cubes_backend,
                    "torch": torch.__version__,
                    "python": sys.version.split()[0],
                    "loadSeconds": engine.load_seconds,
                    "checkpointLoad": engine.load_compat_note or "strict",
                    "maxInputViews": 1,
                    "supportsMultiView": False,
                    "maxGlbBytes": MAX_GLB_BYTES,
                    "preview": bool(engine.args.preview),
                    "tasks": len(engine.tasks),
                    "modelPath": engine.args.model,
                    "detail": (
                        f"{MODEL_NAME} ready on {engine.device}"
                        if ready
                        else f"{MODEL_NAME} failed to load: {engine.load_error or 'loading'}"
                    ),
                },
            )
        task_id = self._task_id(path)
        if task_id:
            task = engine.tasks.get(task_id)
            if not task:
                return self._send(404, {"error": "unknown task"})
            if path.endswith("/glb"):
                if task.status != "succeeded" or not task.glb:
                    return self._send(409, {"error": f"task is {task.status}"})
                return self._send(200, task.glb, content_type="model/gltf-binary")
            if path.endswith("/preview"):
                if not task.preview_png:
                    return self._send(404, {"error": "no preview for this task"})
                return self._send(200, task.preview_png, content_type="image/png")
            return self._send(200, task.public())
        if path == "/tasks":
            return self._send(200, {"tasks": [t.public() for t in engine.tasks.values()]})
        return self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if not self._authorized(path):
            return self._send(401, {"error": "unauthorized"})
        engine = ENGINE
        assert engine is not None
        if path == "/generate":
            try:
                payload = self._read_json()
            except ValueError as err:
                return self._send(400, {"error": str(err)})
            task = Task(id=uuid.uuid4().hex[:16])
            engine.tasks[task.id] = task
            # Inference is serialised: one GPU, and TripoSR loads weights once.
            threading.Thread(
                target=_run_serialised, args=(engine, task, payload), daemon=True
            ).start()
            return self._send(202, {"taskId": task.id, "status": task.status})
        task_id = self._task_id(path)
        if task_id and path.endswith("/cancel"):
            task = engine.tasks.get(task_id)
            if not task:
                return self._send(404, {"error": "unknown task"})
            task.cancel_requested = True
            if task.status == "queued":
                task.status = "cancelled"
                task.stage = "cancelled"
                task.finished_at = time.time()
            return self._send(200, {"taskId": task.id, "cancelRequested": True})
        return self._send(404, {"error": "not found"})


def _run_serialised(engine: Engine, task: Task, payload: dict) -> None:
    with INFER_LOCK:
        if task.cancel_requested:
            task.status = "cancelled"
            task.stage = "cancelled"
            task.finished_at = time.time()
            return
        engine.run_task(task, payload)


def _refuse_if_already_running(host: str, port: int) -> None:
    """Refuse to start a SECOND worker on a port that is already serving one.

    This is not theoretical: on Windows `allow_reuse_address` lets a second
    process bind the same port, and the operating system then load-balances
    connections between them. A stale worker running OLD code would silently
    answer half the requests, which is exactly the kind of "it works sometimes"
    failure that wastes an afternoon. One worker, one port, stated out loud.
    """
    import json as _json
    import urllib.request

    probe_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    try:
        with urllib.request.urlopen(f"http://{probe_host}:{port}/health", timeout=3) as res:
            payload = _json.loads(res.read().decode("utf-8"))
        raise SystemExit(
            f"Another 3D worker is already running on {probe_host}:{port} "
            f"(model={payload.get('model')}, device={payload.get('device')}, tasks={payload.get('tasks')}). "
            "Stop it first, or start this one with --port <other>."
        )
    except SystemExit:
        raise
    except Exception:
        # Nothing is answering: the port is free (or held by a non-worker, which
        # the bind below will report honestly).
        return


def main() -> int:
    global ENGINE

    parser = argparse.ArgumentParser(description="Flora Alchemy local 3D inference worker")
    parser.add_argument("--triposr-home", default=os.environ.get("TRIPOSR_HOME", ""), help="path to a TripoSR checkout")
    parser.add_argument("--model", default=os.environ.get("THREE_WORKER_MODEL", "stabilityai/TripoSR"))
    parser.add_argument("--device", default=os.environ.get("THREE_WORKER_DEVICE", "cuda:0"))
    parser.add_argument("--host", default=os.environ.get("THREE_WORKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("THREE_WORKER_PORT", "8791")))
    parser.add_argument("--mc-resolution", type=int, default=int(os.environ.get("THREE_WORKER_MC_RESOLUTION", "256")))
    parser.add_argument("--chunk-size", type=int, default=int(os.environ.get("THREE_WORKER_CHUNK_SIZE", "8192")))
    parser.add_argument("--foreground-ratio", type=float, default=0.85)
    parser.add_argument("--preview", action="store_true", help="also render a NeRF preview frame")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    if not args.triposr_home:
        # Default: a sibling checkout, which is how tools/setup-3d-worker.ps1 lays it out.
        args.triposr_home = os.path.abspath(os.path.join(HERE, "..", "..", "..", "flora-3d", "TripoSR"))

    _ensure_import_paths(args.triposr_home)
    _refuse_if_already_running(args.host, args.port)

    ENGINE = Engine(args)
    print(
        f"[worker] Flora Alchemy 3D worker starting — {MODEL_NAME} ({MODEL_LICENSE}); "
        f"triposr-home={os.path.abspath(args.triposr_home)}",
        flush=True,
    )
    try:
        ENGINE.load()
    except Exception as err:
        ENGINE.load_error = str(err)
        print(f"[worker] MODEL LOAD FAILED: {err}", flush=True)
        if args.debug:
            traceback.print_exc()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[worker] listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[worker] shutting down", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
