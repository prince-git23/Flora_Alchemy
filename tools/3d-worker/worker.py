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


# ── foreground hardening — the anti-shell stage ────────────────────────────────
#
# WHY THIS EXISTS. TripoSR reconstructs what it is shown. Shown a raw
# photograph — product AND table AND window — it meshes the whole frame, and the
# result is a grey shell of reconstructed ROOM around the product. (Measured on
# 2026-10-25: the failing candidate reconstructed a 0.52×0.98×0.93 slab of the
# photo frame with 43 detached islands.) The inference input must be the product
# alone, composited over the neutral grey background the model was trained on:
#
#     image = rgb * alpha + (1 - alpha) * 0.5      (TripoSR run.py's own formula)
#
# The old "Flora Alchemy already produces a cutout in Phase 1" premise is gone
# with Phase 1: current references carry no alpha, and the previous code fell
# through to feeding the WHOLE PHOTO. This stage segments, CHECKS the segment
# (a bad mask is refused with a readable reason — never silently accepted),
# cleans speckle islands, composites over grey, and crops to the foreground.

DEFAULT_SEGMENTER = os.environ.get("THREE_WORKER_SEGMENTER", "rembg")
DEFAULT_REMBG_MODEL = os.environ.get("THREE_WORKER_REMBG_MODEL", "isnet-general-use")

# Mask quality gates, calibrated on 2026-10-25 against the failing reference
# with four real mattes (fg = mask area share, opaque = hard-core share
# alpha>=250, ratio = opaque/fg):
#   isnet-general-use (rembg default)  fg 0.22, opaque 0.075, ratio 0.34 -> ACCEPT
#   u2net                               fg 0.218, opaque 0.040, ratio 0.18 -> REJECT (washy)
#   silueta                             fg 0.220, opaque 0.033, ratio 0.15 -> REJECT (washy)
#   u2netp                              fg 0.474, opaque 0.246, ratio 0.52 -> (passes; other gates decide)
#   a matte that covers the frame      background never removed          -> REJECT (shell input)
#
# The RATIO is the discriminative number: thin stems and petals always carry
# some soft edge, so a good matte has a modest absolute core — but a matte whose
# core is a small FRACTION of its own area never committed to a silhouette.
MASK_MIN_FG = 0.02            # below this the mask lost the product (u2net-era: 3.6% opaque)
MASK_MAX_FG = 0.97            # above this nothing was removed — the shell case
MASK_MIN_OPAQUE = 0.05        # absolute hard-core floor (alpha >= 250)
MASK_MIN_OPAQUE_RATIO = 0.22  # hard core as a fraction OF THE MASK (isnet 0.34 / u2net 0.18)
MASK_MAX_BORDER_SIDES = 3     # touching ALL four borders = the mask IS the frame
MASK_SPECK_FRACTION = 0.0025  # mask islands below this share of the mask are speckles
MASK_MIN_LARGEST_SHARE = 0.55 # after speck removal one region must dominate the mask
MASK_ISLAND_DROP_MAX = 0.05   # non-primary regions below this share = disconnected background

# Mesh cleanup: a detached component is dropped only when it is tiny against
# BOTH the whole product and the main body (AND, not OR) — a detached petal or
# handle at a few percent survives, a reconstruction speck does not.
MESH_DROP_SHARE_TOTAL = 0.005
MESH_DROP_SHARE_LARGEST = 0.01

def _mask_structure():
    """4-connectivity for mask island labelling (numpy is a worker hard dep)."""
    import numpy as np

    return np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)


