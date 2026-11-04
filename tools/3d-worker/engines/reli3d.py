"""ReLi3D adapter — pose-aware, relightable multi-view reconstruction.

THE CONTRACT THIS ADAPTER ENFORCES
    · Every input is an RGBA PNG frame. A JPEG has no matte and is refused.
    · Every frame carries a RECORDED camera-to-world pose and FOV. There is no
      estimation path: `contract.validate_reli3d_inputs` refuses the whole set if
      one frame lacks a pose, and `transforms.json` is generated from the recorded
      numbers (with a `provenance` block saying they were recorded, not inferred).
    · The OFFICIAL entrypoint is invoked as a subprocess — the release's own
      `demos/reli3d/infer_from_transforms.py`, addressed through its documented
      CLI (`--input-root`, `--objects`, `--output-root`, `--num-views`, `--checkpoint`,
      `--overwrite`). No vendored copy, no reimplementation, no "close enough" runner.
    · The official LAYOUT is used verbatim: an objects root containing one object
      directory per set, `transforms.json` at its root and the RGBA frames under
      `rgba/` — exactly what `demos/reli3d/infer_from_transforms.py:_load_object_data`
      reads (frames' `file_path` is relative to the object directory, frames sort
      on `view_index`, `camera_fov` is in RADIANS, and an absent principal point
      defaults to the pixel centre).
    · `mesh.glb`, `illumination.hdr` and `run_info.json` are returned as SEPARATE
      artifacts. The backend stores them privately beside the GLB; they are never
      merged into the mesh.

HONEST STATUS
    This adapter has never run a real reconstruction in this workspace: no
    RELI3D_HOME, checkpoint or entrypoint is installed, and the official native
    extensions (`uv_unwrapper`, `texture_baker`) cannot be compiled here (no CUDA
    toolkit / MSVC on this machine). `probe()` says so, and the capture registry
    keeps the engine's evidence at `unverified` until a genuine model is produced,
    inspected and recorded. Nothing here may be presented as measured.
"""

from __future__ import annotations

import glob
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Optional

from .base import AdapterError, EngineHealth, InferenceResult, LocalEngineAdapter
from .contract import ContractError, decode_bytes, transforms_bytes, validate_reli3d_inputs

OFFICIAL_ENTRYPOINT = os.path.join("demos", "reli3d", "infer_from_transforms.py")
OFFICIAL_CONFIG = os.path.join("artifacts", "model", "config.yaml")
OFFICIAL_CHECKPOINT = os.path.join("artifacts", "model", "reli3d_final.ckpt")


