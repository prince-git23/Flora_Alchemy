"""Hunyuan3D-2mv adapter — local multi-view SHAPE reconstruction.

WHAT THIS ADAPTER IS, AND IS NOT
    · It conditions on NAMED views (front, left, back, optional right) — the
      learned slots the 2mv model was trained on. It NEVER accepts a contact
      sheet as one view: a sheet would be reconstructed as a single framed
      photograph whose cells disagree about scale, which is exactly the failure
      a real three-view run measured in Phase D2.
    · It runs SHAPE ONLY. Texture generation is a separate stage (and a separate
      ~16 GB requirement); `textureStage` in the metrics says `not_run` so no
      reader can infer a textured model from a shape export.
    · It starts at octree resolution 256 and records every inference setting.
    · A failure is a FAILURE. There is no TripoSR fallback here, and the caller
      cannot ask for one: the engine id is persisted with the job.
    · It calls the OFFICIAL implementation: the installed `hy3dgen`
      `Hunyuan3DDiTFlowMatchingPipeline`, the mv checkpoint's own subfolder
      (`hunyuan3d-dit-v2-mv`), and the mv processor's documented input type — a
      DICT keyed by view slot. `MVImageProcessorV2` indexes `view2idx` by the
      dict's keys, so a bare list is refused here before anything runs.

INPUT MASK — the official processor treats the ALPHA CHANNEL as the object mask
    `ImageProcessorV2.recenter` reads `image[..., 3]` when a fourth channel
    exists; an opaque frame therefore gets a full-frame mask and the whole
    photograph is reconstructed as geometry (measured in Phase D2: the raw
    caption panel stretched the object ~19%). This adapter therefore prepares an
    inference input per view with the SAME fail-closed machinery the TripoSR
    path uses (`worker.segment_foreground` + `worker._mask_gates`, MASK_* codes):

      · a PNG whose own alpha already passes the measured gates is kept as-is
        (`maskSource: source-alpha`);
      · otherwise this worker segments it (rembg), RE-MEASURES the mask, and
        refuses a bad one — the stored original is never written, and there is
        no fallback to the opaque photo.

HEALTH
    `probe()` reports independent facts — package availability (hy3dgen on
    sys.path), checkpoint resolution, CUDA readiness — and `ready` is true only
    when all three hold. hy3dgen is usually on PYTHONPATH (a checkout of the
    official Hunyuan3D-2 repository), not pip-installed.

MEMORY ON A 6 GB CARD (measured, Phase D2)
    `from_pretrained(..., device=...)` puts every component on the GPU at once;
    sampling then spills to system memory through the WDDM path (191 s/step —
    unusable). The official repo declares the intended fix as
    `model_cpu_offload_seq = "conditioner->model->vae"`, but its own
    `enable_model_cpu_offload` is broken. The measured workaround the official
    intent: hold the conditioner on the GPU ONLY for `encode_cond` — its single
    use inside the pipeline — then release it. This adapter applies that
    placement automatically when the card is < 8 GB and records that it did.

HONEST STATUS
    The environment facts were verified on the owner's RTX 4050 and this adapter
    follows the official interface, but no reconstruction has been produced
    THROUGH THIS ADAPTER yet: until one is generated, inspected and recorded,
    evidence for this engine stays `unverified` in the capture registry.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import os
import time
from typing import Optional

from .base import AdapterError, EngineHealth, InferenceResult, LocalEngineAdapter
from .contract import ContractError, decode_bytes, validate_hunyuan_inputs

HUNYUAN_SUBFOLDER = "hunyuan3d-dit-v2-mv"
PLACEMENT_VRAM_THRESHOLD_MB = 8192


def _import_available(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except Exception:
        return False


def _extract_mesh(output):
    """`pipeline(...)` returns per-sample results (batch 1 → one mesh)."""
    mesh = output[0] if isinstance(output, (list, tuple)) else output
    if isinstance(mesh, (list, tuple)):
        mesh = mesh[0] if mesh else None
    if isinstance(mesh, dict):
        for value in mesh.values():
            if hasattr(value, "export"):
                mesh = value
                break
    return mesh


class Hunyuan3D2mvAdapter(LocalEngineAdapter):
    adapter_id = "hunyuan3d_2mv"
    engine_id = "hunyuan3d_2mv"
    model = "Hunyuan3D-2mv"
    model_version = "2mv"
    dependencies = ["torch", "hy3dgen"]
    produces_artifacts = []
    OCTREE_RESOLUTION = 256
    DEFAULT_REPO_ID = "tencent/Hunyuan3D-2mv"

    def __init__(
        self,
        device: str = "cuda:0",
        model_path: str = "",
        worker_mod=None,
        log=print,
    ) -> None:
        self.requested_device = device
        self.model_path = model_path or os.environ.get("HUNYUAN3D_MODEL_PATH", "")
        self.worker_mod = worker_mod
        self.log = log
        self._pipeline = None
        self._load_error: Optional[str] = None
        self._last_peak_mb = 0
        self._applied_placement = False
        self._load_seconds: Optional[float] = None
        self._total_vram_mb = 0

    @property
    def load_error(self) -> str:
        return self._load_error or ""

    @property
    def device(self) -> str:
        return self.requested_device

    # -- checkpoint resolution (official loader semantics) -------------------
    #
    # `hy3dgen.shapegen.utils.smart_load_model(model_path, subfolder, ...)`
    # joins `subfolder` onto `model_path`, then downloads that subfolder of the
    # HF repo when the joined path is missing. So:
    #   · a directory that ALREADY contains config.yaml IS the subfolder and is
    #     passed with subfolder='' (joining twice would miss it);
    #   · anything else — a repo id, an HF-cache snapshot root, a parent
    #     directory — is passed with the mv checkpoint's own subfolder name.

    def resolve_load_args(self) -> tuple:
        path = os.path.expanduser(self.model_path or self.DEFAULT_REPO_ID)
        if path != self.DEFAULT_REPO_ID and os.path.isdir(path) and os.path.exists(os.path.join(path, "config.yaml")):
            return path, ""
        return path, HUNYUAN_SUBFOLDER

    # -- health ------------------------------------------------------------
    def probe(self) -> EngineHealth:
        details = []
        cuda = False
        try:
            import torch

            cuda = bool(torch.cuda.is_available())
            details.append(f"torch {torch.__version__}")
            if cuda:
                details.append(torch.cuda.get_device_name(0))
        except Exception as err:
            details.append(f"torch NOT importable ({err})")
        installed = _import_available("hy3dgen")
        if not installed:
            details.append("hy3dgen not importable (set PYTHONPATH to an official Hunyuan3D-2 checkout)")
        checkpoint_ok = bool(self.model_path) or bool(self.DEFAULT_REPO_ID)
        if not self.model_path:
            # The fallback repo id is legitimate (the weights may be cached), but
            # an unset HUNYUAN3D_MODEL_PATH remains an operator-visible fact.
            details.append("HUNYUAN3D_MODEL_PATH unset; would resolve tencent/Hunyuan3D-2mv from the HF cache")
        resolved = ""
        if checkpoint_ok:
            try:
                path, subfolder = self.resolve_load_args()
                resolved = path
                if subfolder == "" and os.path.isdir(path):
                    # The directory must contain the mv checkpoint files itself.
                    checkpoint_ok = os.path.exists(os.path.join(path, "model.fp16.safetensors")) or bool(
                        os.path.exists(os.path.join(path, "model.fp16.ckpt"))
                    )
                    resolved = os.path.join(path, "model.fp16.safetensors") if checkpoint_ok else path
            except Exception as err:
                checkpoint_ok = False
                details.append(f"checkpoint resolution failed ({err})")
        if not checkpoint_ok:
            details.append("HUNYUAN3D_MODEL_PATH does not resolve (a directory with the mv files, or the HF repo id)")
        ready = bool(installed and checkpoint_ok and cuda and not self._load_error)
        if self._load_error:
            details.append(f"load error: {self._load_error}")
        return EngineHealth(
            id=self.engine_id,
            adapter=self.adapter_id,
            installed=installed,
            ready=ready,
            detail="; ".join(details) if details else "ready",
            device=self.requested_device,
            checkpoint=resolved,
            cuda=cuda,
            dependencies=list(self.dependencies),
            vramPeakMb=self._last_peak_mb,
        )

    # -- pipeline ----------------------------------------------------------
    def _ensure_pipeline(self):
        if self._pipeline is not None:
            return self._pipeline
        try:
            import torch
            from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        except Exception as err:
            self._load_error = str(err)
            raise AdapterError("ENGINE_NOT_INSTALLED", f"Hunyuan3D-2mv is not importable: {err}") from err
        if not torch.cuda.is_available():
            raise AdapterError(
                "ENGINE_CUDA_REQUIRED",
                "Hunyuan3D-2mv shape generation is CUDA-only here; this machine reports no CUDA device.",
            )
        try:
            from torch.cuda import get_device_properties

            self._total_vram_mb = int(get_device_properties(0).total_memory / (1024 * 1024))
        except Exception:
            self._total_vram_mb = 0
        if not self.model_path:
            raise AdapterError(
                "ENGINE_CHECKPOINT_MISSING",
                "HUNYUAN3D_MODEL_PATH is not set; pass the cached HF repo id "
                "(tencent/Hunyuan3D-2mv) or a local directory holding the mv files.",
            )
        try:
            model_path, subfolder = self.resolve_load_args()
            self.log(f"[hunyuan] loading {model_path} (subfolder={subfolder or '(self directory)'})")
            started = time.time()
            self._pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
                model_path,
                subfolder=subfolder,
                variant="fp16",
                device=self.requested_device,
            )
            self._load_seconds = round(time.time() - started, 1)
        except Exception as err:
            self._load_error = str(err)
            raise AdapterError("ENGINE_LOAD_FAILED", f"Hunyuan3D-2mv could not load: {err}") from err
        self.log(f"[hunyuan] loaded in {self._load_seconds}s on {self.requested_device}")
        if self._total_vram_mb and self._total_vram_mb < PLACEMENT_VRAM_THRESHOLD_MB:
            self._apply_stage_sequential_placement()
        return self._pipeline

    def _apply_stage_sequential_placement(self) -> None:
        """Release the conditioner right after encoding — the official intent.

        The conditioner's only use inside the pipeline is `encode_cond`; moving
        it off the GPU after that releases its residency for the sampling loop.
        NOTHING in hy3dgen is modified: this wraps the instance's bound method.
        """
        import torch

        pipeline = self._pipeline
        device = self.requested_device
        holder = {"conditioner": pipeline.conditioner}
        original_encode = pipeline.encode_cond

        def encode_cond_stage_sequential(image, **kwargs):
            holder["conditioner"].to(device)
            try:
                return original_encode(image, **kwargs)
            finally:
                try:
                    holder["conditioner"].to("cpu")
                except Exception:
                    pass
                torch.cuda.empty_cache()

        pipeline.encode_cond = encode_cond_stage_sequential
        self._applied_placement = True
        self.log(f"[hunyuan] stage-sequential placement applied (card < {PLACEMENT_VRAM_THRESHOLD_MB} MiB total)")

    # -- per-view inference input ------------------------------------------
    def prepare_view(self, frame: dict) -> tuple:
        """RGBA PIL image + measured mask facts for ONE named view. Fails closed."""
        import numpy as np
        from PIL import Image

        data = decode_bytes(frame) or b""
        if not data:
            raise AdapterError("ENGINE_EMPTY_INPUT", "a named view arrived without bytes")
        source_pil = Image.open(io.BytesIO(data)).convert("RGBA")
        facts = {
            "id": str(frame.get("id") or ""),
            "slot": str(frame.get("viewAngle") or frame.get("slot") or ""),
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "width": source_pil.size[0],
            "height": source_pil.size[1],
        }

        alpha = np.asarray(source_pil)[:, :, 3]
        covered = float((alpha >= 128).sum()) / float(alpha.size)
        opaque = float((alpha >= 250).sum()) / float(alpha.size)

        has_matte = covered < 0.995
        if has_matte:
            # The reference ships a real matte; gate it, then use it verbatim.
            _gate_alpha(alpha, facts)
            facts["maskSource"] = "source-alpha"
            facts["maskFgFraction"] = round(covered, 4)
            facts["maskOpaqueFraction"] = round(opaque, 4)
            return source_pil, facts

        if self.worker_mod is None:
            raise AdapterError(
                "SEGMENTATION_UNAVAILABLE",
                f"The {facts['slot']} view has no usable alpha channel and no "
                "segmentation machinery reaches this adapter — an opaque frame "
                "would be reconstructed as full-frame geometry.",
            )
        try:
            alpha_segmented, stats = self.worker_mod.segment_foreground(
                source_pil, model=getattr(self.worker_mod, "DEFAULT_REMBG_MODEL", None)
            )
            self.worker_mod._mask_gates(alpha_segmented, stats)
        except Exception as err:
            code = getattr(err, "code", "MASK_REJECTED")
            raise AdapterError(code, f"The {facts['slot']} view's inference mask was refused: {err}") from err
        solid = np.asarray(source_pil).copy()
        solid[:, :, 3] = alpha_segmented
        facts["maskSource"] = f"rembg-{stats.get('model', 'isnet-general-use')}"
        facts["maskFgFraction"] = stats.get("fgFraction")
        facts["maskOpaqueFraction"] = stats.get("opaqueFraction")
        facts["maskLargestShare"] = stats.get("largestShare")
        facts["maskBorderSides"] = stats.get("borderSides")
        facts["maskIslands"] = stats.get("maskIslands")
        return Image.fromarray(solid, "RGBA"), facts

    # -- inference ---------------------------------------------------------
    def run(self, payload: dict, task=None) -> InferenceResult:
        import torch

        images = payload.get("images") or []
        try:
            selected = validate_hunyuan_inputs(images)
        except ContractError as err:
            raise AdapterError(err.code, str(err)) from err

        prepared = []
        view_facts = []
        for frame in selected:
            pil, facts = self.prepare_view(frame)
            prepared.append((facts["slot"], pil))
            view_facts.append(facts)
        image_dict = {slot: pil for slot, pil in prepared}

        pipeline = self._ensure_pipeline()

        options = payload.get("options") or {}
        resolution = int(options.get("octreeResolution") or self.OCTREE_RESOLUTION)
        steps = int(options.get("numInferenceSteps") or 50)
        guidance = float(options.get("guidanceScale") or 5.0)
        chunks = int(options.get("numChunks") or 8000)
        seed = int(options.get("seed") or 1234)
        if resolution != self.OCTREE_RESOLUTION:
            # 256 is the validated starting point; a different value is recorded,
            # never silently used as if it were the documented default.
            self.log(f"[hunyuan] octree resolution overridden to {resolution}")

        _set_task(task, "shape-generation", 20)
        generator = torch.Generator(device=self.requested_device).manual_seed(seed)
        torch.cuda.reset_peak_memory_stats()
        started = time.time()
        try:
            output = pipeline(
                image=image_dict,
                num_inference_steps=steps,
                octree_resolution=resolution,
                num_chunks=chunks,
                guidance_scale=guidance,
                generator=generator,
            )
        except TypeError as err:
            # A signature mismatch must be visible, never worked around by
            # dropping arguments that determine the output.
            raise AdapterError(
                "ENGINE_PIPELINE_SIGNATURE",
                f"The installed Hunyuan3D-2mv pipeline rejected the documented arguments: {err}",
            ) from err
        except Exception as err:
            raise AdapterError("ENGINE_INFERENCE_FAILED", f"Hunyuan3D-2mv inference failed: {err}") from err
        shape_ms = int((time.time() - started) * 1000)
        self._last_peak_mb = (
            int(torch.cuda.max_memory_allocated() / (1024 * 1024)) if torch.cuda.is_available() else 0
        )

        mesh = _extract_mesh(output)
        if mesh is None or not hasattr(mesh, "export"):
            raise AdapterError("ENGINE_EMPTY_MODEL", "Hunyuan3D-2mv returned no exportable mesh")

        exported_at = time.time()
        try:
            glb = mesh.export(file_type="glb", include_normals=True)
        except Exception as err:
            raise AdapterError("ENGINE_EXPORT_FAILED", f"the reconstructed mesh could not be exported: {err}") from err
        glb = bytes(glb or b"")
        if len(glb) < 12 or glb[:4] != b"glTF":
            raise AdapterError("ENGINE_EXPORT_FAILED", "the exported file is not a GLB container")
        export_ms = int((time.time() - exported_at) * 1000)

        metrics = {
            "engine": self.engine_id,
            "adapter": self.adapter_id,
            "model": self.model,
            "modelVersion": self.model_version,
            "device": self.requested_device,
            "gpuName": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
            "totalVramMb": self._total_vram_mb,
            "vramPeakMb": self._last_peak_mb,
            "modelLoadSeconds": self._load_seconds,
            "stageSequentialPlacement": self._applied_placement,
            "checkpointSubfolder": HUNYUAN_SUBFOLDER,
            "checkpoint": os.path.expanduser(self.model_path) or self.DEFAULT_REPO_ID,
            "octreeResolution": resolution,
            "numInferenceSteps": steps,
            "guidanceScale": guidance,
            "numChunks": chunks,
            "seed": seed,
            "shapeOnly": True,
            "textureStage": "not_run",
            "inputMode": "named_multi_view",
            "inputViews": view_facts,
            "timing": {"shapeMs": shape_ms, "exportMs": export_ms},
            "bytes": len(glb),
            "glbSha256": hashlib.sha256(glb).hexdigest(),
        }
        return InferenceResult(
            glb=glb,
            metrics=metrics,
            engine_id=self.engine_id,
            adapter=self.adapter_id,
        )


def _gate_alpha(alpha, facts: dict) -> None:
    """Refuse a shipped matte that cannot define a product silhouette.

    The thresholds are the worker's own MASK_* floors, restated here ONLY for
    the shipped-alpha case — when rembg runs, the shared measurement in
    `worker._mask_gates` is used instead so the discipline stays single-sourced.
    """
    import numpy as np

    alpha = np.asarray(alpha)
    total = int(alpha.size)
    mask = alpha >= 128
    fg = float(mask.sum()) / total
    opaque = float((alpha >= 250).sum()) / total
    if mask.all():
        raise AdapterError("MASK_FULL_FRAME", f"{facts['slot']}: the shipped alpha covers the whole frame")
    if fg < 0.02:
        raise AdapterError("MASK_EMPTY", f"{facts['slot']}: the shipped alpha covers only {fg:.1%} of the frame")
    ratio = opaque / fg if fg > 0 else 0.0
    if opaque < 0.05 or ratio < 0.22:
        raise AdapterError(
            "MASK_WASHY",
            f"{facts['slot']}: only {opaque:.1%} of the frame has a solid foreground core ({ratio:.0%} of the mask)",
        )


def _set_task(task, stage: str, progress: int) -> None:
    try:
        task.stage = stage
        task.progress = progress
    except Exception:
        pass
