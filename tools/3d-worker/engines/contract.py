"""INPUT CONTRACTS — the pure, dependency-free half of every adapter.

WHY THIS IS SEPARATE, AND DUPLICATED FROM THE SERVER
    The backend validates a job's inputs before handing a machine any bytes
    (`backend/services/localEngineAdapters.js`), and the agent validates them
    again here. That is not redundancy for its own sake: the server protects the
    pipeline from a machine, and the adapter protects the machine from a job it
    cannot honour. Neither may trust the other's assertion, and both must agree
    about what a valid input IS.

    Keeping this module free of torch/trimesh is what makes it testable on a
    machine with no GPU and no checkpoints — which is exactly how CI proves the
    contracts without downloading anything.

WHAT IS NEVER DONE HERE
    · a camera pose is never inferred from an image, and a missing pose is never
      filled with a default;
    · a contact sheet is never treated as a single view;
    · an engine's contract is never relaxed because the input would otherwise
      fail. A refusal is an outcome, not a reason to guess.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
from typing import Optional

PNG_SIG = b"\x89PNG\r\n\x1a\n"
HUNYUAN_SLOTS = ("front", "left", "back", "right")
HUNYUAN_REQUIRED = ("front", "left", "back")
POSE_SOURCES = ("manual", "imported")


class ContractError(Exception):
    """A refused input, with a code the backend can persist verbatim."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def decode_bytes(image: dict) -> Optional[bytes]:
    raw = image.get("buffer")
    if isinstance(raw, (bytes, bytearray)) and raw:
        return bytes(raw)
    data = image.get("data") or ""
    if not data:
        return None
    try:
        return base64.b64decode(data, validate=False)
    except Exception:
        return None


def png_header(data: bytes) -> Optional[dict]:
    """IHDR facts from a PNG, or None. No image library, no decoding cost."""
    if not data or len(data) < 33 or not data.startswith(PNG_SIG):
        return None
    if data[12:16] != b"IHDR":
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    bit_depth = data[24]
    color_type = data[25]
    if not width or not height:
        return None
    return {
        "format": "png",
        "width": width,
        "height": height,
        "bitDepth": bit_depth,
        "colorType": color_type,
        "hasAlpha": color_type in (4, 6),
    }


def is_sheet(image: dict) -> bool:
    if image.get("sheet") is True or image.get("composite") is True:
        return True
    source = image.get("source") or {}
    return str(source.get("type") or "").lower() in ("composite", "sheet", "contact-sheet")


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def _vec(value) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    if not all(_finite(value.get(axis)) for axis in ("x", "y", "z")):
        return None
    return {axis: float(value[axis]) for axis in ("x", "y", "z")}


def is_complete_pose(pose) -> bool:
    if not isinstance(pose, dict):
        return False
    if not _finite(pose.get("fov")):
        return False
    if str(pose.get("source") or "") not in POSE_SOURCES:
        return False
    return _vec(pose.get("position")) is not None and _vec(pose.get("target")) is not None


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _unit(v):
    length = math.sqrt(_dot(v, v))
    if not length or not math.isfinite(length):
        return None
    return (v[0] / length, v[1] / length, v[2] / length)


def camera_to_world(pose: dict) -> list:
    """OpenGL-style camera-to-world from a RECORDED pose (right-handed, +Y up)."""
    position = _vec(pose.get("position"))
    target = _vec(pose.get("target"))
    if not position or not target:
        raise ContractError("POSE_INCOMPLETE", "a camera pose needs finite position and target vectors")
    backward = _unit(
        (position["x"] - target["x"], position["y"] - target["y"], position["z"] - target["z"])
    )
    if backward is None:
        raise ContractError("POSE_DEGENERATE", "the camera position and target are the same point")
    up_ref = (0.0, 0.0, 1.0) if abs(_dot(backward, (0.0, 1.0, 0.0))) > 0.999 else (0.0, 1.0, 0.0)
    right = _unit(_cross(up_ref, backward))
    if right is None:
        raise ContractError("POSE_DEGENERATE", "the recorded pose has no usable orientation")
    up = _cross(backward, right)
    return [
        [right[0], up[0], backward[0], position["x"]],
        [right[1], up[1], backward[1], position["y"]],
        [right[2], up[2], backward[2], position["z"]],
        [0.0, 0.0, 0.0, 1.0],
    ]


def validate_matrix(matrix) -> list:
    errors = []
    if not isinstance(matrix, list) or len(matrix) != 4:
        return ["transform_matrix must be 4x4"]
    for row in matrix:
        if not isinstance(row, list) or len(row) != 4 or not all(_finite(v) for v in row):
            return ["transform_matrix must be 4x4 finite numbers"]
    if [float(v) for v in matrix[3]] != [0.0, 0.0, 0.0, 1.0]:
        errors.append("transform_matrix bottom row must be [0, 0, 0, 1]")
    columns = [(matrix[0][i], matrix[1][i], matrix[2][i]) for i in range(3)]
    for name, column in zip(("x", "y", "z"), columns):
        length = math.sqrt(_dot(column, column))
        if abs(length - 1.0) > 1e-3:
            errors.append(f"transform_matrix column {name} is not unit length ({length:.4f})")
    if any(abs(_dot(columns[a], columns[b])) > 1e-3 for a, b in ((0, 1), (0, 2), (1, 2))):
        errors.append("transform_matrix columns are not orthogonal")
    if _dot(_cross(columns[0], columns[1]), columns[2]) <= 0:
        errors.append("transform_matrix is left-handed")
    return errors


