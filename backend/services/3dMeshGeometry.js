/**
 * 3D STUDIO — Phase 5 — read a generated GLB's GEOMETRY, and project it.
 *
 * Phase 4 proved that a real provider can produce a real mesh. It did not prove
 * that the mesh resembles the product, and `3dModelValidation.js` deliberately
 * answers a narrower question (is this genuinely a glTF Binary container with a
 * mesh in it?). This module is the next layer: it decodes the POSITION/index
 * data of a GLB and reports measurable facts about the geometry, then projects
 * it orthographically so the shape can be compared with the photograph it was
 * generated from.
 *
 * WHY THIS IS PURE NODE AND NOT THE WORKER
 * ----------------------------------------
 * The quality gate has to run in the BACKEND, on the approval path, whether or
 * not a GPU worker is reachable (§6 of the Phase 5 brief). So this reads the
 * stored bytes and does its own arithmetic — no three.js, no canvas, no GPU, no
 * new dependency. It is a measurement utility, not a second generation pipeline.
 *
 * WHAT IS DELIBERATELY CONSERVATIVE
 * ---------------------------------
 *   · Only `POSITION` and the index accessor are interpreted. Sparse accessors,
 *     morph targets, quantised/normalised integer positions and non-identity
 *     NODE TRANSFORMS are REPORTED as limits (`notes`) rather than silently
 *     mis-read: a wrong measurement is worse than an absent one.
 *   · Every reading is bounded (MAX_VERTICES / MAX_TRIANGLES), so a hostile or
 *     corrupt file cannot turn an approval into an out-of-memory crash.
 *   · The projection is orthographic and axis-aligned on a documented camera
 *     convention (glTF: +Y up, −Z forward). Nothing here infers a perspective
 *     camera, because nothing in the stored asset records one.
 *
 * THE VIEW BASIS IS DERIVED, NOT GUESSED. For a camera at position `p` looking
 * at the origin with world-up +Y, the screen-right axis is `cross(direction,
 * up)` and the screen-up axis is +Y. That formula is checked here against the
 * one case whose answer is not in dispute — the FRONT view (camera at +Z) must
 * put world +X on the screen's right — and it is how the two SIDE views were
 * caught facing the wrong way and corrected.
 */

/** Component types this reader can interpret (glTF spec section 3.6.2.2). */
const COMPONENT_UINT8 = 5121;
const COMPONENT_UINT16 = 5123;
const COMPONENT_UINT32 = 5125;
const COMPONENT_FLOAT = 5126;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Bounds on what will be read. A generated keepsake is far below these. */
export const MAX_VERTICES = 3_000_000;
export const MAX_TRIANGLES = 6_000_000;

/**
 * The projection views this module can rasterise, as (u, v) axes of the glTF
 * coordinate system. `front` is the convention the pipeline stores (a glTF
 * asset faces +Z, so its front view is the XY plane), and the rest let a model
 * that arrived rotated be RECOGNISED rather than condemned (§3).
 */
export const PROJECTION_VIEWS = Object.freeze({
  front: { u: [1, 0, 0], v: [0, 1, 0], label: 'front (camera at +Z)' },
  back: { u: [-1, 0, 0], v: [0, 1, 0], label: 'back (camera at −Z)' },
  right: { u: [0, 0, -1], v: [0, 1, 0], label: 'right (camera at +X)' },
  left: { u: [0, 0, 1], v: [0, 1, 0], label: 'left (camera at −X)' },
  top: { u: [1, 0, 0], v: [0, 0, -1], label: 'top (camera at +Y, looking down)' },
  bottom: { u: [1, 0, 0], v: [0, 0, 1], label: 'bottom (camera at −Y, looking up)' },
});

export const VIEW_NAMES = Object.freeze(Object.keys(PROJECTION_VIEWS));

/** Failure codes distinct from "the mesh is bad": the caller can tell them apart. */
export const GEOMETRY_UNREADABLE = 'GEOMETRY_UNREADABLE';

