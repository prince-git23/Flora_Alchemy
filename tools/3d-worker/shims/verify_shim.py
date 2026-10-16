"""PROOF FOR THE MARCHING-CUBES SHIM — axis order and orientation.

`torchmcubes` cannot be compiled on a machine without MSVC/CMake/CUDA, so
`shims/torchmcubes.py` stands in for it. That substitution is only acceptable if
the two properties TripoSR's own code depends on are MEASURED rather than
assumed, which is what this file does. It needs no GPU, no model weights and no
TripoSR checkout — only numpy, torch and scikit-image.

Run:
    python verify_shim.py            # prints PASS/FAIL per check, exits non-zero on failure

WHAT IS MEASURED

  1. COLUMN LAYOUT. A synthetic 24^3 field holds a solid rectangular block whose
     extent is deliberately DIFFERENT on every axis (4 x 7 x 11 cells) and which
     sits off-centre. Torchmcubes' contract is `(dim2, dim1, dim0)`, so after the
     column swap TripoSR performs (`v_pos[..., [2, 1, 0]]`) the mesh must span
     exactly the block's extents in the block's own axis order. A wrong
     permutation or a mirror cannot pass this: the extents would be permuted or
     the block would land on the wrong side of the grid.

  2. ORIENTATION. For the closed block the signed volume must be POSITIVE, which
     is the right-handed/CCW-outward convention trimesh and three.js assume.
     Both `gradient_direction` values and both windings are measured, so the
     constants baked into the shim are the ones that actually measure outward.

  3. TRIPOSR'S OWN TRANSFORM. TripoSR scales the extracted vertices
     from (0, 1) to (-radius, radius) — an affine map that must not change the
     block's ordering, which is checked too.

  4. CONSISTENCY WITH scikit-image. The shim's vertices must equal scikit-image's
     with the columns reversed, and nothing else, so the geometry is untouched.
"""

from __future__ import annotations

import sys
import numpy as np
import torch
from skimage import measure as skmeasure

import torchmcubes as shim  # noqa: E402  (the sibling shim module)

RES = 24
# A block with a distinct extent per axis, placed OFF-CENTRE so a mirrored axis
# order lands in the wrong half of the grid rather than looking plausible.
BLOCK = ((4, 9), (2, 9), (6, 17))  # (start, stop) per axis: 5 x 7 x 11 cells
LEVEL = 0.5

_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        _failures.append(name)


def high_inside_field() -> np.ndarray:
    """A field whose HIGH values are inside the solid — TripoSR's density shape."""
    grid = np.zeros((RES, RES, RES), dtype=np.float32)
    (x0, x1), (y0, y1), (z0, z1) = BLOCK
    grid[x0:x1, y0:y1, z0:z1] = 1.0
    return grid


def extents_of(verts: np.ndarray) -> tuple[float, float, float]:
    span = verts.max(axis=0) - verts.min(axis=0)
    return float(span[0]), float(span[1]), float(span[2])


def signed_volume(verts: np.ndarray, faces: np.ndarray) -> float:
    """6x the signed volume of a closed mesh (positive => outward winding)."""
    tri = verts[faces]
    return float(np.einsum("ij,ij->i", np.cross(tri[:, 0], tri[:, 1]), tri[:, 2]).sum() / 6.0)


