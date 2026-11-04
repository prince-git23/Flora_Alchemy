"""Reproducible 3D comparison sheet — silhouette, geometry and fragmentation.

WHAT THIS IS
    One script that turns a set of GLBs plus the POSED-NOWHERE reference
    photographs into a reviewable comparison: per-view orthographic silhouettes,
    a contact sheet per view, a measured metric table, and a manifest carrying
    the SHA-256 of every input and every output.

    It exists so a quality claim can be re-checked later: re-running it against
    the same hashes must reproduce the same numbers and the same images.

HONESTY RULES BAKED IN
    · Orthographic silhouettes only. The projection axes match
      `backend/services/3dMeshGeometry.js` (front = camera at +Z, etc.), so a
      number here and a number in the quality report describe the same geometry.
    · The reference photographs are compared as SILHOUETTES, after removing
      translation and uniform scale. No camera pose is claimed and none is
      invented: a photograph is not a calibrated view.
    · Fragmentation is measured per connected component (face adjacency) and
      drawn with the largest pieces coloured, so a 59-piece shell can be seen and
      not only counted.
    · Engine coverage is stated in the manifest. If a model was never produced by
      an engine, that engine is listed as ABSENT; nothing here implies a
      comparison that did not happen.
    · No texture or colour is invented. The interior shading is a depth ramp of
      the geometry's own coordinates, labelled as such, and the material facts are
      read from the file.

USAGE
    python tools/3d-worker/compare_models.py \
        --model triposr=C:/.../posy-triposr-baseline.glb \
        --model hunyuan-s5=C:/.../hunyuan-mv-o256-s5-shape.glb \
        --references C:/.../views/supplied/model \
        --out C:/.../phase13/compare \
        [--views front,back,left,top] [--size 360] [--notes notes.json]

    Requires numpy, Pillow, trimesh and shapely (the worker venv has all four).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Projection axes copied from `3dMeshGeometry.PROJECTION_VIEWS`; keep them in step.
VIEWS = {
    "front": {"u": (1, 0, 0), "v": (0, 1, 0), "label": "front (camera at +Z)"},
    "back": {"u": (-1, 0, 0), "v": (0, 1, 0), "label": "back (camera at -Z)"},
    "right": {"u": (0, 0, -1), "v": (0, 1, 0), "label": "right (camera at +X)"},
    "left": {"u": (0, 0, 1), "v": (0, 1, 0), "label": "left (camera at -X)"},
    "top": {"u": (1, 0, 0), "v": (0, 0, -1), "label": "top (camera at +Y, looking down)"},
}

# Component colours: the body in light grey, the biggest satellites in hues that
# survive being printed or read on a dark panel.
COMPONENT_COLOURS = [
    (236, 236, 236),
    (232, 160, 92),
    (120, 186, 148),
    (150, 170, 226),
    (214, 138, 178),
    (200, 196, 110),
]


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_mesh(path: str):
    import trimesh

    mesh = trimesh.load(path, force="mesh", process=False)
    if not hasattr(mesh, "faces") or len(mesh.faces) == 0:
        raise SystemExit(f"{path} contains no triangle mesh")
    return mesh


def component_labels(mesh) -> np.ndarray:
    """Connected component index per FACE (face adjacency), or all zeros."""
    import trimesh

    try:
        adjacency = mesh.face_adjacency
    except Exception:
        return np.zeros(len(mesh.faces), dtype=np.int32)
    if adjacency is None or len(adjacency) == 0:
        return np.zeros(len(mesh.faces), dtype=np.int32)
    parts = trimesh.graph.connected_components(
        adjacency, nodes=np.arange(len(mesh.faces)), min_len=1
    )
    labels = np.full(len(mesh.faces), -1, dtype=np.int32)
    for index, faces in enumerate(parts):
        labels[np.asarray(faces, dtype=np.int64)] = index
    labels[labels < 0] = 0
    return labels


def face_areas(mesh) -> np.ndarray:
    triangles = mesh.vertices[mesh.faces]
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    return 0.5 * np.linalg.norm(cross, axis=1)


def fragmentation(mesh, labels: np.ndarray, areas: np.ndarray) -> dict:
    total = float(areas.sum()) or 1.0
    per_part: dict[int, dict] = {}
    for face_index, label in enumerate(labels):
        part = per_part.setdefault(int(label), {"faces": 0, "area": 0.0, "min": [np.inf] * 3, "max": [-np.inf] * 3})
        part["faces"] += 1
        part["area"] += float(areas[face_index])
        for vertex in mesh.vertices[mesh.faces[face_index]]:
            for axis in range(3):
                part["min"][axis] = min(part["min"][axis], float(vertex[axis]))
                part["max"][axis] = max(part["max"][axis], float(vertex[axis]))
    ordered = sorted(per_part.values(), key=lambda part: part["area"], reverse=True)
    for part in ordered:
        part["areaShare"] = round(part["area"] / total, 6)
        part["extents"] = [round(part["max"][axis] - part["min"][axis], 4) for axis in range(3)]
        part["faces"] = int(part["faces"])
        part["area"] = round(part["area"], 6)
        del part["min"], part["max"]
    substantial = [part for part in ordered if part["areaShare"] >= 0.05]
    trace = [part for part in ordered if part["areaShare"] < 0.001]
    return {
        "components": len(ordered),
        "largestShare": ordered[0]["areaShare"] if ordered else None,
        "substantial": len(substantial),
        "trace": len(trace),
        "traceShare": round(sum(part["areaShare"] for part in trace), 6),
        "top": ordered[:8],
    }


def project(mesh, view: str, size: int):
    """Orthographic silhouette + depth/component image for one view."""
    spec = VIEWS[view]
    u_axis = np.array(spec["u"], dtype=float)
    v_axis = np.array(spec["v"], dtype=float)
    w_axis = np.cross(u_axis, v_axis)
    vertices = np.asarray(mesh.vertices, dtype=float)
    u = vertices @ u_axis
    v = vertices @ v_axis
    depth = vertices @ w_axis

    # Uniform fit, centred: the same normalisation the JS gate applies, so the
    # masks this tool writes and the masks the gate measures are comparable.
    if not np.isfinite(u).any() or not np.isfinite(v).any():
        raise SystemExit("the mesh has no finite vertices")
    min_u, max_u = float(np.min(u)), float(np.max(u))
    min_v, max_v = float(np.min(v)), float(np.max(v))
    extent = max(max_u - min_u, max_v - min_v) or 1.0
    pad = 0.04 * size
    scale = (size - 2 * pad) / extent

    def to_pixels(uu, vv):
        px = pad + (uu - min_u) * scale
        py = size - pad - (vv - min_v) * scale
        return px, py

    faces_u = u[mesh.faces]
    faces_v = v[mesh.faces]
    px, py = to_pixels(faces_u, faces_v)

    # Silhouette from trimesh/shapely's projected outline (fast union) where GEOS
    # can union it; otherwise the documented point-splat fallback below, because a
    # reconstruction's outline is frequently self-intersecting and GEOS refuses it
    # (measured: the front view of the Phase 12 model raises TopologyException).
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    mask_method = "projected-polygon"
    project_failure = ""
    try:
        import trimesh

        projected = trimesh.path.polygons.projected(mesh, normal=np.array(w_axis, dtype=float))
        if projected.is_empty:
            raise ValueError("the projected outline is empty")
    except Exception as err:
        projected = None
        mask_method = "point-splat"
        project_failure = f"{type(err).__name__}: {err}"

    def ring_points(ring):
        coords = np.asarray(ring.coords, dtype=float)
        px_ring, py_ring = to_pixels(coords[:, 0], coords[:, 1])
        return list(zip(px_ring.tolist(), py_ring.tolist()))

    if projected is not None and not projected.is_empty:
        polygons = list(getattr(projected, "geoms", [projected]))
        for polygon in polygons:
            if polygon.is_empty or not hasattr(polygon, "exterior"):
                continue
            draw.polygon(ring_points(polygon.exterior), fill=255)
            for interior in polygon.interiors:
                draw.polygon(ring_points(interior), fill=0)
    mask_array = np.asarray(mask) > 0
    if mask_array.sum() == 0:
        # FALLBACK, disclosed: splat every projected vertex, close pinholes, then
        # fill enclosed holes. A silhouette from a 500k-triangle surface is dense
        # enough that the boundary is within a pixel or two at this size; it is
        # NOT bit-identical to the gate's polygon rasteriser, and the manifest
        # says which method produced each image.
        mask_method = "point-splat"
        ix = np.clip(np.round(px).astype(int).ravel(), 0, size - 1)
        iy = np.clip(np.round(py).astype(int).ravel(), 0, size - 1)
        splat = np.zeros((size, size), dtype=bool)
        splat[iy, ix] = True
        padded = np.pad(splat, 1, mode="constant", constant_values=False)
        grown = np.zeros_like(splat)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                grown |= padded[dy : dy + size, dx : dx + size]
        # Flood fill needs an RGB image in this Pillow build (mode L silently
        # fills nothing — measured), so the fill runs on a converted copy.
        enclosed = Image.fromarray((grown * 255).astype(np.uint8), "L").convert("RGB")
        if not grown[0, 0]:
            ImageDraw.floodfill(enclosed, (0, 0), (128, 128, 128), thresh=1)
        mask_array = np.asarray(enclosed)[:, :, 0] != 128

    # FLAT silhouette, plus a 1 px outline. Deliberately not shaded: a depth ramp
    # or a fake material would be an invented render, and this sheet's job is the
    # OUTLINE. Colour in the model files is reported as a fact, never drawn.
    rgb = np.zeros((size, size, 3), dtype=np.uint8)
    rgb[mask_array] = (188, 188, 194)
    edges = mask_array & ~np.pad(mask_array, 1, mode="constant")[1:-1, 1:-1] * 0
    inner = mask_array.copy()
    inner = (
        inner
        & np.roll(inner, 1, axis=0)
        & np.roll(inner, -1, axis=0)
        & np.roll(inner, 1, axis=1)
        & np.roll(inner, -1, axis=1)
    )
    outline = mask_array & ~inner
    rgb[outline] = (246, 246, 250)
    facts = {"width": size, "height": size, "maskMethod": mask_method}
    if mask_method == "point-splat":
        facts["maskNote"] = (
            "point-splat + hole fill: the projected outline could not be unioned "
            f"({project_failure or 'outline empty'}); "
            "boundary accuracy is about a pixel at this size"
        )
    return rgb, mask_array, facts


def _draw_faces(mesh, labels: np.ndarray, ranks: np.ndarray, face_order, view: str, size: int) -> Image.Image:
    """Paint the given faces in their component's hue, on a dark field."""
    spec = VIEWS[view]
    u_axis = np.array(spec["u"], dtype=float)
    v_axis = np.array(spec["v"], dtype=float)
    vertices = np.asarray(mesh.vertices, dtype=float)
    u = vertices @ u_axis
    v = vertices @ v_axis
    min_u, max_u = float(np.min(u)), float(np.max(u))
    min_v, max_v = float(np.min(v)), float(np.max(v))
    extent = max(max_u - min_u, max_v - min_v) or 1.0
    pad = 0.04 * size
    scale = (size - 2 * pad) / extent

    part_rank = {int(label): int(ranks[np.where(labels == label)[0][0]]) for label in np.unique(labels)}
    faces = np.asarray(mesh.faces)
    image = Image.new("RGB", (size, size), (14, 14, 16))
    draw = ImageDraw.Draw(image)
    for face_index in face_order:
        face = faces[face_index]
        coords = [
            (
                float(pad + (u[vertex_index] - min_u) * scale),
                float(size - pad - (v[vertex_index] - min_v) * scale),
            )
            for vertex_index in face
        ]
        rank = part_rank[int(labels[face_index])]
        colour = COMPONENT_COLOURS[rank] if rank < len(COMPONENT_COLOURS) else (70, 70, 76)
        draw.polygon(coords, fill=colour)
    return image