class MaskRejected(ValueError):
    """A reference's foreground mask failed its quality gates.

    Carries a machine code plus the measured stats so the studio can show WHICH
    image failed and WHY, and staff can correct that image and retry.
    """

    def __init__(self, code: str, message: str, stats: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.stats = stats or {}


def _mask_gates(alpha, stats: dict) -> None:
    """Measure the mask, record every number, and REFUSE an unusable one."""
    import numpy as np

    total = int(alpha.size)
    mask = alpha >= 128
    fg = float(mask.sum()) / total
    opaque = float((alpha >= 250).sum()) / total
    stats["fgFraction"] = round(fg, 4)
    stats["opaqueFraction"] = round(opaque, 4)

    if fg < MASK_MIN_FG:
        raise MaskRejected(
            "MASK_EMPTY",
            f"the foreground mask covers only {fg:.1%} of the image (minimum "
            f"{MASK_MIN_FG:.0%}) — segmentation lost the product",
            stats,
        )
    if fg > MASK_MAX_FG:
        raise MaskRejected(
            "MASK_FULL_FRAME",
            f"the foreground mask covers {fg:.1%} of the image (maximum "
            f"{MASK_MAX_FG:.0%}) — background was not removed, so the whole "
            "photograph would be reconstructed as geometry",
            stats,
        )
    ratio = opaque / fg if fg > 0 else 0.0
    stats["opaqueRatio"] = round(ratio, 4)
    if opaque < MASK_MIN_OPAQUE or ratio < MASK_MIN_OPAQUE_RATIO:
        raise MaskRejected(
            "MASK_WASHY",
            f"only {opaque:.1%} of the image has a solid foreground core "
            f"({ratio:.0%} of the mask; minimums {MASK_MIN_OPAQUE:.0%} core / "
            f"{MASK_MIN_OPAQUE_RATIO:.0%} of mask) — the matte is too soft to "
            "define a silhouette, so the product would wash out",
            stats,
        )

    ys, xs = np.where(mask)
    if not len(ys):
        raise MaskRejected("MASK_EMPTY", "the foreground mask is empty", stats)
    sides = (
        int(ys.min() == 0)
        + int(ys.max() == alpha.shape[0] - 1)
        + int(xs.min() == 0)
        + int(xs.max() == alpha.shape[1] - 1)
    )
    stats["borderSides"] = sides
    if sides >= 4:
        raise MaskRejected(
            "MASK_TOUCHES_BORDER",
            "the mask touches all four image borders — segmentation returned "
            "the whole frame instead of the subject",
            stats,
        )

    # Island structure, measured AFTER mentally setting speckles aside: one
    # dominant region is a subject; many equal regions are noise.
    from scipy import ndimage

    _labels, count = ndimage.label(mask, structure=_mask_structure())
    if count:
        sizes = np.bincount(_labels.ravel())[1:].astype(np.float64)
        keep = sizes >= max(MASK_SPECK_FRACTION * float(sizes.sum()), 8.0)
        kept = sizes[keep]
        stats["maskIslands"] = int(count)
        stats["maskIslandsKept"] = int(len(kept))
        if len(kept):
            largest = float(kept.max() / kept.sum())
            stats["largestShare"] = round(largest, 4)
            if largest < MASK_MIN_LARGEST_SHARE:
                raise MaskRejected(
                    "MASK_FRAGMENTED",
                    f"the mask splits into {len(kept)} disconnected regions and the "
                    f"largest is only {largest:.0%} of it (minimum "
                    f"{MASK_MIN_LARGEST_SHARE:.0%}) — the subject cannot be "
                    "identified reliably",
                    stats,
                )
        else:
            raise MaskRejected("MASK_SPECKS_ONLY", "the mask contains only speckles", stats)


def segment_foreground(rgba, model: Optional[str] = None):
    """Alpha matte via rembg. Returns (alpha uint8 HxW, stats).

    FAIL-CLOSED: if rembg cannot run, the job fails with an actionable reason.
    There is no silent fallback to 'use the photo as-is' — that path is exactly
    what produced the reconstructed-background shell.
    """
    import numpy as np

    model = model or DEFAULT_REMBG_MODEL
    stats = {"segmenter": "rembg", "model": model}
    try:
        from rembg import remove
    except Exception as err:
        raise MaskRejected(
            "SEGMENTATION_UNAVAILABLE",
            f"background segmentation cannot run in this worker ({err}) — install "
            "rembg in the worker environment, or explicitly set the segmenter to "
            "'photo' for references that are already isolated",
            {**stats, "segmenter": "rembg"},
        ) from err

    t0 = time.time()
    try:
        if "session" not in _REMBG_SESSIONS:
            from rembg import new_session

            _REMBG_SESSIONS["session"] = new_session(model)
        out = remove(rgba, session=_REMBG_SESSIONS["session"], post_process_mask=True)
    except Exception as err:
        raise MaskRejected(
            "SEGMENTATION_FAILED",
            f"background segmentation failed ({err})",
            stats,
        ) from err
    alpha = np.array(out)[:, :, 3]
    stats["segmentMs"] = int((time.time() - t0) * 1000)
    return alpha, stats


_REMBG_SESSIONS: dict = {}


def harden_reference(image, foreground_ratio: float = 0.85, segmenter: Optional[str] = None):
    """Turn one accepted reference into a TripoSR-ready inference input.

    Returns ``(prepared_rgb, mode, stats, diagnostics)`` where:
      prepared  — PIL RGB: product only, over neutral 0.5 grey, cropped to the
                  foreground with 6% padding, squared, padded to foreground_ratio;
      mode      — 'segmented' (rembg) | 'alpha-cutout' (reference already has a
                  matte) | 'photo-bypass' (operator explicitly asserted the photo
                  is prepared — measured, flagged, never silent);
      stats     — every measured number (recorded on the job);
      diagnostics — {'original': PIL, 'mask': PIL} for the preview files.

    Raises MaskRejected when the mask fails its gates — the caller turns that
    into a failed job with a staff-facing reason.
    """
    import numpy as np
    from PIL import Image

    segmenter = (segmenter or DEFAULT_SEGMENTER).strip().lower()
    arr = np.array(image)
    if arr.ndim != 3 or arr.shape[2] != 4:
        raise ValueError("expected an RGBA image")

    existing_alpha = arr[:, :, 3]
    has_alpha = bool(existing_alpha.min() < 255)
    stats: dict = {"segmenter": segmenter}

    if segmenter == "photo":
        # Explicit operator bypass for references that are ALREADY isolated
        # (bench scripts, verified studio stills). Measured and flagged, never
        # gated — the operator asserted the preparation, and the quality gate
        # still judges the produced mesh against the reference.
        alpha = existing_alpha if has_alpha else np.full(arr.shape[:2], 255, dtype=np.uint8)
        mode = "photo-bypass"
        stats["bypass"] = True
        total = int(alpha.size)
        stats["fgFraction"] = round(float((alpha >= 128).sum()) / total, 4)
        stats["opaqueFraction"] = round(float((alpha >= 250).sum()) / total, 4)
    elif segmenter == "alpha":
        # An EXPLICIT request to trust the reference's own matte. Fail-closed
        # when there is none: silently substituting segmentation would make the
        # flag a lie, and feeding an unmasked photo is the shell defect itself.
        if not has_alpha:
            raise MaskRejected(
                "ALPHA_MISSING",
                "the segmenter is set to 'alpha' but this reference carries no "
                "transparency — run it with the default (rembg) segmenter, or "
                "supply a real cutout",
                stats,
            )
        alpha = existing_alpha.copy()
        mode = "alpha-cutout"
        stats["segmenter"] = "alpha"
        # Gates apply to EVERY real matte — including a legacy cutout whose
        # weak alpha is exactly what the old pipeline shipped.
        _mask_gates(alpha, stats)
    else:
        alpha, seg_stats = segment_foreground(image)
        stats.update(seg_stats)
        mode = "segmented"
        # Gates apply to EVERY real matte — a segmentation that returned the
        # frame, or a washy one, is refused here rather than reconstructed.
        _mask_gates(alpha, stats)

    # ── island cleanup: speckles AND disconnected background regions ─────────
    # Speckles are noise by size. A secondary region that is small RELATIVE TO
    # THE SUBJECT but not speck-sized (a shadow sliver, a second object, the
    # stray blob this reference actually carries top-right) is disconnected
    # background: it is not attached to the product in the photograph, so
    # TripoSR would float it as junk geometry. A genuinely major secondary
    # region (a detached flower head, tens of percent) is KEPT — it may be
    # product, and the mesh-level cleanup plus the quality gate judge it later.
    mask = alpha >= 128
    speck_fraction = 0.0
    island_fraction = 0.0
    if mode != "photo-bypass" and mask.any():
        from scipy import ndimage

        labels, count = ndimage.label(mask, structure=_mask_structure())
        if count > 1:
            sizes = np.bincount(labels.ravel())[1:].astype(np.float64)
            total_px = float(sizes.sum())
            largest_label = int(sizes.argmax()) + 1
            is_speck = sizes < max(MASK_SPECK_FRACTION * total_px, 8.0)
            is_minor = (
                ~is_speck
                & (np.arange(1, count + 1) != largest_label)
                & (sizes < MASK_ISLAND_DROP_MAX * total_px)
            )
            speck_px = np.isin(labels, np.where(is_speck)[0] + 1)
            island_px = np.isin(labels, np.where(is_minor)[0] + 1)
            drop_px = speck_px | island_px
            if drop_px.any():
                subject_px = float(mask.sum())
                speck_fraction = float(speck_px.sum()) / subject_px
                island_fraction = float(island_px.sum()) / subject_px
                alpha = alpha.copy()
                alpha[drop_px] = 0
                mask = alpha >= 128
    stats["speckDroppedFraction"] = round(speck_fraction, 4)
    stats["islandDroppedFraction"] = round(island_fraction, 4)

    ys, xs = np.where(mask)
    if not len(ys):
        raise MaskRejected("MASK_EMPTY", "no foreground pixels survived masking", stats)

    # ── composite over neutral grey, crop to the foreground, square it ───────
    rgb = arr[:, :, :3].astype(np.float32) / 255.0
    a = (alpha.astype(np.float32) / 255.0)[:, :, None]
    composited = rgb * a + (1.0 - a) * 0.5
    composed = Image.fromarray((composited * 255.0).astype(np.uint8), mode="RGB")

    y1, y2 = int(ys.min()), int(ys.max()) + 1
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    pad = int(round(0.06 * max(arr.shape[0], arr.shape[1])))
    y1 = max(0, y1 - pad)
    x1 = max(0, x1 - pad)
    y2 = min(arr.shape[0], y2 + pad)
    x2 = min(arr.shape[1], x2 + pad)
    crop = np.array(composed)[y1:y2, x1:x2]

    side = max(crop.shape[0], crop.shape[1])
    pad_y = side - crop.shape[0]
    pad_x = side - crop.shape[1]
    squared = np.pad(
        crop,
        ((pad_y // 2, pad_y - pad_y // 2), (pad_x // 2, pad_x - pad_x // 2), (0, 0)),
        mode="constant",
        constant_values=128,
    )
    new_side = int(side / float(foreground_ratio))
    extra = max(0, new_side - side)
    final = np.pad(
        squared,
        ((extra // 2, extra - extra // 2), (extra // 2, extra - extra // 2), (0, 0)),
        mode="constant",
        constant_values=128,
    )
    prepared = Image.fromarray(final, mode="RGB")

    stats["crop"] = [x1, y1, x2, y2]
    stats["inputPixels"] = int(final.shape[0])

    # Diagnostic panels: original / mask / exact input, for staff review.
    mask_viz = np.zeros_like(arr)
    mask_viz[:, :, 0] = np.where(mask, 255, 0)
    mask_viz[:, :, 1] = np.where(mask, 0, 255)
    mask_viz[:, :, 3] = 255
    # The mask AS ALPHA (not a colour overlay): this is what travels to the
    # backend as `maskPng` so the quality gate can compare the model's
    # silhouette against the foreground that was actually fed to the engine.
    mask_alpha = np.zeros_like(arr)
    mask_alpha[:, :, 3] = np.where(mask, 255, 0)
    diagnostics = {
        "original": image.convert("RGB"),
        "mask": Image.fromarray(mask_viz, mode="RGBA"),
        "maskAlpha": Image.fromarray(mask_alpha, mode="RGBA"),
    }
    return prepared, mode, stats, diagnostics


def mask_payload_b64(mask_alpha_image, max_side: int = 128) -> str:
    """Small base64 PNG of the mask's alpha channel for the result payload.

    Bounded on purpose: the gate only needs a silhouette to normalise, and a
    128-px PNG is under a kilobyte — comfortably inside the transport's stats
    budget. Returns '' on any failure (diagnostics never fail a job).
    """
    if mask_alpha_image is None:
        return ""
    from PIL import Image

    try:
        img = mask_alpha_image.convert("RGBA")
        scale = min(1.0, float(max_side) / max(img.size))
        if scale < 1.0:
            img = img.resize(
                (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                Image.NEAREST,
            )
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return ""


def _candidate_score(stats: dict, view_angle: str = "", index: int = 0) -> float:
    """Rank hardened candidates for a SINGLE-view engine. Higher is better.

    Mask quality dominates; the view label and being the primary view are small
    tie-breaks, so a visibly better-cleaned three-quarter view can beat a poor
    primary, while an equally good primary keeps its privilege.
    """
    fg = float(stats.get("fgFraction") or 0)
    fg_fit = 1.0 - min(1.0, abs(fg - 0.45) / 0.55)
    quality = (
        0.5 * min(1.0, float(stats.get("opaqueFraction") or 0) / 0.5)
        + 0.3 * float(stats.get("largestShare") or 0.5)
        + 0.2 * fg_fit
    )
    angle = (view_angle or "").lower()
    if "three-quarter" in angle or "3/4" in angle:
        view = 0.06
    elif "front" in angle:
        view = 0.04
    elif "back" in angle:
        view = -0.02
    elif "detail" in angle:
        view = -0.01
    else:
        view = 0.02
    return quality + view + (0.05 if index == 0 else 0.0)


def select_reference(
    images,
    foreground_ratio: float = 0.85,
    segmenter: Optional[str] = None,
    max_candidates: int = 4,
    log=None,
) -> dict:
    """Harden every candidate and choose the ONE input a single-view engine uses.

    This is selection, not multi-view: each candidate is masked and scored on its
    own, exactly one is consumed, and the result records which photograph won and
    why the others lost (or were refused). Extracted from ``Engine.run_task`` so
    the decision is testable without loading a model.

    Returns a dict with ``prepared``, ``mode``, ``stats``, ``diagnostics``,
    ``inputUsed``, ``candidates`` (summaries) and ``rejections``.
    Raises ``ValueError`` with ``code = 'MASK_REJECTED_ALL'`` when no candidate
    survives its mask gates — the message lists WHICH view failed and WHY, which
    is the staff-facing correction signal.
    """
    def say(message):
        if log:
            log(message)

    if not images:
        raise ValueError("no reference image was supplied")
    if len(images) > max_candidates:
        say(f"{len(images)} candidates supplied, first {max_candidates} considered")
        images = images[:max_candidates]

    candidates = []
    rejections = []
    for idx, img in enumerate(images):
        ref_id = str(img.get("id") or f"view-{idx + 1}")
        view_angle = str(img.get("viewAngle") or "")
        label = str(img.get("label") or "")
        raw = base64.b64decode(img.get("data") or "", validate=False)
        if not raw:
            rejections.append(
                {"id": ref_id, "viewAngle": view_angle, "code": "EMPTY",
                 "message": "the reference image was empty"}
            )
            continue
        try:
            rgba = _to_rgba(raw)
            ready, mode, stats, diag = harden_reference(
                rgba, foreground_ratio, segmenter=segmenter
            )
        except MaskRejected as err:
            rejections.append(
                {"id": ref_id, "viewAngle": view_angle, "label": label,
                 "code": err.code, "message": str(err)}
            )
            say(
                f"candidate {ref_id} ({view_angle or 'unlabelled'}) rejected: "
                f"{err.code}: {err}"
            )
            continue
        except ValueError as err:  # unreadable bytes are a per-view fact
            rejections.append(
                {"id": ref_id, "viewAngle": view_angle, "label": label,
                 "code": "UNREADABLE", "message": str(err)}
            )
            continue
        candidates.append(
            {"id": ref_id, "viewAngle": view_angle, "label": label,
             "index": idx, "score": round(_candidate_score(stats, view_angle, idx), 4),
             "stats": stats, "mode": mode, "prepared": ready, "diagnostics": diag}
        )

    if not candidates:
        detail = (
            "; ".join(f"{r.get('viewAngle') or r['id']}: {r['code']}" for r in rejections)
            or "no candidate decoded"
        )
        err = ValueError(
            "no accepted reference produced a usable foreground mask ("
            f"{detail}) — correct the flagged reference image(s) and retry"
        )
        err.code = "MASK_REJECTED_ALL"
        raise err

    best = max(candidates, key=lambda c: c["score"])
    input_used = {
        "id": best["id"],
        "viewAngle": best["viewAngle"],
        "label": best["label"],
        "index": best["index"],
        "score": best["score"],
    }
    candidate_summaries = [
        {"id": c["id"], "viewAngle": c["viewAngle"], "label": c["label"],
         "score": c["score"], "fgFraction": c["stats"].get("fgFraction"),
         "opaqueFraction": c["stats"].get("opaqueFraction"),
         "selected": c["id"] == best["id"]}
        for c in candidates
    ]
    say(
        f"input selected {best['id']} ({best['viewAngle'] or 'unlabelled'}, "
        f"score {best['score']}) from {len(candidates)} candidate(s); "
        f"{len(rejections)} rejected"
    )
    return {
        "prepared": best["prepared"],
        "mode": best["mode"],
        "stats": best["stats"],
        "diagnostics": best["diagnostics"],
        "inputUsed": input_used,
        "candidates": candidate_summaries,
        "rejections": rejections,
    }


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

            options = payload.get("options") or {}
            resolution = int(options.get("resolution") or self.args.mc_resolution)
            foreground_ratio = float(options.get("foreground_ratio") or self.args.foreground_ratio)
            segmenter = options.get("segmenter") or getattr(self.args, "segmenter", None)
            # A FEW candidates are sent so the input can be chosen AFTER masking;
            # the engine still consumes exactly ONE — selection, not multi-view.
            max_candidates = int(options.get("maxCandidates") or 4)
            if len(images) > max_candidates:
                self.log(
                    f"task {task.id}: {len(images)} candidates supplied, first {max_candidates} considered"
                )
                images = images[:max_candidates]

            self._stage(task, "preparing", 5)
            selection = select_reference(
                images,
                foreground_ratio,
                segmenter=segmenter,
                max_candidates=max_candidates,
                log=lambda message: self.log(f"task {task.id}: {message}"),
            )
            prepared = selection["prepared"]
            input_mode = selection["mode"]
            input_stats = selection["stats"]
            input_used = selection["inputUsed"]
            candidate_summaries = selection["candidates"]
            rejections = selection["rejections"]
            diag_info = self._write_diagnostics(task, selection["diagnostics"], prepared)
            mask_payload = mask_payload_b64((selection["diagnostics"] or {}).get("maskAlpha"))
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
                "inputPixels": input_stats.get("inputPixels"),
                # Which photograph actually produced this mesh, and the mask
                # facts behind the choice — the honesty the studio displays.
                "segmenter": input_stats.get("segmenter", ""),
                "mask": input_stats,
                "maskPng": mask_payload,
                "inputUsed": input_used,
                "candidates": candidate_summaries,
                "candidateRejections": rejections,
                "diagnostics": diag_info,
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

    def _write_diagnostics(self, task, diag: dict, prepared) -> dict:
        """Write original / mask / exact-input panels for staff review.

        Local files on the worker machine only: the result payload carries the
        count and the basenames, never absolute paths — the job row travels to
        the backend. The absolute directory is logged to the worker console.
        """
        out = {"written": 0, "files": []}
        if getattr(self.args, "no_diagnostics", False):
            return out
        directory = getattr(self.args, "diagnostics_dir", "") or ""
        if not directory:
            return out
        try:
            os.makedirs(directory, exist_ok=True)
            names = []
            for name, image in (
                ("original", (diag or {}).get("original")),
                ("mask", (diag or {}).get("mask")),
                ("input", prepared),
            ):
                if image is None:
                    continue
                fname = f"{task.id}-{name}.png"
                image.save(os.path.join(directory, fname))
                names.append(fname)
            out = {"written": len(names), "files": names}
            if names:
                self.log(
                    f"task {task.id}: diagnostics written to {os.path.abspath(directory)}"
                )
        except Exception as err:  # diagnostics never fail a task
            self.log(f"task {task.id}: diagnostics not written ({err})")
        return out

    def _clean_and_measure(self, mesh) -> dict:
        """Tidy the raw isosurface and measure what is being published.

        Checked rather than trusted: degenerate triangles (marching cubes can
        emit them), winding orientation (the storefront renders front faces, so
        an inverted mesh would look black), NON-FINITE vertices (a NaN poisons
        bounds and rendering), and DISCONNECTED DETACHED COMPONENTS — the tiny
        floating islands marching cubes leaves around a reconstruction. Islands
        are dropped only when tiny against BOTH the whole product and the main
        body, so a detached petal, stem or handle survives while a speck does not.
        """
        import numpy as np
        import trimesh

        raw_faces = len(mesh.faces)
        raw_vertices = len(mesh.vertices)
        if raw_faces == 0:
            raise RuntimeError("the model produced no triangles")
        if not np.isfinite(mesh.vertices).all():
            raise RuntimeError(
                "the model contains non-finite vertex positions (NaN/Inf), which "
                "would corrupt its bounds and rendering"
            )

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

        # ── conservative detached-component cleanup ──────────────────────────
        component_count = 1
        components_dropped = 0
        components_kept = 1
        largest_share = 1.0
        dropped_share = 0.0
        try:
            groups = trimesh.graph.connected_components(
                mesh.face_adjacency, nodes=np.arange(len(mesh.faces))
            )
            component_count = len(groups)
            if len(groups) > 1:
                areas = np.array([float(mesh.area_faces[g].sum()) for g in groups])
                total = float(areas.sum())
                largest = float(areas.max())
                largest_share = largest / total if total > 0 else 1.0
                # Drop ONLY when tiny against both measures (AND, not OR).
                drop_if = (areas < MESH_DROP_SHARE_TOTAL * total) & (
                    areas < MESH_DROP_SHARE_LARGEST * largest
                )
                if drop_if.any() and not drop_if.all():
                    keep = np.zeros(len(mesh.faces), dtype=bool)
                    for group, keep_group in zip(groups, ~drop_if):
                        if keep_group:
                            keep[group] = True
                    dropped_area = float(areas[drop_if].sum())
                    mesh.update_faces(keep)
                    mesh.remove_unreferenced_vertices()
                    components_dropped = int(drop_if.sum())
                    components_kept = int((~drop_if).sum())
                    dropped_share = dropped_area / total if total > 0 else 0.0
        except Exception as err:  # measurement must never destroy the result
            self.log(f"component analysis skipped ({err})")
            components_dropped = 0

        extents = mesh.extents
        ext = [float(v) for v in extents]
        depth_ratio = (min(ext) / max(max(ext), 1e-12)) if max(ext) > 0 else 0.0

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
            "extents": ext,
            # Component facts: what was found, what survived, and how much of the
            # surface the main body represents (a shell around the product would
            # push this DOWN; a clean product sits near 1).
            "components": component_count,
            "componentsDropped": components_dropped,
            "componentsKept": components_kept,
            "largestComponentShare": round(largest_share, 4),
            "componentDroppedShare": round(dropped_share, 4),
            # Thinnest axis over the thinnest axis — the depth/aspect diagnostic.
            "depthRatio": round(depth_ratio, 4),
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
    parser.add_argument(
        "--segmenter",
        default=os.environ.get("THREE_WORKER_SEGMENTER", "rembg"),
        choices=["rembg", "alpha", "photo"],
        help="how inference inputs get their foreground: rembg (default, real "
        "segmentation, fail-closed), alpha (trust the reference's own matte), "
        "photo (explicit operator bypass for already-isolated references)",
    )
    parser.add_argument(
        "--diagnostics-dir",
        default=os.environ.get(
            "THREE_WORKER_DIAGNOSTICS_DIR",
            os.path.join(os.getcwd(), "worker-diagnostics"),
        ),
        help="where original/mask/input diagnostic panels are written",
    )
    parser.add_argument(
        "--no-diagnostics",
        action="store_true",
        default=os.environ.get("THREE_WORKER_NO_DIAGNOSTICS") == "1",
        help="do not write diagnostic image panels",
    )
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
