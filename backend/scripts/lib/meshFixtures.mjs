/**
 * PHASE 5 TEST FIXTURES — deterministic geometry and reference images.
 *
 * ═══ NOTHING HERE IS AN AI-GENERATED PRODUCT ═══
 *
 * These builders exist so the quality gate can be exercised on shapes whose
 * ANSWER IS KNOWN: a box IS a box, so a silhouette comparison against a
 * rectangle must score high, and against a wide band it must score low. That is
 * what makes a threshold test meaningful — a genuine TripoSR mesh cannot tell
 * you whether a failure is the gate's arithmetic or the model's quality.
 *
 * A fixture is never reported as a generated model. The suite labels every
 * section that uses one, and `confidence`/`provider` fields are only ever set
 * from real rows.
 *
 * The meshes are built properly rather than minimally: shared vertices across
 * face boundaries (so the surface is genuinely WATERTIGHT, not six loose quads),
 * outward normals, and enough triangles to clear the gate's own density floor.
 * A fixture that only passed because the measurer was lenient would prove
 * nothing.
 */

import sharp from 'sharp';

/* ── GLB container assembly ──────────────────────────────────────────────── */

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT8 = 5121;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/**
 * Assemble a glTF Binary container from accessors described as plain arrays.
 * Padding follows the spec (JSON with spaces, BIN with zeros), because a GLB
 * whose chunks are not 4-byte aligned is not a valid GLB at all.
 */