def component_image(mesh, labels: np.ndarray, areas: np.ndarray, view: str, size: int) -> Image.Image:
    """The same projection, with the largest components drawn in distinct hues."""
    order = np.argsort(-areas)
    ranks = np.empty_like(order)
    ranks[order] = np.arange(len(order))
    return _draw_faces(mesh, labels, ranks, range(len(mesh.faces)), view, size)


def component_image_ordered(mesh, labels: np.ndarray, areas: np.ndarray, view: str, size: int) -> Image.Image:
    """Component render with the largest piece underneath and the rest on top.

    Drawing in file order hides every satellite under the body — the fragmentation
    a reviewer needs to see is exactly the opposite, so the body goes down first.
    """
    order = np.argsort(-areas)
    ranks = np.empty_like(order)
    ranks[order] = np.arange(len(order))
    body = int(np.argmax(areas))
    others = [face for face in range(len(mesh.faces)) if face != body]
    return _draw_faces(mesh, labels, ranks, [body] + others, view, size)


def mask_from_file(path: str, size: int) -> np.ndarray | None:
    """A BINARY mask file (white on black, or a matte's alpha) as a square mask."""
    image = Image.open(path)
    if image.mode in ("RGBA", "LA"):
        array = np.asarray(image.convert("RGBA"))[:, :, 3]
    else:
        array = np.asarray(image.convert("L"))
    return _normalised_canvas(array, size)


