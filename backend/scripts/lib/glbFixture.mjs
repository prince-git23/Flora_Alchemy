/**
 * SHARED 3D TEST FIXTURES — a real glTF Binary container, built byte by byte.
 *
 * Used by the Phase 2 suite (`3d-studio-smoke.mjs`), which needs to mutate every
 * field the validator inspects, and by the Phase 4 provider-contract suite
 * (`3d-worker-provider-smoke.mjs`), which needs a valid model for a stand-in
 * worker to "produce". It lives here so the two suites cannot drift into
 * disagreeing about what a valid GLB is.
 *
 * NOTHING HERE IS A GENERATED MODEL. These bytes are a container with one
 * triangle: they exist to exercise validation, storage and delivery, and no
 * suite that uses them may claim an AI provider produced them.
 */

export const GLB_MAGIC = 0x46546c67;
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;

/**
 * Build a genuine GLB. Every knob the validator inspects is exposed so rejection
 * cases are real mutations of a real file rather than invented inputs.
 */
export function buildGlb({
  meshes = 1,
  textureCount = 1,
  version = 2,
  magic = GLB_MAGIC,
  declaredLength = null,
  jsonChunkType = CHUNK_JSON,
  jsonText = null,
  withBin = true,
} = {}) {
  const gltf = jsonText ?? JSON.stringify({
    asset: { version: '2.0', generator: 'flora-3d-studio-smoke' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: Array.from({ length: meshes }, () => ({ primitives: [{ attributes: { POSITION: 0 } }] })),
    materials: [{ name: 'petal' }],
    textures: Array.from({ length: textureCount }, (_, i) => ({ source: i })),
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  });

  let jsonBytes = Buffer.from(gltf, 'utf8');
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]);

  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => bin.writeFloatLE(value, index * 4));
  const binBytes = withBin ? bin : Buffer.alloc(0);

  const total = 12 + 8 + jsonBytes.length + (withBin ? 8 + binBytes.length : 0);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(declaredLength ?? total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(jsonChunkType, 4);

  const parts = [header, jsonHeader, jsonBytes];
  if (withBin) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binBytes.length, 0);
    binHeader.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binHeader, binBytes);
  }
  return Buffer.concat(parts);
}

/** A real, opaque 1×1 PNG — used where only "real file bytes" matter. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * The E2E stack's own fixture model is built in `frontend/e2e/support/fixtures.js`
 * (`makeGlb`), and the frontend renderer fixtures are in-process there. Nothing
 * imports a second triangle factory, so none lives here: this module exists only
 * so the two backend suites share ONE definition of "a valid GLB".
 */
export default { GLB_MAGIC, CHUNK_JSON, CHUNK_BIN, buildGlb, PNG_1X1 };
