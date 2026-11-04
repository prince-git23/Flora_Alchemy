"""Local reconstruction engine adapters for the Flora Alchemy GPU agent.

Each module in this package is ONE adapter and owns exactly one engine. The
agent never infers which engine to use: the backend persists an engine id with
the job, the claim payload names the adapter, and a missing adapter FAILS the
job. There is deliberately no fallback from one engine to another — a TripoSR
result delivered for a Hunyuan job would be a lie about provenance.
"""

from .base import AdapterError, EngineHealth, InferenceResult, LocalEngineAdapter
from .registry import ADAPTERS, build_registry, describe_engines

__all__ = [
    "ADAPTERS",
    "AdapterError",
    "EngineHealth",
    "InferenceResult",
    "LocalEngineAdapter",
    "build_registry",
    "describe_engines",
]