def validate_hunyuan_inputs(images: list) -> list:
    """Named slots, one image each, never a sheet. Returns the ordered selection."""
    errors = []
    by_slot = {}
    for image in images or []:
        if is_sheet(image):
            errors.append(
                f'"{image.get("label") or image.get("id") or "reference"}" is a composite sheet; '
                "Hunyuan3D-2mv conditions on named views and a sheet is never one"
            )
            continue
        slot = str(image.get("viewAngle") or image.get("slot") or "").lower()
        if slot not in HUNYUAN_SLOTS:
            errors.append(f'"{slot or "unlabelled"}" is not a named view ({", ".join(HUNYUAN_SLOTS)})')
            continue
        if slot in by_slot:
            errors.append(f'two references are labelled "{slot}"; one image per named slot')
            continue
        by_slot[slot] = image
    for slot in HUNYUAN_REQUIRED:
        if slot not in by_slot:
            errors.append(f'no "{slot}" view; Hunyuan3D-2mv requires front, left and back')
    if errors:
        raise ContractError("HUNYUAN_INPUT_INVALID", "; ".join(errors))
    return [by_slot[slot] for slot in HUNYUAN_SLOTS if slot in by_slot]


def validate_reli3d_inputs(frames: list) -> dict:
    """Every frame RGBA PNG + a recorded pose. Returns transforms.json."""
    errors = []
    prepared = []
    for index, frame in enumerate(frames or []):
        label = frame.get("viewAngle") or frame.get("label") or frame.get("id") or f"frame {index + 1}"
        if is_sheet(frame):
            errors.append(f'"{label}" is a composite sheet, not a captured frame')
            continue
        if not is_complete_pose(frame.get("pose")):
            errors.append(f'"{label}" has no complete recorded pose; ReLi3D refuses unposed frames')
            continue
        fov = float(frame["pose"]["fov"])
        if not 5.0 <= fov <= 120.0:
            errors.append(f'"{label}" has FOV {fov}; a calibrated pose needs 5-120 degrees')
            continue
        data = decode_bytes(frame) or b""
        header = png_header(data)
        if not header:
            errors.append(f'"{label}" is not a readable PNG; ReLi3D consumes RGBA PNG frames')
            continue
        if not header["hasAlpha"]:
            errors.append(f'"{label}" is a PNG with no alpha channel (color type {header["colorType"]})')
            continue
        matrix = camera_to_world(frame["pose"])
        matrix_errors = validate_matrix(matrix)
        if matrix_errors:
            errors.append(f'"{label}" produced an invalid transform: {"; ".join(matrix_errors)}')
            continue
        prepared.append((frame, data, header, fov, matrix, label))
    if errors:
        raise ContractError("RELI3D_INPUT_INVALID", "; ".join(errors))

    frames_json = []
    for index, (frame, data, header, fov, matrix, label) in enumerate(prepared):
        width, height = header["width"], header["height"]
        frames_json.append(
            {
                "file_path": f"rgba/{index:04d}.png",
                "transform_matrix": matrix,
                # The official loader (demos/reli3d/infer_from_transforms.py) reads
                # camera_fov in RADIANS; the recorded pose's degrees are converted
                # here, never hand-copied, and the pixel-centre principal point
                # that the loader would otherwise default to is stated explicitly.
                "camera_fov": math.radians(fov),
                "view_index": index,
                "camera_principal_point": [width / 2.0, height / 2.0],
                "fl_x": 0.5 * width / math.tan(math.radians(fov) / 2.0),
                "fl_y": 0.5 * height / math.tan(math.radians(fov) / 2.0),
                "cx": width / 2.0,
                "cy": height / 2.0,
                "w": width,
                "h": height,
                "aspect_ratio": round(width / height, 6),
                "referenceId": str(frame.get("id") or ""),
                "sha256": hashlib.sha256(data).hexdigest(),
                "view": str(frame.get("viewAngle") or ""),
                "pose_source": str(frame["pose"]["source"]),
            }
        )

    first = frames_json[0]
    return {
        "camera_model": "OPENCV",
        "fl_x": first["fl_x"],
        "fl_y": first["fl_y"],
        "cx": first["cx"],
        "cy": first["cy"],
        "w": first["w"],
        "h": first["h"],
        "frames": frames_json,
        "provenance": {
            "generator": "flora-alchemy/agent-engine-contract",
            "poseSources": sorted({frame["pose_source"] for frame in frames_json}),
            "frameCount": len(frames_json),
            "inferredPoses": 0,
            "cameraFovUnit": "radians",
            "fileLayout": "official-object-dir",
        },
    }


def transforms_bytes(transforms: dict) -> bytes:
    return json.dumps(transforms, indent=2, sort_keys=False).encode("utf-8")