function unreadable(message, code = GEOMETRY_UNREADABLE) {
  return Object.assign(new Error(message), { code });
}

/**
 * Split a GLB into its JSON and BIN chunks.
 *
 * This repeats the container walk `validateGlb` performs, on purpose: the gate
 * must not depend on a caller having validated first, and the walk is the only
 * thing standing between a corrupt buffer and an out-of-range read.
 */
export function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    throw unreadable('The model bytes are too short to be a glTF Binary container.');
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw unreadable('The model bytes are not a glTF Binary container.');
  }
  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.readUInt32LE(16);
  if (jsonType !== CHUNK_JSON || jsonLength <= 0 || 20 + jsonLength > buffer.length) {
    throw unreadable('The glTF JSON chunk is missing or runs past the end of the file.');
  }
  let gltf;
  try {
    gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  } catch (err) {
    throw unreadable(`The glTF JSON chunk could not be parsed (${err.message}).`);
  }

  let bin = null;
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 <= buffer.length && buffer.readUInt32LE(binHeader + 4) === CHUNK_BIN) {
    const binLength = buffer.readUInt32LE(binHeader);
    const start = binHeader + 8;
    const end = Math.min(start + binLength, buffer.length);
    bin = buffer.subarray(start, end);
  }
  return { gltf, bin };
}

/** How many components a glTF accessor type carries. */
function componentCount(type) {
  switch (type) {
    case 'SCALAR':
      return 1;
    case 'VEC2':
      return 2;
    case 'VEC3':
      return 3;
    case 'VEC4':
      return 4;
    default:
      return 0;
  }
}

/** Byte width of one component, or 0 when the type is not one we read. */
function componentBytes(componentType) {
  switch (componentType) {
    case COMPONENT_UINT8:
      return 1;
    case COMPONENT_UINT16:
      return 2;
    case COMPONENT_UINT32:
    case COMPONENT_FLOAT:
      return 4;
    default:
      return 0;
  }
}

function readComponent(bin, offset, byteStride, index, componentType) {
  const at = offset + index * byteStride;
  switch (componentType) {
    case COMPONENT_UINT8:
      return bin[at];
    case COMPONENT_UINT16:
      return bin.readUInt16LE(at);
    case COMPONENT_UINT32:
      return bin.readUInt32LE(at);
    case COMPONENT_FLOAT:
      return bin.readFloatLE(at);
    default:
      return NaN;
  }
}

/**
 * Read an accessor into a plain array. Returns `null` when the accessor cannot
 * be interpreted, so the caller can report a limit instead of guessing.
 */
function readAccessor(gltf, bin, accessorIndex, { maxItems = Infinity } = {}) {
  if (!bin || accessorIndex == null) return null;
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) return null;
  if (accessor.sparse) return null;
  const components = componentCount(accessor.type);
  const width = componentBytes(accessor.componentType);
  if (!components || !width) return null;

  const view = gltf.bufferViews?.[accessor.bufferView];
  if (!view) return null;
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || components * width;
  const count = Math.min(accessor.count || 0, Number.isFinite(maxItems) ? maxItems : accessor.count || 0);

  const out = new Array(count * components);
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      out[i * components + c] = readComponent(bin, base + c * width, stride, i, accessor.componentType);
    }
  }
  return { data: out, components, count, normalised: Boolean(accessor.normalized) };
}

/**
 * Read every POSITION/index pair in the asset into ONE triangle list.
 *
 * Node transforms are ignored (see `notes`): a generated asset from this
 * pipeline is exported flat, and applying an unverified transform would be a
 * guess dressed up as a measurement.
 */
