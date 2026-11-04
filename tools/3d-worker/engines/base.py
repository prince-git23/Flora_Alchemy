"""The adapter interface every local engine implements."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


class AdapterError(Exception):
    """A refusal from an adapter, with a code the backend records verbatim."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class EngineHealth:
    """One probe result. `ready` is a measurement, never an assumption."""

    id: str
    adapter: str
    installed: bool
    ready: bool
    detail: str = ""
    device: str = ""
    checkpoint: str = ""
    cuda: bool = False
    dependencies: List[str] = field(default_factory=list)
    vramPeakMb: int = 0

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "adapter": self.adapter,
            "installed": self.installed,
            "ready": self.ready,
            "detail": self.detail,
            "device": self.device,
            "checkpoint": self.checkpoint,
            "cuda": self.cuda,
            "dependencies": list(self.dependencies),
            "vramPeakMb": self.vramPeakMb,
        }


@dataclass
class InferenceResult:
    """Bytes + facts from ONE successful reconstruction."""

    glb: bytes
    metrics: dict
    engine_id: str
    adapter: str
    artifacts: Dict[str, bytes] = field(default_factory=dict)
    # Artifact content types the agent uses when uploading; facts only.
    artifact_types: Dict[str, str] = field(default_factory=dict)


class LocalEngineAdapter:
    """One engine. Subclasses must not fall back to another engine, ever."""

    adapter_id = ""
    engine_id = ""
    model = ""
    model_version = ""
    dependencies: List[str] = []
    produces_artifacts: List[str] = []

    def probe(self) -> EngineHealth:
        raise NotImplementedError

    def run(self, payload: dict, cancel_event=None) -> InferenceResult:
        raise NotImplementedError

    def health(self) -> dict:
        return self.probe().as_dict()

    @property
    def ready(self) -> bool:
        try:
            return bool(self.probe().ready)
        except Exception:
            return False
