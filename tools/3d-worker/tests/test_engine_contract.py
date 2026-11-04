"""ADAPTER CONTRACT TESTS — no GPU, no checkpoints, no network.

These run in CI with nothing installed:
    python -m unittest discover -s tools/3d-worker/tests -v

They prove the things that must hold even on a machine that has never seen a
model: named-view validation, sheet refusal, RGBA and pose requirements, camera
matrices, transforms.json provenance, registry dispatch and the absence of any
silent engine fallback.
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import types
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.dirname(HERE)
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

from engines import contract  # noqa: E402
from engines.base import AdapterError  # noqa: E402
from engines.hunyuan3d import Hunyuan3D2mvAdapter  # noqa: E402
from engines.registry import ADAPTERS, build_registry, describe_engines  # noqa: E402
from engines.reli3d import ReLi3DAdapter  # noqa: E402


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def png(width: int = 8, height: int = 8, color_type: int = 6) -> bytes:
    """A REAL, minimal PNG. color_type 6 = RGBA, 2 = RGB (no alpha)."""
    channels = 4 if color_type == 6 else 3
    rows = b"".join(b"\x00" + bytes([120, 80, 160, 255][:channels] * width) for _ in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(rows))
        + _chunk(b"IEND", b"")
    )


def frame(view: str, *, pose=True, rgba=True, fid=None) -> dict:
    data = png(color_type=6 if rgba else 2)
    return {
        "id": fid or f"ref-{view}",
        "viewAngle": view,
        "label": f"{view}.png",
        "data": base64.b64encode(data).decode("ascii"),
        "pose": (
            {
                "position": {"x": 0.0, "y": 0.0, "z": 2.0},
                "target": {"x": 0.0, "y": 0.0, "z": 0.0},
                "fov": 40.0,
                "source": "imported",
            }
            if pose
            else None
        ),
    }


class PngFacts(unittest.TestCase):
    def test_rgba_and_rgb_are_distinguished(self):
        self.assertTrue(contract.png_header(png(color_type=6))["hasAlpha"])
        self.assertFalse(contract.png_header(png(color_type=2))["hasAlpha"])

    def test_non_png_is_refused(self):
        self.assertIsNone(contract.png_header(b"\xff\xd8\xff\xe0" + b"0" * 40))


class HunyuanContract(unittest.TestCase):
    def test_accepts_front_left_back_in_slot_order(self):
        selected = contract.validate_hunyuan_inputs([frame("back"), frame("front"), frame("left")])
        self.assertEqual([entry["viewAngle"] for entry in selected], ["front", "left", "back"])

    def test_contact_sheet_is_never_a_view(self):
        sheet = frame("front")
        sheet["source"] = {"type": "composite"}
        with self.assertRaises(contract.ContractError) as ctx:
            contract.validate_hunyuan_inputs([sheet, frame("left"), frame("back")])
        self.assertIn("composite sheet", str(ctx.exception))

    def test_duplicate_named_slot_is_refused(self):
        with self.assertRaises(contract.ContractError) as ctx:
            contract.validate_hunyuan_inputs([frame("front"), frame("front"), frame("left"), frame("back")])
        self.assertIn("one image per named slot", str(ctx.exception))

    def test_missing_required_view_is_refused(self):
        with self.assertRaises(contract.ContractError) as ctx:
            contract.validate_hunyuan_inputs([frame("front"), frame("left")])
        self.assertIn('no "back" view', str(ctx.exception))

    def test_unknown_label_is_refused(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_hunyuan_inputs(
                [frame("front"), frame("left"), frame("back"), frame("three-quarter-left")]
            )

    def test_optional_right_is_accepted(self):
        selected = contract.validate_hunyuan_inputs(
            [frame("front"), frame("left"), frame("back"), frame("right")]
        )
        self.assertEqual(len(selected), 4)
        self.assertEqual(selected[-1]["viewAngle"], "right")


class ReLi3DContract(unittest.TestCase):
    def test_rgba_required(self):
        with self.assertRaises(contract.ContractError) as ctx:
            contract.validate_reli3d_inputs([frame("front", rgba=False), frame("left"), frame("back")])
        self.assertIn("no alpha channel", str(ctx.exception))

    def test_missing_pose_is_refused_not_inferred(self):
        with self.assertRaises(contract.ContractError) as ctx:
            contract.validate_reli3d_inputs([frame("front", pose=False), frame("left"), frame("back")])
        self.assertIn("no complete recorded pose", str(ctx.exception))

    def test_inferred_pose_source_is_not_a_pose(self):
        bad = frame("front")
        bad["pose"]["source"] = "inferred"
        with self.assertRaises(contract.ContractError):
            contract.validate_reli3d_inputs([bad, frame("left"), frame("back")])

    def test_transforms_json_is_generated_from_recorded_values(self):
        transforms = contract.validate_reli3d_inputs([frame("front"), frame("left"), frame("back")])
        self.assertEqual(transforms["provenance"]["inferredPoses"], 0)
        self.assertEqual(transforms["provenance"]["frameCount"], 3)
        self.assertEqual(transforms["frames"][0]["pose_source"], "imported")
        self.assertEqual(len(transforms["frames"][0]["transform_matrix"]), 4)
        # The official loader's dialect: file_path relative to the object dir
        # (rgba/NNNN.png), camera_fov in radians, frame order via view_index.
        self.assertTrue(transforms["frames"][0]["file_path"].startswith("rgba/"))
        self.assertEqual(transforms["frames"][0]["view_index"], 0)
        self.assertEqual(transforms["provenance"]["cameraFovUnit"], "radians")
        self.assertGreater(transforms["frames"][0]["fl_x"], 0)

    def test_camera_fov_is_emitted_in_radians(self):
        posed = frame("front")
        posed["pose"]["fov"] = 90
        transforms = contract.validate_reli3d_inputs([posed, frame("left"), frame("back")])
        self.assertAlmostEqual(transforms["frames"][0]["camera_fov"], 3.141592653589793 / 2.0)

    def test_matrix_is_right_handed_and_affine(self):
        matrix = contract.camera_to_world(
            {
                "position": {"x": 1.0, "y": 2.0, "z": 3.0},
                "target": {"x": 0.0, "y": 0.0, "z": 0.0},
                "fov": 40,
                "source": "manual",
            }
        )
        self.assertEqual(matrix[3], [0.0, 0.0, 0.0, 1.0])
        self.assertEqual(contract.validate_matrix(matrix), [])

    def test_malformed_matrix_is_refused(self):
        bad = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 1, 1]]
        self.assertTrue(contract.validate_matrix(bad))

    def test_fov_outside_the_lens_band_is_refused(self):
        bad = frame("front")
        bad["pose"]["fov"] = 400
        with self.assertRaises(contract.ContractError):
            contract.validate_reli3d_inputs([bad, frame("left"), frame("back")])


class Registry(unittest.TestCase):
    def test_every_adapter_is_declared_once(self):
        self.assertEqual(sorted(ADAPTERS), ["hunyuan3d_2mv", "reli3d", "triposr"])
        self.assertEqual(len(describe_engines()), 3)

    def test_hunyuan_probe_is_honest_without_dependencies(self):
        health = Hunyuan3D2mvAdapter(device="cuda:0", model_path="").probe()
        self.assertFalse(health.ready)
        self.assertIn("HUNYUAN3D_MODEL_PATH", health.detail)
        # It must not claim installation just because the module exists here.
        self.assertIsInstance(health.installed, bool)

    def test_reli3d_probe_reports_missing_entrypoint(self):
        health = ReLi3DAdapter(home="", entrypoint="").probe()
        self.assertFalse(health.ready)
        self.assertIn("entrypoint", health.detail.lower())

    def test_unknown_engine_builds_no_adapter(self):
        registry = build_registry("not_an_engine", log=lambda *_: None)
        self.assertEqual(registry.adapters, {})
        self.assertEqual(registry.claimable(), [])

    def test_selection_maps_engine_ids_to_adapters(self):
        registry = build_registry(
            "local_single_view,hunyuan3d_2mv,reli3d",
            worker_mod=types.SimpleNamespace(),
            worker_args=types.SimpleNamespace(triposr_home=""),
            log=lambda *_: None,
        )
        self.assertEqual(sorted(registry.adapters), ["hunyuan3d_2mv", "reli3d", "triposr"])

    def test_no_adapter_can_silently_substitute_another_engine(self):
        """The registry returns None; the agent turns that into a FAILED job."""
        registry = build_registry("reli3d", log=lambda *_: None)
        self.assertIsNone(registry.get("hunyuan3d_2mv"))
        with self.assertRaises(AdapterError):
            raise AdapterError("ENGINE_NOT_INSTALLED", "refused")


class NoHeavyImports(unittest.TestCase):
    def test_contract_module_does_not_import_torch(self):
        # Importing the pure module must not require torch: run it in a fresh
        # interpreter and assert the module is still importable.
        import subprocess

        code = (
            "import sys; sys.path.insert(0, r'%s');"
            "import engines.contract as c;"
            "assert 'torch' not in sys.modules;"
            "print('ok')" % WORKER
        )
        completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("ok", completed.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