def main() -> int:
    field = high_inside_field()
    tensor = torch.from_numpy(field)

    print("shim verify — torchmcubes-compatible marching cubes (scikit-image backend)")
    print(f"  field: {RES}^3, block {BLOCK}, level {LEVEL}")

    # ── 1. the shim's raw output matches upstream's column convention ─────────
    sk_verts, sk_faces, _n, _v = skmeasure.marching_cubes(
        field, level=LEVEL, spacing=(1.0, 1.0, 1.0),
        gradient_direction=shim.MAX_LEVEL_DIRECTION, allow_degenerate=True,
    )
    sh_verts_t, sh_faces_t = shim.marching_cubes(tensor, LEVEL)
    sh_verts = sh_verts_t.numpy()
    sh_faces = sh_faces_t.numpy()

    check("the shim returns torch tensors on the input's device",
          isinstance(sh_verts_t, torch.Tensor) and sh_verts_t.device == tensor.device,
          f"{type(sh_verts_t).__name__} on {sh_verts_t.device}")
    check("vertices are float32 and faces are int64 (torchmcubes' dtypes)",
          sh_verts_t.dtype == torch.float32 and sh_faces_t.dtype == torch.int64,
          f"{sh_verts_t.dtype} / {sh_faces_t.dtype}")

    reversed_ok = np.allclose(sh_verts, sk_verts[:, [2, 1, 0]], atol=1e-6)
    check("vertices are scikit-image's with the columns reversed (torchmcubes' dim2-first layout)",
          reversed_ok)
    mirrored_would_differ = not np.allclose(sh_verts, sk_verts, atol=1e-6)
    check("...and that reversal actually matters here (a pass-through would be a mirror)",
          mirrored_would_differ)
    check("the same number of faces is emitted", len(sh_faces) == len(sk_faces),
          f"{len(sh_faces)} vs {len(sk_faces)}")

    # ── 2. TripoSR's own transform must land on the block's real extents ─────
    # TripoSR: v_pos = v_pos[..., [2, 1, 0]] then / (resolution - 1) then scaled.
    mc = RES  # what TripoSR passes as `resolution`
    world = sh_verts[:, [2, 1, 0]] / (mc - 1.0)
    radius = 0.87
    world = (world - 0.0) / (1.0 - 0.0) * (2 * radius) - radius  # scale_tensor((0,1) -> (-r, r))
    extent = extents_of(world)
    # The isosurface of a voxel block [x0, x1) at level 0.5 sits half a voxel
    # OUTSIDE the outermost "on" samples, so its span is exactly (x1 - x0) cells.
    expected = tuple(b[1] - b[0] for b in BLOCK)
    cell = (2 * radius) / (mc - 1.0)
    expected_world = tuple(e * cell for e in expected)
    check(
        "after TripoSR's [2,1,0] swap the block spans its true extents on every axis (no permutation, no mirror)",
        all(abs(extent[i] - expected_world[i]) < 0.05 * cell for i in range(3)),
        f"measured {tuple(round(e, 4) for e in extent)} vs expected {tuple(round(e, 4) for e in expected_world)} (cell={cell:.4f})",
    )

    # Each axis' span must be distinct, otherwise the check above proves nothing.
    check("the three expected extents are distinct (so a permutation could not pass)",
          len(set(round(e, 6) for e in expected)) == 3, str(expected))

    # The block sits off-centre: verify it lands in the correct half per axis.
    centre = (world.min(axis=0) + world.max(axis=0)) / 2.0
    axis_centres = np.array([(b[0] + b[1] - 1) / 2.0 for b in BLOCK])
    signed_expected = (axis_centres / (RES - 1.0)) * (2 * radius) - radius
    check("the block's centre lands on the correct side of the grid centre on every axis",
          all(abs(centre[i] - signed_expected[i]) < 0.05 * cell for i in range(3)),
          f"measured {tuple(round(float(c), 4) for c in centre)} vs expected {tuple(round(float(s), 4) for s in signed_expected)}")

    # ── 3. orientation: measure every combination, report the shipped one ────
    print("  orientation sweep (signed volume of the closed block; positive = outward):")
    results = {}
    for direction in ("descent", "ascent"):
        v, f, _n, _v = skmeasure.marching_cubes(
            field, level=LEVEL, spacing=(1.0, 1.0, 1.0),
            gradient_direction=direction, allow_degenerate=True,
        )
        # TripoSR keeps scikit-image's winding and reverses only the vertices, so
        # what must be outward is (axis-ordered verts, these faces): the same
        # measurement as the final mesh.
        vol_plain = signed_volume(v, f)
        vol_flipped = signed_volume(v, f[:, [0, 2, 1]])
        results[direction] = vol_plain
        print(f"    gradient_direction={direction:8s} volume={vol_plain:+.1f} "
              f"(flipped winding {vol_flipped:+.1f})")

    shipped_direction = shim.MAX_LEVEL_DIRECTION
    check("the shipped gradient_direction measures OUTWARD (positive signed volume)",
          results.get(shipped_direction, 0.0) > 0,
          f"{shipped_direction} -> {results.get(shipped_direction, float('nan')):+.1f}")
    check("the shipped WINDING_REVERSED matches the measurement",
          bool(shim.WINDING_REVERSED) is (results.get(shipped_direction, 0.0) < 0),
          f"WINDING_REVERSED={shim.WINDING_REVERSED}")
    check("the volume is not near zero (the solid is a real closed block)",
          abs(results.get(shipped_direction, 0.0)) > 1.0,
          f"{results.get(shipped_direction, float('nan')):+.1f}")

    # The final mesh TripoSR builds — vertices AND faces as the shim emits them —
    # must be outward once the vertices are read in world (axis) order.
    final_vol = signed_volume(world, sh_faces if not shim.WINDING_REVERSED else sh_faces[:, [0, 2, 1]])
    check("the final TripoSR-space mesh is outward-facing (front faces visible in three.js)",
          final_vol > 0, f"signed volume {final_vol:+.1f}")

    # ── 4. degenerate/edge behaviour ─────────────────────────────────────────
    empty = shim.marching_cubes(torch.zeros((4, 4, 4)), LEVEL)
    check("a field with no crossing returns empty tensors instead of raising",
          tuple(empty[0].shape) == (0, 3) and tuple(empty[1].shape) == (0, 3))
    tiny = shim.marching_cubes(torch.zeros((1, 1, 1)), LEVEL)
    check("a 1^3 field (no cell exists) returns empty tensors",
          tuple(tiny[0].shape) == (0, 3))
    nan_field = torch.full((4, 4, 4), float("nan"))
    check("a non-finite field returns empty tensors",
          tuple(shim.marching_cubes(nan_field, LEVEL)[0].shape) == (0, 3))
    cuda_like = shim.HAS_CUDA is False
    check("HAS_CUDA is False (the shim is CPU-only, and torchmcubes' API exposes that flag)", cuda_like)

    print()
    if _failures:
        print(f"SHIM VERIFY: {len(_failures)} FAILED -> {', '.join(_failures)}")
        return 1
    print("SHIM VERIFY: ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
