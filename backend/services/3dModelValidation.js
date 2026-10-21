/**
 * 3D MODEL VALIDATION — 3D Studio (Phase 2).
 *
 * An asset may only be previewed or approved if its bytes are genuinely a glTF
 * Binary container. This module establishes that from the BYTES, never from a
 * filename, a content-type header, or a provider's word for it.
 *
 * What is checked, in order:
 *
 *   1. the file is at least a full 12-byte GLB header;
 *   2. the magic is `glTF` (0x46546C67) — not a ZIP, a PNG, or a truncated blob;
 *   3. the container version is 2 (the only version three.js loads as .glb);
 *   4. the declared total length equals the actual byte length, which catches
 *      the very common "downloaded a redirect page / an error page" failure;
 *   5. the first chunk is well-formed JSON (`JSON` = 0x4E4F534A), and it parses;
 *   6. the JSON declares at least one mesh — a valid but empty scene is not a
 *      model, and approving one would put an invisible product in front of a
 *      customer.
 *
 * The result is deliberately verbose: the studio shows what was found, so a
 * failure reads as a reason rather than as "invalid file".
 */

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const HEADER_BYTES = 12;

/** Guard rail: a legitimate product GLB is far under this. */
export const MAX_GLB_BYTES = 32 * 1024 * 1024;
// 32 MiB is the ONE size ceiling across the whole pipeline (agent upload,
// raw-body limit, validation, public delivery, worker.py mirror). It sits
// comfortably under Supabase Free's documented 50 MB per-file upload limit
// (50,000,000 bytes < 33,554,432) and is ~69x the largest real TripoSR
// artifact observed on the RTX 4050 (~485 KB at marching-cubes 256).

function fail(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    magic: '',
    gltfVersion: 0,
    declaredBytes: 0,
    meshes: 0,
    materials: 0,
    textures: 0,
    ...extra,
  };
}

/**
 * Validate a GLB buffer. Never throws: an invalid model is an expected outcome
 * that has to be recorded on the asset, not an exception that aborts a job.
 */
export function validateGlb(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return fail('GLB_EMPTY', 'The provider returned no bytes to validate.');
  }
  if (buffer.length > MAX_GLB_BYTES) {
    return fail(
      'GLB_TOO_LARGE',
      `The model is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, above the ${MAX_GLB_BYTES / 1024 / 1024} MB ceiling.`
    );
  }
  if (buffer.length < HEADER_BYTES) {
    return fail('GLB_TRUNCATED', `Only ${buffer.length} bytes arrived; a GLB header alone is 12.`);
  }

  const magic = buffer.readUInt32LE(0);
  if (magic !== GLB_MAGIC) {
    return fail(
      'GLB_BAD_MAGIC',
      `The bytes are not a glTF Binary container (magic 0x${magic.toString(16)}, expected 0x${GLB_MAGIC.toString(16)}).`
    );
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 2) {
    return fail('GLB_BAD_VERSION', `The container is glTF version ${version}; only version 2 is supported.`, {
      magic: 'glTF',
      gltfVersion: version,
    });
  }

  const declared = buffer.readUInt32LE(8);
  if (declared !== buffer.length) {
    return fail(
      'GLB_LENGTH_MISMATCH',
      `The container declares ${declared} bytes but ${buffer.length} arrived — the download is incomplete or is not a model at all.`,
      { magic: 'glTF', gltfVersion: version, declaredBytes: declared }
    );
  }

  // First chunk header: length + type, immediately after the 12-byte header.
  if (buffer.length < HEADER_BYTES + 8) {
    return fail('GLB_TRUNCATED', 'The container ends before its first chunk.', {
      magic: 'glTF',
      gltfVersion: version,
      declaredBytes: declared,
    });
  }
  const chunkLength = buffer.readUInt32LE(HEADER_BYTES);
  const chunkType = buffer.readUInt32LE(HEADER_BYTES + 4);
  if (chunkType !== CHUNK_JSON) {
    return fail('GLB_NO_JSON_CHUNK', 'The first chunk is not the required glTF JSON chunk.', {
      magic: 'glTF',
      gltfVersion: version,
      declaredBytes: declared,
    });
  }

  const jsonStart = HEADER_BYTES + 8;
  const jsonEnd = jsonStart + chunkLength;
  if (chunkLength <= 0 || jsonEnd > buffer.length) {
    return fail('GLB_BAD_JSON_CHUNK', 'The declared JSON chunk runs past the end of the file.', {
      magic: 'glTF',
      gltfVersion: version,
      declaredBytes: declared,
    });
  }

  let gltf = null;
  try {
    gltf = JSON.parse(buffer.subarray(jsonStart, jsonEnd).toString('utf8'));
  } catch {
    return fail('GLB_BAD_JSON', 'The glTF JSON chunk could not be parsed.', {
      magic: 'glTF',
      gltfVersion: version,
      declaredBytes: declared,
    });
  }

  const meshes = Array.isArray(gltf?.meshes) ? gltf.meshes.length : 0;
  const materials = Array.isArray(gltf?.materials) ? gltf.materials.length : 0;
  const textures = Array.isArray(gltf?.textures) ? gltf.textures.length : 0;

  if (meshes === 0) {
    return fail('GLB_NO_MESHES', 'The file is a valid glTF container but contains no meshes.', {
      magic: 'glTF',
      gltfVersion: version,
      declaredBytes: declared,
      materials,
      textures,
    });
  }

  return {
    ok: true,
    code: '',
    message: '',
    magic: 'glTF',
    gltfVersion: version,
    declaredBytes: declared,
    meshes,
    materials,
    textures,
  };
}

export default { validateGlb, MAX_GLB_BYTES };