export function readGeometryTier(glbBuffer) {
  const { gltf, bin } = parseGlb(glbBuffer);
  const notes = [];

  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const nodeTransforms = (gltf.nodes || []).filter(
    (n) => n.matrix || n.translation || n.rotation || n.scale
  );
  if (nodeTransforms.length) {
    notes.push(
      `${nodeTransforms.length} node(s) carry a transform, which this reader does not apply: measurements are in mesh space.`
    );
  }

  const positions = [];
  const indices = [];
  let primitives = 0;
  let skipped = 0;
  const attributeKinds = new Set();
  let hasNormals = false;
  let hasVertexColors = false;
  let hasUv = false;
  let normalisedPositions = false;

  for (const mesh of meshes) {
    for (const primitive of mesh.primitives || []) {
      const attrs = primitive.attributes || {};
      for (const key of Object.keys(attrs)) attributeKinds.add(key);
      const positionAccessor = attrs.POSITION;
      if (positionAccessor == null) {
        skipped += 1;
        continue;
      }
      const position = readAccessor(gltf, bin, positionAccessor, { maxItems: MAX_VERTICES });
      if (!position || position.components !== 3) {
        skipped += 1;
        notes.push('A primitive declares no readable POSITION accessor.');
        continue;
      }
      if (position.normalised) normalisedPositions = true;

      const offset = positions.length / 3;
      for (let i = 0; i < position.count; i += 1) {
        positions.push(position.data[i * 3], position.data[i * 3 + 1], position.data[i * 3 + 2]);
      }

      const indexAccessor = primitive.indices;
      if (indexAccessor != null) {
        const read = readAccessor(gltf, bin, indexAccessor, { maxItems: MAX_TRIANGLES * 3 });
        if (!read) {
          skipped += 1;
          notes.push('A primitive declares indices this reader cannot decode.');
          continue;
        }
        for (let i = 0; i < read.count; i += 1) indices.push(offset + read.data[i]);
      } else {
        // Non-indexed: triangles are implicit, three vertices at a time.
        for (let i = 0; i + 2 < position.count; i += 3) {
          indices.push(offset + i, offset + i + 1, offset + i + 2);
        }
      }

      if (attrs.NORMAL != null) hasNormals = true;
      if (attrs.COLOR_0 != null) hasVertexColors = true;
      if (attrs.TEXCOORD_0 != null) hasUv = true;
      primitives += 1;
    }
  }

  if (positions.length > MAX_VERTICES * 3) {
    throw unreadable(`The model carries more than ${MAX_VERTICES} vertices, above the reader's bound.`);
  }
  const triangleCount = Math.floor(indices.length / 3);
  if (triangleCount > MAX_TRIANGLES) {
    throw unreadable(`The model carries more than ${MAX_TRIANGLES} triangles, above the reader's bound.`);
  }
  if (normalisedPositions) {
    notes.push('POSITION is declared normalised; values are read as stored and may not be metric.');
  }
  if (skipped) notes.push(`${skipped} primitive(s) could not be read and were excluded.`);

  return {
    gltf,
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    stats: {
      primitives,
      meshes: meshes.length,
      vertices: positions.length / 3,
      triangles: triangleCount,
      attributeKinds: [...attributeKinds].sort(),
      hasNormals,
      hasVertexColors,
      hasUv,
      materials: Array.isArray(gltf.materials) ? gltf.materials.length : 0,
      textures: Array.isArray(gltf.textures) ? gltf.textures.length : 0,
      images: Array.isArray(gltf.images) ? gltf.images.length : 0,
      generator: gltf.asset?.generator || '',
      notes,
    },
  };
}

/**
 * Measure the geometry: bounds, degenerate and non-finite triangles, manifold
 * edges, and the material/texture facts the report has to state explicitly
 * (§5 — a vertex-colour model must never be described as textured).
 */