class ReLi3DAdapter(LocalEngineAdapter):
    adapter_id = "reli3d"
    engine_id = "reli3d"
    model = "ReLi3D"
    model_version = "reli3d-1.0"
    dependencies = ["torch", "reli3d"]
    produces_artifacts = ["illumination", "run-info"]

    def __init__(self, device: str = "cuda:0", home: str = "", entrypoint: str = "", log=print) -> None:
        self.requested_device = device
        self.home = home or os.environ.get("RELI3D_HOME", "")
        self.entrypoint = entrypoint or os.environ.get("RELI3D_ENTRYPOINT", "")
        self.log = log
        self._last_peak_mb = 0

    @property
    def load_error(self) -> str:
        return ""  # the official entrypoint loads nothing at adapter time

    # -- paths -------------------------------------------------------------
    def resolved_entrypoint(self) -> str:
        if self.entrypoint:
            return self.entrypoint
        if self.home:
            for candidate in (
                os.path.join(self.home, OFFICIAL_ENTRYPOINT),
                os.path.join(self.home, "inference.py"),  # legacy individuals' layout
            ):
                if os.path.exists(candidate):
                    return candidate
        return ""

    def config_path(self) -> str:
        explicit = os.environ.get("RELI3D_CONFIG", "")
        if explicit and os.path.exists(explicit):
            return explicit
        if self.home:
            for candidate in (
                os.path.join(self.home, OFFICIAL_CONFIG),
                os.path.join(self.home, "artifacts", "model", "raw.yaml"),
            ):
                if os.path.exists(candidate):
                    return candidate
        return ""

    def checkpoint_path(self) -> str:
        explicit = os.environ.get("RELI3D_CHECKPOINT", "")
        if explicit:
            return explicit
        if self.home:
            official = os.path.join(self.home, OFFICIAL_CHECKPOINT)
            if os.path.exists(official):
                return official
            for pattern in ("*.pth", "*.pt", "*.ckpt", "checkpoints/*", "weights/*"):
                matches = glob.glob(os.path.join(self.home, pattern))
                if matches:
                    return matches[0]
        return ""

    # -- health ------------------------------------------------------------
    def probe(self) -> EngineHealth:
        details = []
        cuda = False
        try:
            import torch

            cuda = bool(torch.cuda.is_available())
            details.append(f"torch {torch.__version__}")
        except Exception as err:
            details.append(f"torch NOT importable ({err})")
        home_ok = bool(self.home) and os.path.isdir(self.home)
        if not home_ok:
            details.append("RELI3D_HOME is not a directory (clone Stability-AI/ReLi3D there)")
        entry = self.resolved_entrypoint()
        entry_ok = bool(entry) and os.path.exists(entry)
        if not entry_ok:
            details.append("the official entrypoint (demos/reli3d/infer_from_transforms.py) was not found")
        checkpoint = self.checkpoint_path()
        checkpoint_ok = bool(checkpoint) and os.path.exists(checkpoint)
        if not checkpoint_ok:
            details.append("no checkpoint resolved from RELI3D_CHECKPOINT / RELI3D_HOME/artifacts/model/reli3d_final.ckpt")
        config = self.config_path()
        config_ok = bool(config)
        if not config_ok:
            details.append("no config.yaml resolved under RELI3D_HOME/artifacts/model")
        # `reli3d` is not a pip package: the release imports its own `src/`, so
        # its presence plus a working venv is what "installed" can honestly mean
        # here. The native extension build (uv_unwrapper / texture_baker) is the
        # operator step documented in the official README — probed indirectly
        # through the entrypoint's own import of src at run time.
        package_ok = home_ok and entry_ok
        ready = bool(entry_ok and checkpoint_ok and cuda and package_ok and config_ok)
        return EngineHealth(
            id=self.engine_id,
            adapter=self.adapter_id,
            installed=package_ok,
            ready=ready,
            detail="; ".join(details) if details else "ready",
            device=self.requested_device,
            checkpoint=checkpoint,
            cuda=cuda,
            dependencies=list(self.dependencies),
            vramPeakMb=self._last_peak_mb,
        )

    # -- inference ---------------------------------------------------------
    def run(self, payload: dict, task=None) -> InferenceResult:
        frames = payload.get("images") or []
        try:
            transforms = validate_reli3d_inputs(frames)
        except ContractError as err:
            raise AdapterError(err.code, str(err)) from err

        entry = self.resolved_entrypoint()
        if not entry or not os.path.exists(entry):
            raise AdapterError(
                "ENGINE_NOT_INSTALLED",
                "The official ReLi3D entrypoint was not found (RELI3D_HOME with "
                "demos/reli3d/infer_from_transforms.py, or RELI3D_ENTRYPOINT).",
            )
        checkpoint = self.checkpoint_path()
        if not checkpoint:
            raise AdapterError(
                "ENGINE_CHECKPOINT_MISSING",
                "No ReLi3D checkpoint is installed (RELI3D_CHECKPOINT, or "
                "RELI3D_HOME/artifacts/model/reli3d_final.ckpt).",
            )

        work_dir = tempfile.mkdtemp(prefix="flora-reli3d-")
        objects_root = os.path.join(work_dir, "objects")
        output_root = os.path.join(work_dir, "outputs")
        object_dir = os.path.join(objects_root, "product")
        rgba_dir = os.path.join(object_dir, "rgba")
        os.makedirs(rgba_dir, exist_ok=True)
        os.makedirs(output_root, exist_ok=True)

        try:
            # Write exactly the frames the transforms file names, byte for byte.
            for index, (frame, frame_json) in enumerate(zip(frames, transforms["frames"])):
                data = decode_bytes(frame) or b""
                with open(os.path.join(object_dir, frame_json["file_path"]), "wb") as handle:
                    handle.write(data)
            with open(os.path.join(object_dir, "transforms.json"), "wb") as handle:
                handle.write(transforms_bytes(transforms))

            _set_task(task, "reli3d-inference", 20)

            args = [
                sys.executable,
                entry,
                "--input-root", objects_root,
                "--objects", "product",
                "--output-root", output_root,
                "--num-views", str(len(frames)),
                "--checkpoint", checkpoint,
                "--overwrite",
            ]
            config = self.config_path()
            if config:
                args += ["--config", config]
            texture_size = os.environ.get("RELI3D_TEXTURE_SIZE", "")
            if texture_size:
                args += ["--texture-size", texture_size]

            # The official demo auto-downloads missing Stage artifacts from the
            # HF hub; this pipeline NEVER does that silently.
            if os.environ.get("RELI3D_ALLOW_HF_DOWNLOAD") != "1":
                args += ["--disable-hf-download"]

            timeout = int(os.environ.get("RELI3D_TIMEOUT_SECONDS", "1800"))
            started = time.time()
            try:
                completed = subprocess.run(
                    args,
                    cwd=self.home or os.path.dirname(entry),
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired as err:
                raise AdapterError(
                    "ENGINE_TIMEOUT",
                    f"The ReLi3D entrypoint did not finish within {timeout}s.",
                ) from err
            elapsed_ms = int((time.time() - started) * 1000)
            if completed.returncode != 0:
                tail = ((completed.stderr or "") + "\n" + (completed.stdout or "")).strip()[-800:]
                raise AdapterError(
                    "ENGINE_INFERENCE_FAILED",
                    f"The ReLi3D entrypoint exited {completed.returncode}: {tail or 'no output'}",
                )

            produced = {
                "mesh": os.path.join(output_root, "product", "mesh.glb"),
                "illumination": os.path.join(output_root, "product", "illumination.hdr"),
                "run-info": os.path.join(output_root, "product", "run_info.json"),
            }
            missing = [name for name, path in produced.items() if not os.path.exists(path)]
            if missing:
                raise AdapterError(
                    "ENGINE_ARTIFACT_MISSING",
                    f"ReLi3D did not produce: {', '.join(missing)}. All of mesh.glb, illumination.hdr "
                    "and run_info.json are required, and none is invented here.",
                )

            with open(produced["mesh"], "rb") as handle:
                glb = handle.read()
            if len(glb) < 12 or glb[:4] != b"glTF":
                raise AdapterError("ENGINE_EXPORT_FAILED", "ReLi3D's mesh.glb is not a GLB container")
            with open(produced["illumination"], "rb") as handle:
                illumination = handle.read()
            with open(produced["run-info"], "rb") as handle:
                run_info = handle.read()
            try:
                run_info_json = json.loads(run_info.decode("utf-8"))
            except Exception as err:
                raise AdapterError("ENGINE_ARTIFACT_INVALID", f"run_info.json is not valid JSON: {err}") from err

            metrics = {
                "engine": self.engine_id,
                "adapter": self.adapter_id,
                "model": self.model,
                "modelVersion": self.model_version,
                "device": self.requested_device,
                "frameCount": len(frames),
                "inputMode": "posed_rgba",
                "requiresPose": True,
                "officialEntrypoint": os.path.relpath(entry, self.home) if self.home else entry,
                "transformsSha256": hashlib.sha256(transforms_bytes(transforms)).hexdigest(),
                "frameHashes": [frame["sha256"] for frame in transforms["frames"]],
                "poseSources": transforms["provenance"]["poseSources"],
                "inferredPoses": 0,
                "cameraFovUnit": "radians-in-transforms-json",
                "timing": {"inferenceMs": elapsed_ms},
                "bytes": len(glb),
                "glbSha256": hashlib.sha256(glb).hexdigest(),
                "artifacts": {
                    "illumination": {"bytes": len(illumination), "sha256": hashlib.sha256(illumination).hexdigest()},
                    "run-info": {"bytes": len(run_info), "sha256": hashlib.sha256(run_info).hexdigest()},
                },
                "runInfo": run_info_json if isinstance(run_info_json, dict) else {},
                "checkpoint": checkpoint,
                "entrypoint": entry,
            }
            return InferenceResult(
                glb=glb,
                metrics=metrics,
                engine_id=self.engine_id,
                adapter=self.adapter_id,
                artifacts={"illumination": illumination, "run-info": run_info},
                artifact_types={
                    "illumination": "image/vnd.radiance",
                    "run-info": "application/json",
                },
            )
        finally:
            # The ORIGINAL reference images stay in the backend's private storage;
            # this working copy is disposable unless an operator asks to keep it
            # for an audit of a specific run.
            if os.environ.get("RELI3D_KEEP_WORKDIR") == "1":
                self.log(f"[reli3d] kept working directory {work_dir}")
            else:
                shutil.rmtree(work_dir, ignore_errors=True)


def _set_task(task, stage: str, progress: int) -> None:
    try:
        task.stage = stage
        task.progress = progress
    except Exception:
        pass
