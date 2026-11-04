"""The agent's adapter registry — several local engines, one queue.

The backend persists an engine id with every job; the claim payload names the
ADAPTER; this registry resolves that name to an installed adapter or refuses.
There is no ordering fallback and no \"try the next engine\" — a job that cannot
run on this machine stays queued (or fails with a reason), because silently
substituting an engine would mislabel the provenance of the model a human is
about to approve.

An adapter is built only when it was requested (`THREE_WORKER_AGENT_ENGINES`, or
`--engines`). Its probe is independent: TripoSR may load while Hunyuan has no
checkpoint, and the heartbeat reports both truthfully.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from .base import EngineHealth, LocalEngineAdapter
from .hunyuan3d import Hunyuan3D2mvAdapter
from .reli3d import ReLi3DAdapter
from .triposr import TripoSRAdapter

# adapter id -> class. Engine ids (`hunyuan3d_2mv`, `reli3d`, `local_single_view`)
# are accepted as aliases when selecting adapters.
ADAPTERS = {
    "triposr": TripoSRAdapter,
    "hunyuan3d_2mv": Hunyuan3D2mvAdapter,
    "reli3d": ReLi3DAdapter,
}

ALIASES = {
    "local_single_view": "triposr",
    "hunyuan": "hunyuan3d_2mv",
    "hunyuan3d": "hunyuan3d_2mv",
    "reli": "reli3d",
}


def normalise_adapter_id(value: str) -> str:
    key = str(value or "").strip().lower()
    return ALIASES.get(key, key)


def describe_engines() -> List[dict]:
    """Static metadata for diagnostics. Never claims readiness."""
    return [
        {
            "id": cls.engine_id,
            "adapter": cls.adapter_id,
            "model": cls.model,
            "modelVersion": cls.model_version,
            "dependencies": list(cls.dependencies),
            "producesArtifacts": list(cls.produces_artifacts),
        }
        for cls in ADAPTERS.values()
    ]


class EngineRegistry:
    def __init__(self, adapters: Dict[str, LocalEngineAdapter], requested: List[str], log=print) -> None:
        self.adapters = adapters
        self.requested = requested
        self.log = log

    # -- lifecycle ---------------------------------------------------------
    def load(self) -> None:
        for adapter in self.adapters.values():
            loader = getattr(adapter, "load", None)
            if callable(loader):
                try:
                    loader()
                except Exception as err:  # a probe will report the failure
                    self.log(f"[engines] {adapter.adapter_id} load failed: {err}")

    # -- resolution --------------------------------------------------------
    def get(self, key: str) -> Optional[LocalEngineAdapter]:
        return self.adapters.get(normalise_adapter_id(key))

    def health(self) -> List[dict]:
        out = []
        for adapter in self.adapters.values():
            try:
                out.append(adapter.probe().as_dict())
            except Exception as err:
                out.append(
                    EngineHealth(
                        id=adapter.engine_id,
                        adapter=adapter.adapter_id,
                        installed=False,
                        ready=False,
                        detail=f"probe failed: {err}",
                    ).as_dict()
                )
        return out

    def claimable(self) -> List[str]:
        """ADAPTER ids this machine can run right now — the only ones it claims."""
        ready = []
        for adapter in self.adapters.values():
            try:
                if adapter.probe().ready:
                    ready.append(adapter.adapter_id)
            except Exception:
                continue
        return ready

    def loaded(self) -> bool:
        return bool(self.claimable())

    def primary(self) -> Optional[LocalEngineAdapter]:
        for adapter in self.adapters.values():
            try:
                if adapter.probe().ready:
                    return adapter
            except Exception:
                continue
        return next(iter(self.adapters.values()), None)

    def describe(self) -> List[dict]:
        return [
            {
                "id": adapter.engine_id,
                "adapter": adapter.adapter_id,
                "model": adapter.model,
                "requested": adapter.adapter_id in self.requested,
            }
            for adapter in self.adapters.values()
        ]


def build_registry(
    selected: str = "triposr",
    *,
    worker_mod=None,
    worker_args=None,
    device: str = "cuda:0",
    log=print,
) -> EngineRegistry:
    """Build the adapters named by `selected` (comma-separated engine/adapter ids).

    Unknown names are kept in `requested` but produce no adapter: the agent then
    reports it cannot run them, which is the truth. An empty selection falls back
    to TripoSR for backwards compatibility with agents started before engines.
    """
    names = [normalise_adapter_id(part) for part in str(selected or "").split(",") if part.strip()]
    if not names:
        names = ["triposr"]
    adapters: Dict[str, LocalEngineAdapter] = {}
    for name in names:
        if name == "triposr" and worker_mod is not None and worker_args is not None:
            adapters[name] = TripoSRAdapter(worker_mod, worker_args, log=log)
        elif name == "hunyuan3d_2mv":
            # worker_mod reaches the shared fail-closed segmentation used for
            # per-view inference inputs (the official processor masks on alpha).
            adapters[name] = Hunyuan3D2mvAdapter(device=device, worker_mod=worker_mod, log=log)
        elif name == "reli3d":
            adapters[name] = ReLi3DAdapter(device=device, log=log)
        else:
            log(f"[engines] ignoring unknown or unbuildable engine \"{name}\"")
    if not adapters:
        log("[engines] no adapter could be built; this agent will claim nothing")
    return EngineRegistry(adapters, names, log=log)