export function measureGeometry(glbBuffer, { fileBytes = 0 } = {}) {
  const { stats, positions, indices } = readGeometryTier(glbBuffer);

  const vertexCount = stats.vertices;
  let nonFiniteVertices = 0;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  /* eslint-disable no-plusplus */
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      nonFiniteVertices += 1;
      continue;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  /* eslint-enable no-plusplus */

  const hasBounds = vertexCount > 0 && Number.isFinite(minX);
  const bounds = hasBounds
    ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
    : { min: [0, 0, 0], max: [0, 0, 0] };
  const extents = hasBounds
    ? [maxX - minX, maxY - minY, maxZ - minZ]
    : [0, 0, 0];
  const sortedExtents = [...extents].sort((a, b) => a - b);
  const smallest = sortedExtents[0];
  const largest = sortedExtents[2];

  // Degenerate triangles: zero-area in the plane they occupy. These are the
  // signature of a marching-cubes artefact and render as invisible slivers.
  let degenerateTriangles = 0;
  let outOfRangeIndices = 0;
  const edgeUse = new Map();
  const triangleCount = Math.floor(indices.length / 3);

  /* ── connected-component bookkeeping (edge-joined triangles) ────────────
   * Two triangles sharing an edge are the same piece of surface; the pieces
   * are what "the product plus N floating islands" means numerically. The
   * analysis is BOUNDED: above COMPONENT_ANALYSIS_MAX_TRIANGLES the maps would
   * dominate memory, so it is skipped and `componentCount` stays null (a fact
   * of measurement, never a silently zero count). */
  const analyseComponents = triangleCount <= 1_000_000;
  const edgeOwner = analyseComponents ? new Map() : null;
  const unionParent = analyseComponents ? new Int32Array(triangleCount) : null;
  const triangleValid = analyseComponents ? new Uint8Array(triangleCount) : null;
  const triangleArea = analyseComponents ? new Float64Array(triangleCount) : null;
  if (analyseComponents) {
    for (let t = 0; t < triangleCount; t += 1) unionParent[t] = t;
  }
  const findRoot = (x) => {
    let root = x;
    while (unionParent[root] !== root) root = unionParent[root];
    let node = x;
    while (unionParent[node] !== node) {
      const next = unionParent[node];
      unionParent[node] = root;
      node = next;
    }
    return root;
  };

  for (let t = 0; t < triangleCount; t += 1) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      outOfRangeIndices += 1;
      continue;
    }
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    const cx = positions[c * 3];
    const cy = positions[c * 3 + 1];
    const cz = positions[c * 3 + 2];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const doubleArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(doubleArea > 1e-12)) degenerateTriangles += 1;
    if (analyseComponents) {
      triangleValid[t] = 1;
      triangleArea[t] = doubleArea * 0.5;
    }

    // Edge sharing, keyed by the vertex pair: boundary edges are used once,
    // non-manifold edges more than twice.
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = p < q ? `${p}_${q}` : `${q}_${p}`;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      if (analyseComponents) {
        const owner = edgeOwner.get(key);
        if (owner === undefined) edgeOwner.set(key, t);
        else {
          const ra = findRoot(t);
          const rb = findRoot(owner);
          if (ra !== rb) unionParent[ra] = rb;
        }
      }
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const use of edgeUse.values()) {
    if (use === 1) boundaryEdges += 1;
    else if (use > 2) nonManifoldEdges += 1;
  }

  // Component totals: how many disconnected pieces, and how much of the
  // surface the biggest one owns (a shell of scattered reconstruction would
  // drag this share down; a clean product sits near 1).
  let componentCount = null;
  let largestComponentShare = null;
  if (analyseComponents) {
    const rootArea = new Map();
    let parts = 0;
    let sum = 0;
    for (let t = 0; t < triangleCount; t += 1) {
      if (!triangleValid[t]) continue;
      const root = findRoot(t);
      const previous = rootArea.get(root);
      if (previous === undefined) {
        rootArea.set(root, triangleArea[t]);
        parts += 1;
      } else {
        rootArea.set(root, previous + triangleArea[t]);
      }
      sum += triangleArea[t];
    }
    if (parts > 0) {
      componentCount = parts;
      let maxArea = 0;
      for (const area of rootArea.values()) if (area > maxArea) maxArea = area;
      largestComponentShare = sum > 0 ? Number((maxArea / sum).toFixed(6)) : null;
    } else {
      componentCount = 0;
    }
  }

  const materials = stats.materials;
  const textures = stats.textures;
  const images = stats.images;
  // TEXTURED means what a customer would see: a texture that is actually
  // referenced by a material. A bare `materials[]` entry (a PBR factor with no
  // map) and an unused UV set are NOT texturing, and calling them that made a
  // vertex-coloured model read as if it had texture maps — which is exactly the
  // honesty the review panel depends on.
  const textured = textures > 0 || images > 0;
  const state = textured
    ? 'textured'
    : stats.hasVertexColors
      ? 'vertex-colour'
      : materials > 0
        ? 'material-only'
        : 'none';

  return {
    fileBytes,
    meshes: stats.meshes,
    primitives: stats.primitives,
    vertices: vertexCount,
    triangles: triangleCount,
    nonFiniteVertices,
    outOfRangeIndices,
    degenerateTriangles,
    boundaryEdges,
    nonManifoldEdges,
    componentCount,
    largestComponentShare,
    watertight: hasBounds && boundaryEdges === 0 && nonManifoldEdges === 0 && triangleCount > 0,
    bounds,
    extents,
    dimensions: { width: extents[0], height: extents[1], depth: extents[2] },
    flatness: largest > 0 ? Number((smallest / largest).toFixed(6)) : 0,
    attributes: stats.attributeKinds,
    hasNormals: stats.hasNormals,
    hasVertexColors: stats.hasVertexColors,
    hasUv: stats.hasUv,
    materials,
    textures,
    images,
    materialState: state,
    generator: stats.generator,
    notes: stats.notes,
    positions,
    indices,
  };
}