export function assembleGlb({
  positions,
  indices,
  normals = null,
  colors = null,
  generator = 'flora-phase5-fixture',
  // Declarations only: a material/texture entry in the JSON chunk. Used by the
  // Phase 2 suite, which asserts that the container facts a candidate records
  // match the container it received — those assertions stay meaningful because
  // the declarations are real, countable entries, not a mocked counter.
  textureCount = 0,
  meshCount = 1,
  // A real material entry. Used by the colour tests, which need to prove the
  // difference between "colour with a dielectric material" (renders) and
  // "colour with NO material" (glTF's metallic default suppresses it).
  material = null,
}) {
  const accessors = [];
  const bufferViews = [];
  const chunks = [];
  let byteOffset = 0;

  const pushView = (buffer, target) => {
    const aligned = (byteOffset + 3) & ~3;
    if (aligned > byteOffset) {
      chunks.push(Buffer.alloc(aligned - byteOffset));
      byteOffset = aligned;
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length, target });
    chunks.push(buffer);
    byteOffset += buffer.length;
    return bufferViews.length - 1;
  };

  const vec3MinMax = (data) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.length; i += 3) {
      for (let c = 0; c < 3; c += 1) {
        if (data[i + c] < min[c]) min[c] = data[i + c];
        if (data[i + c] > max[c]) max[c] = data[i + c];
      }
    }
    return { min, max };
  };

  const positionBuffer = Buffer.alloc(positions.length * 4);
  positions.forEach((value, index) => positionBuffer.writeFloatLE(value, index * 4));
  const positionView = pushView(positionBuffer, TARGET_ARRAY_BUFFER);
  const { min, max } = vec3MinMax(positions);
  accessors.push({
    bufferView: positionView,
    componentType: COMPONENT_FLOAT,
    count: positions.length / 3,
    type: 'VEC3',
    min,
    max,
  });
  const positionAccessor = accessors.length - 1;

  let normalAccessor = null;
  if (normals) {
    const buffer = Buffer.alloc(normals.length * 4);
    normals.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
    normalAccessor = accessors.push({
      bufferView: pushView(buffer, TARGET_ARRAY_BUFFER),
      componentType: COMPONENT_FLOAT,
      count: normals.length / 3,
      type: 'VEC3',
    }) - 1;
  }

  let colorAccessor = null;
  if (colors) {
    const buffer = Buffer.alloc(colors.length);
    colors.forEach((value, index) => {
      buffer[index] = value;
    });
    colorAccessor = accessors.push({
      bufferView: pushView(buffer, TARGET_ARRAY_BUFFER),
      componentType: COMPONENT_UINT8,
      normalized: true,
      count: colors.length / 4,
      type: 'VEC4',
    }) - 1;
  }

  const indexBuffer = Buffer.alloc(indices.length * 4);
  indices.forEach((value, index) => indexBuffer.writeUInt32LE(value, index * 4));
  const indexView = pushView(indexBuffer, TARGET_ELEMENT_ARRAY_BUFFER);
  accessors.push({
    bufferView: indexView,
    componentType: 5125,
    count: indices.length,
    type: 'SCALAR',
  });
  const indexAccessor = accessors.length - 1;

  const attributes = { POSITION: positionAccessor };
  if (normalAccessor != null) attributes.NORMAL = normalAccessor;
  if (colorAccessor != null) attributes.COLOR_0 = colorAccessor;

  const meshes = Array.from({ length: Math.max(1, meshCount) }, () => ({
    primitives: [{ attributes, indices: indexAccessor }],
  }));

  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  if (textureCount > 0) {
    gltf.materials = Array.from({ length: textureCount }, (_, index) => ({
      name: `fixture-material-${index}`,
      pbrMetallicRoughness: { baseColorTexture: { index } },
    }));
    gltf.textures = Array.from({ length: textureCount }, (_, index) => ({ source: index }));
    gltf.images = Array.from({ length: textureCount }, (_, index) => ({
      name: `fixture-image-${index}`,
      mimeType: 'image/png',
      uri: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`,
    }));
  }

  if (material) {
    gltf.materials = Array.isArray(gltf.materials) ? [...gltf.materials, material] : [material];
    const materialIndex = gltf.materials.length - 1;
    for (const mesh of gltf.meshes) {
      for (const primitive of mesh.primitives || []) primitive.material = materialIndex;
    }
  }

  let jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

  let bin = Buffer.concat(chunks);
  const binPad = (4 - (bin.length % 4)) % 4;
  if (binPad) bin = Buffer.concat([bin, Buffer.alloc(binPad)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

/* ── geometry ────────────────────────────────────────────────────────────── */

/**
 * A watertight, outward-facing box built from a SHARED shell of grid points.
 *
 * `segments` controls the subdivision: triangles = 12·segments², so the default
 * 5 gives 300 triangles, comfortably above the gate's 200 floor. Vertices are
 * deduplicated by coordinate, which is what makes the measured surface closed
 * rather than six disconnected panels.
 */
export function buildBoxGlb({
  width = 1,
  height = 1,
  depth = 1,
  segments = 5,
  vertexColors = false,
  withNormals = true,
  textureCount = 0,
  meshCount = 1,
  // The fixture's per-vertex colour, so a colour test can build a NEAR-BLACK or
  // GREY box and assert the colour gate notices it — without shipping a blob.
  color = [180, 120, 60],
  // A real material entry, so a colour test can prove that colour data only
  // renders when a material is present (see assembleGlb's material note).
  material = null,
} = {}) {
  const S = Math.max(1, Math.floor(segments));
  const key = (i, j, k) => `${i}_${j}_${k}`;
  const index = new Map();
  const positions = [];
  const normals = [];
  const colors = [];

  const sx = width / 2;
  const sy = height / 2;
  const sz = depth / 2;
  const coordinate = (i, j, k) => [
    -sx + (width * i) / S,
    -sy + (height * j) / S,
    -sz + (depth * k) / S,
  ];

  const vertexAt = (i, j, k) => {
    const id = key(i, j, k);
    if (index.has(id)) return index.get(id);
    const [x, y, z] = coordinate(i, j, k);
    // Outward normal of a box face: each axis scaled by 1/half-extent.
    const nx = (i === 0 ? -1 : i === S ? 1 : 0) / sx;
    const ny = (j === 0 ? -1 : j === S ? 1 : 0) / sy;
    const nz = (k === 0 ? -1 : k === S ? 1 : 0) / sz;
    const length = Math.hypot(nx, ny, nz) || 1;
    const at = positions.length / 3;
    positions.push(x, y, z);
    normals.push(nx / length, ny / length, nz / length);
    if (vertexColors) colors.push(color[0], color[1], color[2], 255);
    index.set(id, at);
    return at;
  };

  const indices = [];
  const quad = (a, b, c, d) => {
    indices.push(a, b, c, a, c, d);
  };

  for (let a = 0; a < S; a += 1) {
    for (let b = 0; b < S; b += 1) {
      // Each face is swept over its OWN two axes, so every interior edge is
      // shared by exactly two triangles and every seam edge by exactly one from
      // each side — which is what makes the measured surface watertight.
      quad(vertexAt(a, b, S), vertexAt(a + 1, b, S), vertexAt(a + 1, b + 1, S), vertexAt(a, b + 1, S)); // +z
      quad(vertexAt(a + 1, b, 0), vertexAt(a, b, 0), vertexAt(a, b + 1, 0), vertexAt(a + 1, b + 1, 0)); // −z
      quad(vertexAt(S, b, a + 1), vertexAt(S, b, a), vertexAt(S, b + 1, a), vertexAt(S, b + 1, a + 1)); // +x
      quad(vertexAt(0, b, a), vertexAt(0, b, a + 1), vertexAt(0, b + 1, a + 1), vertexAt(0, b + 1, a)); // −x
      quad(vertexAt(a, S, b), vertexAt(a + 1, S, b), vertexAt(a + 1, S, b + 1), vertexAt(a, S, b + 1)); // +y
      quad(vertexAt(a + 1, 0, b), vertexAt(a, 0, b), vertexAt(a, 0, b + 1), vertexAt(a + 1, 0, b + 1)); // −y
    }
  }

  return assembleGlb({
    positions,
    indices,
    normals: withNormals ? normals : null,
    colors: vertexColors ? colors : null,
    generator: 'flora-phase5-box-fixture',
    textureCount,
    meshCount,
    material,
  });
}

/**
 * A watertight sphere — the deliberately AMBIGUOUS case.
 *
 * Every orthographic view of a sphere is the same circle, so no view can beat
 * another and the gate must report that its view choice was an assumption
 * (`agreement: 'ambiguous'`). That is the fixture for "an uncertain alignment
 * result", and it is honest: a rotationally symmetric shape genuinely cannot be
 * oriented from a silhouette.
 */
export function buildSphereGlb({
  radius = 1,
  segments = 16,
  rings = 12,
  vertexColors = false,
  // The fixture's colour, so a test can build a GREY or NEAR-BLACK sphere and
  // assert the colour gate notices — without shipping a binary blob.
  color = [90, 140, 200],
  material = null,
} = {}) {
  const S = Math.max(3, Math.floor(segments));
  const R = Math.max(3, Math.floor(rings));
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  const vertexAt = (x, y, z) => {
    const at = positions.length / 3;
    positions.push(x * radius, y * radius, z * radius);
    normals.push(x, y, z);
    if (vertexColors) colors.push(color[0], color[1], color[2], color[3] ?? 255);
    return at;
  };

  // The pole is ONE vertex and the seam is closed by MODULO indexing rather than
  // by a duplicated meridian. Both details are what make this a closed surface:
  // a UV sphere built the naive way — every ring carrying `segments + 1` points,
  // with a triangle emitted at each pole — has a slit down one side and two
  // zero-area triangles per pole, which the gate would honestly report as holes
  // and slivers that belong to the FIXTURE, not to the shape under test.
  const top = vertexAt(0, 1, 0);
  const bottom = vertexAt(0, -1, 0);
  const rows = [];
  for (let r = 1; r <= R - 1; r += 1) {
    const phi = (r / R) * Math.PI;
    const row = [];
    for (let s = 0; s < S; s += 1) {
      const theta = (s / S) * 2 * Math.PI;
      row.push(vertexAt(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)));
    }
    rows.push(row);
  }

  for (let s = 0; s < S; s += 1) {
    indices.push(top, rows[0][s], rows[0][(s + 1) % S]);
  }
  for (let r = 0; r < rows.length - 1; r += 1) {
    for (let s = 0; s < S; s += 1) {
      const a = rows[r][s];
      const b = rows[r + 1][s];
      const c = rows[r][(s + 1) % S];
      const d = rows[r + 1][(s + 1) % S];
      indices.push(a, b, c, c, b, d);
    }
  }
  const last = rows[rows.length - 1];
  for (let s = 0; s < S; s += 1) {
    indices.push(bottom, last[(s + 1) % S], last[s]);
  }

  return assembleGlb({
    positions,
    indices,
    normals,
    colors: vertexColors ? colors : null,
    generator: 'flora-phase5-sphere-fixture',
    material,
  });
}

/** Bytes that are not a GLB at all — the "invalid model" case. */
export const NOT_A_GLB = Buffer.from('this is not a glTF Binary container, it is text', 'utf8');

/* ── reference images ────────────────────────────────────────────────────── */

/**
 * An RGBA PNG whose ALPHA channel is the product silhouette — exactly the shape
 * Phase 1's cutout has. A transparent margin is included on purpose: the gate
 * must remove irrelevant margins itself, so a fixture that had none would not
 * test that.
 */
export async function buildReferencePng({
  width = 50,
  height = 200,
  shape = 'rect',
  margin = 6,
  color = { r: 190, g: 150, b: 100 },
} = {}) {
  // `width`/`height` describe the SHAPE, and the frame is padded around it.
  // That ordering matters: a caller asking for "the 1:4 rectangle this box
  // projects" must get an object whose measured aspect is exactly 1:4, not one
  // whose ratio was quietly altered by the margin. The transparent border is
  // still there, so margin removal is exercised rather than avoided.
  const frameW = width + 2 * margin;
  const frameH = height + 2 * margin;
  const svg =
    shape === 'disc'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}">
           <circle cx="${frameW / 2}" cy="${frameH / 2}" r="${Math.min(width, height) / 2}" fill="rgb(${color.r},${color.g},${color.b})" />
         </svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}">
           <rect x="${margin}" y="${margin}" width="${width}" height="${height}" fill="rgb(${color.r},${color.g},${color.b})" />
         </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export default {
  assembleGlb,
  buildBoxGlb,
  buildSphereGlb,
  buildReferencePng,
  NOT_A_GLB,
};