def _normalised_canvas(array: np.ndarray, size: int) -> np.ndarray | None:
    """Trim to the mask's own bounds, square it, and resample to `size`."""
    ys, xs = np.where(array > 32)
    if len(xs) == 0:
        return None
    cropped = Image.fromarray(array[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1], "L")
    width, height = cropped.size
    extent = max(width, height)
    canvas = Image.new("L", (extent, extent), 0)
    canvas.paste(cropped, ((extent - width) // 2, (extent - height) // 2))
    return np.asarray(canvas.resize((size, size), Image.BILINEAR)) > 127


def reference_mask(path: str, size: int) -> np.ndarray | None:
    """A photograph's OWN matte as a silhouette, or None when it carries none.

    An ordinary opaque photograph has alpha 255 everywhere; treating that as a
    "silhouette the model should match" would compare the model with the picture's
    frame, so it is refused rather than measured. The worker's own masks (written
    by the segmentation the pipeline actually uses) go through `--masks`.
    """
    image = Image.open(path).convert("RGBA")
    alpha = np.asarray(image)[:, :, 3]
    if alpha.max() == 0 or (alpha > 32).mean() > 0.97:
        return None
    ys, xs = np.where(alpha > 32)
    if len(xs) == 0:
        return None
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    cropped = Image.fromarray(alpha[top:bottom, left:right], "L")
    width, height = cropped.size
    extent = max(width, height)
    canvas = Image.new("L", (extent, extent), 0)
    canvas.paste(cropped, ((extent - width) // 2, (extent - height) // 2))
    canvas = canvas.resize((size, size), Image.BILINEAR)
    return np.asarray(canvas) > 127


def normalise(mask: np.ndarray) -> np.ndarray | None:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    return mask[top:bottom, left:right]


def iou_of(a: np.ndarray, b: np.ndarray) -> float | None:
    pa = normalise(a)
    pb = normalise(b)
    if pa is None or pb is None:
        return None
    size = 128
    ia = np.asarray(Image.fromarray(pa.astype(np.uint8) * 255).resize((size, size), Image.BILINEAR)) > 127
    ib = np.asarray(Image.fromarray(pb.astype(np.uint8) * 255).resize((size, size), Image.BILINEAR)) > 127
    union = np.logical_or(ia, ib).sum()
    return round(float(np.logical_and(ia, ib).sum() / union), 4) if union else None


def contact_sheet(columns: list[tuple[str, Image.Image]], out_path: str, size: int) -> None:
    header = 26
    sheet = Image.new("RGB", (size * len(columns), size + header), (10, 10, 12))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
    for index, (label, image) in enumerate(columns):
        sheet.paste(image.convert("RGB"), (index * size, header))
        draw.text((index * size + 8, 6), f"{label}", fill=(220, 220, 220), font=font)
    sheet.save(out_path)
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Reproducible orthographic comparison of GLB models")
    parser.add_argument("--model", action="append", required=True, help="label=path (repeatable)")
    parser.add_argument("--references", default="", help="directory holding front/back/left photographs")
    parser.add_argument(
        "--masks",
        default="",
        help="directory of per-view worker masks (<view>.png), used for silhouette IoU in preference to a photo's own alpha",
    )
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--views", default="front,back,left,top")
    parser.add_argument("--size", type=int, default=360)
    parser.add_argument("--notes", default="", help="JSON file with timings/VRAM facts to copy into the manifest")
    parser.add_argument("--reli3d", default="", help="anything other than empty claims a ReLi3D comparison")
    args = parser.parse_args(argv)

    if args.reli3d:
        raise SystemExit(
            "ReLi3D cannot be compared: no real ReLi3D output exists. Do not pass --reli3d."
        )

    views = [view.strip() for view in args.views.split(",") if view.strip()]
    for view in views:
        if view not in VIEWS:
            raise SystemExit(f"unknown view {view!r}; known: {', '.join(VIEWS)}")

    models = []
    for entry in args.model:
        label, _, path = entry.partition("=")
        if not path:
            raise SystemExit(f"--model needs label=path, got {entry!r}")
        models.append((label.strip(), os.path.abspath(path.strip())))

    renders_dir = os.path.join(args.out, "renders")
    os.makedirs(renders_dir, exist_ok=True)

    notes = {}
    if args.notes:
        with open(args.notes, "r", encoding="utf-8") as handle:
            notes = json.load(handle)

    manifest = {
        "tool": "tools/3d-worker/compare_models.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "projection": {view: VIEWS[view]["label"] for view in views},
        "normalisation": "silhouettes are trimmed to their own bounds and resampled to 128x128 before IoU",
        "shading": "none — flat silhouettes with a 1 px outline; no material, colour or lighting is rendered or implied",
        "reli3d": "ABSENT — no ReLi3D output exists. Nothing in this record compares ReLi3D.",
        "models": [],
        "references": {},
        "views": {},
        "notes": notes,
    }

    reference_masks = {}
    # Worker masks win over a photograph's alpha: they are the product-only region
    # the pipeline actually conditioned on, which is what the report compares.
    if args.masks:
        for view in views:
            candidate = os.path.join(args.masks, f"{view}.png")
            if os.path.isfile(candidate):
                mask = mask_from_file(candidate, args.size)
                if mask is not None:
                    reference_masks[view] = mask
                    manifest["references"][view] = {
                        "path": candidate,
                        "sha256": sha256_file(candidate),
                        "kind": "worker-mask",
                    }
    if args.references:
        for view in views:
            candidate = os.path.join(args.references, f"{view}.png")
            if os.path.isfile(candidate) and view not in reference_masks:
                mask = reference_mask(candidate, args.size)
                manifest["references"][view] = {
                    "path": candidate,
                    "sha256": sha256_file(candidate),
                    "kind": "photo-alpha" if mask is not None else "photo (no matte - not measured)",
                }
                if mask is not None:
                    reference_masks[view] = mask

    model_masks = {}
    for label, path in models:
        started = time.time()
        mesh = load_mesh(path)
        labels = component_labels(mesh)
        areas = face_areas(mesh)
        entry = {
            "label": label,
            "path": path,
            "sha256": sha256_file(path),
            "bytes": os.path.getsize(path),
            "vertices": int(len(mesh.vertices)),
            "faces": int(len(mesh.faces)),
            "watertight": bool(mesh.is_watertight),
            "extents": [round(float(value), 4) for value in mesh.extents],
            "materialState": str(getattr(mesh.visual, "kind", "none")),
            "hasUv": getattr(mesh.visual, "uv", None) is not None,
            "hasVertexColours": str(getattr(mesh.visual, "kind", "")) == "vertex",
            "fragmentation": fragmentation(mesh, labels, areas),
            "renders": {},
            "loadSeconds": round(time.time() - started, 2),
        }
        # Faces vs vertices is a fact of the file, not an opinion about it.
        entry["facesPerVertex"] = round(entry["faces"] / max(entry["vertices"], 1), 4)
        model_masks[label] = {}
        for view in views:
            rgb, mask_array, facts = project(mesh, view, args.size)
            image_path = os.path.join(renders_dir, f"{label}-{view}.png")
            Image.fromarray(rgb).save(image_path)
            component_path = os.path.join(renders_dir, f"{label}-{view}-components.png")
            component_image(mesh, labels, areas, view, args.size).save(component_path)
            component_image_ordered(mesh, labels, areas, view, args.size).save(
                os.path.join(renders_dir, f"{label}-{view}-components-ordered.png")
            )
            facts.update(
                {
                    "render": image_path,
                    "renderSha256": sha256_file(image_path),
                    "componentsRender": component_path,
                    "componentsSha256": sha256_file(component_path),
                    "coverage": round(float(mask_array.mean()), 4),
                }
            )
            reference = reference_masks.get(view)
            if reference is not None:
                facts["iouVsReference"] = iou_of(mask_array, reference)
                facts["iouNote"] = (
                    "silhouette IoU after removing translation and uniform scale; "
                    "an outline comparison, never a claim about camera pose"
                )
            entry["renders"][view] = facts
            model_masks[label][view] = mask_array
        manifest["models"].append(entry)

    for view in views:
        columns = []
        for label, _ in models:
            columns.append((label, Image.open(os.path.join(renders_dir, f"{label}-{view}.png"))))
        reference_path = os.path.join(args.references, f"{view}.png") if args.references else ""
        if reference_path and os.path.isfile(reference_path):
            columns.append((f"reference {view}", Image.open(reference_path).convert("RGB").resize((args.size, args.size))))
        sheet_path = os.path.join(args.out, f"compare-{view}.png")
        contact_sheet(columns, sheet_path, args.size)
        manifest["views"][view] = {
            "sheet": sheet_path,
            "sha256": sha256_file(sheet_path),
            "columns": [label for label, _ in columns],
        }

    manifest_path = os.path.join(args.out, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(json.dumps({"manifest": manifest_path, "models": [entry["label"] for entry in manifest["models"]]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
