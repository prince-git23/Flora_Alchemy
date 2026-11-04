"""TripoSR adapter — the EXISTING, measured baseline.

This adapter deliberately adds nothing to the engine. It wraps the Phase 4
`worker.Engine` (the same checkpoint, the same foreground hardening, the same
canonical orientation, the same GLB export) so the multi-engine agent can
dispatch to it without changing a single byte of the path that already works.

The only new behaviour is BOOKKEEPING: it reports which model version ran, on
which device, with which input hashes, and returns the worker's own metrics.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import time
from typing import Optional

from .base import AdapterError, EngineHealth, InferenceResult, LocalEngineAdapter


class TripoSRAdapter(LocalEngineAdapter):
    adapter_id = "triposr"
    engine_id = "local_single_view"
    model = "TripoSR"
    model_version = "triposr-1.0"
    dependencies = ["torch", "tsr"]
    produces_artifacts = []

    def __init__(self, worker_mod, worker_args, log=print) -> None:
        self.worker_mod = worker_mod
        self.worker_args = worker_args
        self.log = log
        self.engine = None
        self.load_error: Optional[str] = None

    # -- model -------------------------------------------------------------
    def load(self) -> None:
        try:
            self.engine = self.worker_mod.Engine(self.worker_args)
            self.engine.load()
            self.load_error = None
        except Exception as err:  # a failed load is a reported fact, not a crash
            self.load_error = str(err)
            self.log(f"[triposr] model load failed: {err}")

    @property
    def device(self) -> str:
        return getattr(self.engine, "device", "")

    @property
    def gpu_name(self) -> str:
        return getattr(self.engine, "gpu_name", "")

    @property
    def vram_total_mb(self) -> int:
        return getattr(self.engine, "vram_total_mb", 0)

    # -- health ------------------------------------------------------------
    def probe(self) -> EngineHealth:
        details = []
        deps = []
        cuda = False
        try:
            import torch

            cuda = bool(torch.cuda.is_available())
            details.append(f"torch {torch.__version__}")
        except Exception as err:
            details.append(f"torch NOT importable ({err})")
        for module in ("tsr", "torchmcubes"):
            present = importlib.util.find_spec(module) is not None
            deps.append(module)
            if not present:
                details.append(f"{module} missing")
        checkpoint = os.path.abspath(getattr(self.worker_args, "triposr_home", "") or "")
        if not checkpoint or not os.path.isdir(checkpoint):
            details.append("TRIPOSR_HOME does not resolve to a checkout")
        ready = bool(self.engine and getattr(self.engine, "model", None) is not None and not self.load_error)
        if self.load_error:
            details.append(f"load error: {self.load_error}")
        return EngineHealth(
            id=self.engine_id,
            adapter=self.adapter_id,
            installed=True,
            ready=ready,
            detail=("ready on " + (self.device or "unknown device") if ready else "; ".join(details) or "model not loaded"),
            device=self.device,
            checkpoint=checkpoint,
            cuda=cuda,
            dependencies=deps,
            vramPeakMb=0,
        )

    # -- inference ---------------------------------------------------------
    def run(self, payload: dict, task=None) -> InferenceResult:
        if not self.engine or getattr(self.engine, "model", None) is None:
            raise AdapterError("ENGINE_NOT_LOADED", self.load_error or "the TripoSR model is not loaded")

        started = time.time()
        worker_task = task or self.worker_mod.Task(id=f"adapter-{int(started)}")
        self.engine.run_task(worker_task, payload)

        if worker_task.status == "cancelled":
            raise AdapterError("ENGINE_CANCELLED", "the job was cancelled during TripoSR inference")
        if worker_task.status != "succeeded":
            error = worker_task.error or {}
            raise AdapterError(
                str(error.get("code") or "TRIPOSR_INFERENCE_FAILED"),
                str(error.get("message") or "TripoSR inference failed"),
            )

        glb = bytes(worker_task.glb or b"")
        if not glb:
            raise AdapterError("ENGINE_EMPTY_MODEL", "TripoSR produced no GLB bytes")

        metrics = dict(worker_task.result or {})
        metrics.update(
            {
                "engine": self.engine_id,
                "adapter": self.adapter_id,
                "engineVersion": self.model_version,
                "timing": {
                    "inferenceMs": int((time.time() - started) * 1000),
                },
                "glbSha256": hashlib.sha256(glb).hexdigest(),
            }
        )
        return InferenceResult(
            glb=glb,
            metrics=metrics,
            engine_id=self.engine_id,
            adapter=self.adapter_id,
        )