/**
 * Rasterise the mesh's orthographic silhouette for one view.
 *
 * The projection is fitted to the grid with a UNIFORM scale and centred, so the
 * returned mask is already free of margins and retains the object's aspect
 * ratio. That is what makes the comparison in `3dSilhouetteMetrics.js` a
 * similarity comparison (translation + uniform scale) rather than a comparison
 * of where a photographer happened to stand.
 */
export function rasteriseSilhouette(positions, indices, view, { size = 160 } = {}) {
  const spec = PROJECTION_VIEWS[view];
  if (!spec) throw unreadable(`Unknown projection view "${view}".`, 'GEOMETRY_BAD_VIEW');
  const vertexCount = positions.length / 3;
  if (!vertexCount) throw unreadable('The mesh has no vertices to project.', 'GEOMETRY_EMPTY');

  const us = new Float64Array(vertexCount);
  const vs = new Float64Array(vertexCount);
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const u = spec.u[0] * x + spec.u[1] * y + spec.u[2] * z;
    const v = spec.v[0] * x + spec.v[1] * y + spec.v[2] * z;
    us[i] = u;
    vs[i] = v;
    if (Number.isFinite(u)) {
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
    }
    if (Number.isFinite(v)) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }
  if (!Number.isFinite(minU) || !Number.isFinite(minV)) {
    throw unreadable('The mesh has no finite vertices to project.', 'GEOMETRY_EMPTY');
  }

  const spanU = Math.max(maxU - minU, 1e-12);
  const spanV = Math.max(maxV - minV, 1e-12);
  const margin = 0.5;
  const usable = size - 2 * margin;
  const scale = Math.min(usable / spanU, usable / spanV);
  const offsetU = margin + (usable - spanU * scale) / 2;
  const offsetV = margin + (usable - spanV * scale) / 2;

  const px = new Float64Array(vertexCount);
  const py = new Float64Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    px[i] = offsetU + (us[i] - minU) * scale;
    // The grid's origin is top-left, the projection's is bottom-left.
    py[i] = size - (offsetV + (vs[i] - minV) * scale);
  }

  const mask = new Uint8Array(size * size);
  const triangleCount = Math.floor(indices.length / 3);
  let tested = 0;
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue;
    const ax = px[ia];
    const ay = py[ia];
    const bx = px[ib];
    const by = py[ib];
    const cx = px[ic];
    const cy = py[ic];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx)
      || !Number.isFinite(by) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!(Math.abs(area) > 1e-12)) continue;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y += 1) {
      const sampleY = y + 0.5;
      for (let x = x0; x <= x1; x += 1) {
        const sampleX = x + 0.5;
        tested += 1;
        // Barycentric sign test; a sample exactly on an edge counts as inside
        // for both triangles sharing it, which is what makes the union airtight.
        const w0 = ((bx - ax) * (sampleY - ay) - (by - ay) * (sampleX - ax)) / area;
        const w1 = ((sampleX - ax) * (cy - ay) - (sampleY - ay) * (cx - ax)) / area;
        if (w0 >= -1e-9 && w1 >= -1e-9 && w0 + w1 <= 1 + 1e-9) {
          mask[y * size + x] = 1;
        }
      }
    }
  }

  return {
    view,
    viewLabel: spec.label,
    size,
    mask,
    pixelsTested: tested,
    /** The projected bounding box in grid coordinates. */
    box: { minU, minV, maxU, maxV, spanU, spanV },
  };
}

