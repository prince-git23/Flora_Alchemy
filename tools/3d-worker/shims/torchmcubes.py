"""torchmcubes-COMPATIBLE MARCHING CUBES, BACKED BY scikit-image.

WHY THIS FILE EXISTS
--------------------
TripoSR imports `torchmcubes` for exactly one thing: `tsr/models/isosurface.py`
calls `marching_cubes(level, 0.0)` to turn the predicted density field into a
triangle mesh. `torchmcubes` is a C++/CUDA extension that has to be COMPILED, and
its own build instructions require a C++20 compiler (on Windows: Visual Studio
2019 16.11+) plus CMake 3.18+. The machine this worker was set up on has no MSVC,
no CMake and no CUDA Toolkit, so the extension cannot be built there
(TripoSR issue #48 is the same wall: "you need some build tools to install
torchmcubes"). Marquee user workarounds in TripoSR issues #148/#3 replace the
extractor with `skimage` / a CPU implementation, which is what this module is.

WHAT THIS IS NOT
----------------
It is NOT a replacement for the model. The AI inference — image tokenizer,
triplane transformer backbone, NeRF decoder and density query — is the real
TripoSR network, untouched (see `worker.py`). Marching cubes is pure geometry:
given the same scalar field and the same level it produces the same isosurface.
Only the extraction backend differs, and it is verified twice over by
`verify_shim.py`, which pins BOTH properties that matter downstream:

  · AXIS ORDER — the shim must emit torchmcubes' coordinate convention, because
    TripoSR divides and reorders the result (`v_pos[..., [2, 1, 0]]`) assuming it.
  · ORIENTATION — the triangles must face outward, because the customer viewer
    renders front faces only (`three.js` ignores backfaces by default), so an
    inverted mesh is an invisible or black model on the product page.

THE EXACT CONVENTION IT REPRODUCES
----------------------------------
Upstream loops, in `cxx/mcubes_cpu.cpp::mcubes_method`:

    for (int z = 0; z < vol.size(0) - 1; z++)
      for (int y = 0; y < vol.size(1) - 1; y++)
        for (int x = 0; x < vol.size(2) - 1; x++)
          cell.p[...] = XYZ(x + dx, y + dy, z + dz);

so the code's `x` walks the tensor's LAST dimension and its `z` walks the FIRST,
and vertices are stored as `(vertices[i].x, .y, .z)`. A torchmcubes vertex is
therefore `(dim2, dim1, dim0)` — the reverse of the tensor's axis order. That is
exactly why TripoSR unsets it with `v_pos[..., [2, 1, 0]]`, and exactly why
scikit-image's (already axis-ordered) output is column-reversed here: the two
reversals cancel, so TripoSR's world space stays aligned with the density grid
its `grid_vertices` was built from. Passing scikit-image's columns through
unchanged would silently MIRROR every model.

Coordinates are raw grid indices (offset by the cell fraction), because TripoSR
divides by `resolution - 1` itself — so `spacing` is (1, 1, 1) here.

BOTH ORIENTATIONS ARE HANDLED
-----------------------------
`gradient_direction` is fixed to the value `verify_shim.py` MEASURES as outward
for a high-inside field (`MAX_LEVEL_DIRECTION` below), and `WINDING_REVERSED`
records whether the triangle winding also needed flipping. The first run of that
checker failed against the value this module originally assumed, which is the
point of having it: the orientation is now a measured fact.
"""

from __future__ import annotations

import numpy as np
import torch
from skimage import measure as skmeasure

__version__ = "0.1.0+skimage-shim"

# torchmcubes exposes this flag; the shim is CPU-only, which is why `HAS_CUDA`
# is False and `marching_cubes` below never dispatches to a CUDA kernel.
HAS_CUDA = False

# MEASURED by verify_shim.py, not assumed: 'ascent' yields outward-facing triangles
# for a field whose high values are inside the object (TripoSR's density field
# is high inside the surface). scikit-image's own default ('descent') produced a
# NEGATIVE signed volume for the closed test solid, i.e. every triangle facing
# inward — which in the storefront viewer would render as an invisible or black
# model, because three.js draws front faces only. `verify_shim.py` measures both
# values and fails if this constant stops matching the measurement.
MAX_LEVEL_DIRECTION = "ascent"
# False because the measurement shows the winding is already outward once the
# columns are reversed; a reflection is exactly the operation that could flip it,
# so it stays an explicit, checked constant rather than an implicit assumption.
WINDING_REVERSED = False


def marching_cubes(vol: torch.Tensor, thresh: float):
    """Return `(vertices, faces)` for the `thresh` isosurface of `vol`.

    Drop-in for `torchmcubes.marching_cubes`: `vertices` is float32 with
    torchmcubes' `(dim2, dim1, dim0)` column layout and `faces` is int64 (what
    TripoSR hands to trimesh). Both live on `vol`'s device.
    """
    if not isinstance(vol, torch.Tensor):
        raise TypeError(f"vol must be a torch.Tensor, got {type(vol).__name__}")
    if vol.ndim != 3:
        raise ValueError(f"vol must be 3-dimensional, got shape {tuple(vol.shape)}")

    device = vol.device
    grid = vol.detach().to(device="cpu", dtype=torch.float32).contiguous().numpy()

    # An empty or non-finite field has no isosurface. torchmcubes returns empty
    # tensors rather than raising; scikit-image raises, so the range is checked
    # first and an empty result is returned in torchmcubes' own shape/dtype.
    empty_v = torch.zeros((0, 3), dtype=torch.float32, device=device)
    empty_f = torch.zeros((0, 3), dtype=torch.int64, device=device)
    if grid.size == 0 or grid.shape[0] < 2 or grid.shape[1] < 2 or grid.shape[2] < 2:
        return empty_v, empty_f
    if not np.isfinite(grid).all():
        return empty_v, empty_f
    level = float(thresh)
    if not (float(grid.min()) <= level <= float(grid.max())):
        return empty_v, empty_f

    verts, faces, _normals, _values = skmeasure.marching_cubes(
        grid,
        level=level,
        spacing=(1.0, 1.0, 1.0),
        gradient_direction=MAX_LEVEL_DIRECTION,
        allow_degenerate=True,
    )

    # `(dim2, dim1, dim0)` — see the module docstring. Then optional winding
    # correction (a no-op as measured, kept because a reflection is exactly the
    # operation that can flip orientation).
    verts = np.ascontiguousarray(verts[:, [2, 1, 0]], dtype=np.float32)
    faces = np.ascontiguousarray(faces, dtype=np.int64)
    if WINDING_REVERSED:
        faces = np.ascontiguousarray(faces[:, [0, 2, 1]], dtype=np.int64)

    return (
        torch.as_tensor(verts, dtype=torch.float32, device=device),
        torch.as_tensor(faces, dtype=torch.int64, device=device),
    )


def grid_interp(vol: torch.Tensor, points: torch.Tensor) -> torch.Tensor:
    """Not used by TripoSR's mesh path; present so an accidental import fails
    loudly instead of silently returning the wrong thing."""
    raise NotImplementedError("the shim implements only marching_cubes")