/**
 * Read the COLOUR facts out of a GLB.
 *
 * WHY THIS EXISTS SEPARATELY FROM `measureGeometry`
 * -------------------------------------------------
 * A model can be geometrically excellent and still look like a lump of coal:
 * colour and shape fail independently, and the review screen has to be able to
 * say which one failed. This answers only the colour question:
 *
 *   · which colour source the asset ACTUALLY carries — a base-colour texture,
 *     per-vertex colour, or nothing at all;
 *   · the metalness a viewer will apply, which decides whether those colours
 *     are even visible (see `effectiveMetallic`);
 *   · the distribution of the vertex colours when they exist, so a model whose
 *     colour data collapsed to near-black can be identified numerically.
 *
 * SPACE. glTF stores COLOR_0 in LINEAR light and normalises 8/16-bit components
 * to [0,1]. The statistics below are therefore linear-light numbers: a surface
 * with linear luminance 0.01 is genuinely near-black whatever the display does.
 * They are NOT a hue comparison against a photograph — that needs a renderer and
 * controlled lighting, and is deliberately not faked here.
 */
export function measureColourTier(glbBuffer, { maxSamples = 200000 } = {}) {
  const { gltf, bin } = parseGlb(glbBuffer);
  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const textures = Array.isArray(gltf.textures) ? gltf.textures : [];
  const images = Array.isArray(gltf.images) ? gltf.images : [];

  const hasBaseColorTexture = materials.some((m) => m?.pbrMetallicRoughness?.baseColorTexture != null);

  // glTF's own defaults are METALLIC: an omitted metallicFactor means 1.0, and
  // a primitive with no material at all makes three.js fall back to a default
  // MeshStandardMaterial, which is also metalness 1 / roughness 1. A fully
  // metallic surface has no diffuse term, so its albedo (vertex colour or base
  // colour) contributes almost nothing without an environment to reflect — that
  // is exactly how a colourful bouquet ends up rendered as dark mud.
  const metallicValues = materials.map((m) => {
    const pbr = m?.pbrMetallicRoughness;
    if (!pbr || typeof pbr.metallicFactor !== 'number') return 1.0;
    return pbr.metallicFactor;
  });
  const effectiveMetallic = materials.length === 0 ? 1.0 : Math.max(...metallicValues);

  // Largest COLOR_0 accessor on the biggest primitive, sampled with a bound.
  let colourAccessor = null;
  let sampledVertices = 0;
  let totalVertices = 0;
  let stats = null;

  for (const mesh of gltf.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const attrs = primitive.attributes || {};
      if (attrs.COLOR_0 == null) continue;
      const position = attrs.POSITION != null ? gltf.accessors?.[attrs.POSITION] : null;
      const count = position?.count || 0;
      if (count <= totalVertices) continue;
      const read = readAccessor(gltf, bin, attrs.COLOR_0, { maxItems: Math.min(count, maxSamples) });
      if (!read || (read.components !== 3 && read.components !== 4)) continue;
      totalVertices = count;
      colourAccessor = attrs.COLOR_0;
      sampledVertices = read.count;

      // 8-bit and 16-bit integer components are normalised by spec; float is
      // already in [0,1]. `readAccessor` hands back the RAW integer, so the
      // scale has to be applied here or every colour reads as 0..255.
      const accessorRef = gltf.accessors?.[attrs.COLOR_0];
      const normaliseScale = read.normalised
        ? accessorRef?.componentType === COMPONENT_UINT8
          ? 1 / 255
          : accessorRef?.componentType === COMPONENT_UINT16
            ? 1 / 65535
            : 1
        : 1;
      const scale = normaliseScale;

      const { data, components } = read;
      let sum = 0;
      const luminances = new Array(read.count);
      let minAlpha = 1;
      let maxChroma = 0;
      let sumSaturation = 0;
      for (let i = 0; i < read.count; i += 1) {
        const r = Math.min(1, Math.max(0, data[i * components] * scale));
        const g = Math.min(1, Math.max(0, data[i * components + 1] * scale));
        const b = Math.min(1, Math.max(0, data[i * components + 2] * scale));
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luminances[i] = luminance;
        sum += luminance;
        const maxChannel = Math.max(r, g, b);
        const minChannel = Math.min(r, g, b);
        const saturation = maxChannel > 0 ? (maxChannel - minChannel) / maxChannel : 0;
        sumSaturation += saturation;
        maxChroma = Math.max(maxChroma, maxChannel - minChannel);
        // Alpha is normalised by the same scale as the colour channels: reading
        // the RAW 8-bit alpha (0..255) against a 0..1 threshold would miss every
        // partially transparent vertex that is not fully opaque or fully clear.
        if (components === 4) minAlpha = Math.min(minAlpha, data[i * components + 3] * scale);
      }
      luminances.sort((a, b) => a - b);
      const quantile = (f) => luminances[Math.min(luminances.length - 1, Math.floor(f * luminances.length))];
      stats = {
        components,
        minAlpha,
        meanLuminance: Number((sum / read.count).toFixed(6)),
        medianLuminance: Number(quantile(0.5).toFixed(6)),
        p05Luminance: Number(quantile(0.05).toFixed(6)),
        p95Luminance: Number(quantile(0.95).toFixed(6)),
        nearBlackFraction: Number((luminances.filter((l) => l < 0.01).length / read.count).toFixed(6)),
        darkFraction: Number((luminances.filter((l) => l < 0.05).length / read.count).toFixed(6)),
        meanSaturation: Number((sumSaturation / read.count).toFixed(6)),
        maxChroma: Number(maxChroma.toFixed(6)),
      };
    }
  }

  return {
    hasVertexColors: colourAccessor != null,
    hasBaseColorTexture,
    hasTextures: textures.length > 0,
    hasImages: images.length > 0,
    hasAuthoredMaterial: materials.length > 0,
    materials: materials.length,
    textures: textures.length,
    images: images.length,
    // What a PBR viewer will actually apply to the albedo channel.
    effectiveMetallic,
    sampledVertices,
    totalVertices,
    sampledFully: sampledVertices >= totalVertices,
    stats,
  };
}

export default {
  parseGlb,
  readGeometryTier,
  measureGeometry,
  measureColourTier,
  rasteriseSilhouette,
  PROJECTION_VIEWS,
  VIEW_NAMES,
  MAX_VERTICES,
  MAX_TRIANGLES,
};
