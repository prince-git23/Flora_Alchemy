/**
 * E2E fixtures — real image bytes, generated in-process.
 *
 * WHY NOT A COMMITTED IMAGE FILE
 * ------------------------------
 * The studio specs need an image the SERVER will genuinely decode and segment.
 * A hand-rolled PNG encoder (node:zlib + CRC32, no dependencies) keeps the
 * bytes honest and reviewable instead of hiding a binary blob in the repo: the
 * picture is described by code, so what the background-removal engine is asked
 * to do is visible in the diff.
 *
 * `makeProductPng()` draws the same kind of photograph the studio is built for
 * — one compact subject (a bloom on a stem) on a plain, light, neutral
 * backdrop — which is the case the built-in deterministic engine handles
 * without a machine-learning model, so the spec can assert a genuinely
 * transparent result rather than merely "something happened".
 */

import zlib from 'node:zlib';

/* PNG colour type 2 (truecolour RGB), 8 bits per channel. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Encode RGB pixel rows (each `width * 3` bytes, row-filter byte 0) as a PNG. */
export function encodePng(width, height, drawPixel) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = drawPixel(x, y);
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A product photograph: a bloom (with two side petals) on a stem, on a plain
 * warm-white backdrop with a soft shadow. ~24 % of the frame is subject, which
 * is the coverage the engine scores as plausible.
 */
export function makeProductPng({ width = 640, height = 640 } = {}) {
  const cx = width / 2;
  const cy = height * 0.4;
  const bloom = width * 0.2;
  const stemTop = cy + bloom * 0.85;
  const stemWidth = Math.max(4, width * 0.022);
  const petalOffset = bloom * 0.95;

  return encodePng(width, height, (x, y) => {
    const inCircle = (px, py, r) => (x - px) ** 2 + (y - py) ** 2 <= r * r;

    // Stem first (the bloom paints over it).
    if (
      y >= stemTop &&
      y <= height * 0.86 &&
      Math.abs(x - cx) <= stemWidth
    ) {
      return [76, 122, 74];
    }
    // Soft contact shadow beneath the stem.
    if (y > height * 0.86 && inCircle(cx, height * 0.87, bloom * 0.7)) {
      return [214, 210, 203];
    }
    if (inCircle(cx, cy, bloom)) return [194, 86, 106];
    if (inCircle(cx - petalOffset, cy - bloom * 0.18, bloom * 0.58)) return [217, 123, 140];
    if (inCircle(cx + petalOffset, cy - bloom * 0.18, bloom * 0.58)) return [168, 68, 90];
    return [239, 236, 231]; // plain studio backdrop
  });
}

/**
 * A COMPOSITE sheet: `columns × rows` cells of a bloom, separated by uniform
 * gutters and framed by a uniform margin.
 *
 * This is the multi-view input the studio is built for. The gutters are a few
 * pixels wide and perfectly flat, which is exactly what the detector's seam test
 * looks for — and what the panel crop must remove WITHOUT touching a cell.
 *
 * The subject is inset well inside each cell, so a crop that crossed a separator
 * (or a crop that used the wrong cell size) visibly clips it. The spec reads the
 * panel back and asserts the product survived, which is the property the removed
 * cutout feature violated.
 */
export function makeCompositeSheetPng({ columns = 3, rows = 2, cell = 180, gutter = 10, margin = 12 } = {}) {
  const width = margin * 2 + columns * cell + (columns - 1) * gutter;
  const height = margin * 2 + rows * cell + (rows - 1) * gutter;
  return encodePng(width, height, (x, y) => {
    const inMarginX = x < margin || x >= width - margin;
    const inMarginY = y < margin || y >= height - margin;
    if (inMarginX || inMarginY) return [255, 255, 255];
    const relX = x - margin;
    const relY = y - margin;
    const column = Math.floor(relX / (cell + gutter));
    const row = Math.floor(relY / (cell + gutter));
    // The gutter itself (and the gap after the last cell).
    if (relX - column * (cell + gutter) >= cell || relY - row * (cell + gutter) >= cell) {
      return [255, 255, 255];
    }
    const localX = relX - column * (cell + gutter);
    const localY = relY - row * (cell + gutter);
    // A bloom inside the cell, with a comfortable margin so a mis-crop shows.
    const cx = cell / 2;
    const cy = cell / 2;
    const radius = cell * 0.28;
    const palette = [
      [194, 86, 106],
      [76, 122, 74],
      [127, 168, 216],
      [217, 164, 65],
      [150, 71, 53],
      [138, 111, 176],
    ];
    const colour = palette[(row * columns + column) % palette.length];
    if ((localX - cx) ** 2 + (localY - cy) ** 2 <= radius * radius) return colour;
    return [246, 243, 239];
  });
}

/** Bytes that claim to be a PNG and are not: the studio must reject them. */
export const BROKEN_PNG = Buffer.from('this is definitely not an image, it only claims to be one');

/* ─────────────────────────────────────────────────────────────────────────
   3D STUDIO (Phase 3) — a real glTF Binary container, built in-process.

   Same reasoning as `makeProductPng` above: the storefront's 3D journey needs
   bytes the BROWSER will genuinely parse and draw, and a committed `.glb` would
   hide what is being tested inside an opaque blob. So the model is described by
   code: a real 12-byte header, a real JSON chunk (padded to 4 bytes with
   spaces, as the spec requires), and a real BIN chunk holding ONE triangle.

   It is a FIXTURE, not a generated product model: it exists so the viewer, the
   public delivery route and the approval gate can be exercised end to end. The
   spec that uses it says so out loud.
   ───────────────────────────────────────────────────────────────────────── */
const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'
const GLB_CHUNK_BIN = 0x004e4942; // 'BIN\0'

/**
 * Build a minimal but COMPLETE glTF 2.0 binary: one triangle, one material.
 * Every field GLTFLoader relies on (accessors, bufferViews, buffers, scene,
 * node, mesh) is declared, so the file renders instead of merely parsing.
 */
export function makeGlb() {
  const gltf = {
    asset: { version: '2.0', generator: 'flora-alchemy-e2e-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'E2E Fixture Triangle' }],
    meshes: [{ name: 'E2E Fixture Mesh', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'E2E Fixture Material', pbrMetallicRoughness: { baseColorFactor: [0.76, 0.34, 0.42, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    buffers: [{ byteLength: 36 }],
  };

  let jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  if (pad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]);

  // Three vertices (a right triangle in the XY plane), 36 bytes of float32.
  const binBytes = Buffer.alloc(36);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => binBytes.writeFloatLE(value, index * 4));

  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(GLB_CHUNK_JSON, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBytes.length, 0);
  binHeader.writeUInt32LE(GLB_CHUNK_BIN, 4);

  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes]);
}

/**
 * The products the studio spec CREATES through the real create-product form.
 *
 * They are named HERE rather than in the spec because `e2e/stack.mjs` has to
 * remove them at boot: the database outlives a run, so without that reset a
 * second run meets its own product and fails on the duplicate-name rule instead
 * of on the behaviour under test (which is exactly how the first pass of this
 * spec failed). One constant with two consumers — the spec and the reset — so
 * the two can never drift apart.
 */
/**
 * PHASE 6 — the quality-gate REVIEW fixtures, shared by the stack that
 * provisions them and the spec that drives them.
 *
 * They live HERE, not in `stack.mjs`, because importing `stack.mjs` EXECUTES it:
 * a spec that imported the map from there booted a second whole stack inside the
 * test worker, which found port 4000 already in use and reported a confusing
 * failure that had nothing to do with any test. A shared constant belongs in a
 * module that defines things and does nothing.
 *
 * Every one of these is a DETERMINISTIC FIXTURE (`backend/scripts/lib/meshFixtures.mjs`),
 * never an AI-generated model, and each `decision` is asserted by the stack at
 * boot so a drifted fixture fails loudly instead of leaving a spec vacuous.
 */
/**
 * PHASE 11 — the product the browser suite builds a REAL capture set on.
 *
 * It is deliberately a catalogue product that has NO 3D candidate anywhere: the
 * capture spec labels its references and records a pose on one of them, and a
 * fingerprinted quality report that included those references would go STALE the
 * moment the spec ran — taking an unrelated spec's PASS down with it. A product
 * with no candidate cannot be disturbed by anything this spec writes.
 *
 * The four views are the BASE REQUIRED cover (front/left/right/back), so a set
 * built from them is a COMPLETE capture, while a single-image engine still
 * receives only one of them.
 */
export const CAPTURE_FIXTURE = {
  productSlug: 'vintage-peony-eucalyptus-posy',
  views: ['front', 'back', 'left', 'right'],
};

export const QUALITY_FIXTURES = {
  /** A box whose projection matches its reference: eligible for normal approval. */
  pass: { productSlug: 'botanical-wax-seal-kit', decision: 'PASS' },
  /** A sphere against a disc: the view is always a guess, so a human must look. */
  review: { productSlug: 'chenille-garden-mascot-charm', decision: 'REVIEW' },
  /** A wide band against a tall rectangle: a severe mismatch. */
  blocked: { productSlug: 'gold-foil-pressed-stickers', decision: 'BLOCKED' },
  /** Measured, then the GENERATION SETTINGS changed — so the report is stale. */
  stale: { productSlug: 'desk-bloom-ceramic-pot', decision: 'PASS', stale: true },
  /** The stored model file is genuinely gone, so the assessment cannot run. */
  failed: { productSlug: 'rakhi-everlasting-bloom-set', decision: 'REVIEW', assessmentFailed: true },
  /** A candidate for the product that ALREADY has an approved model
   *  (`stack.mjs` publishes the approved fixture for this same slug). */
  replacement: { productSlug: 'dusty-rose-lavender-posy', decision: 'REVIEW' },
};

/**
 * PHASE 6 — a CANARY credential for the "no secret reaches the browser" check.
 *
 * The stack hands this exact value to the backend as a configured provider key,
 * and the studio-payload check asserts the value never appears in a response.
 * Asserting the absence of a VALUE is what makes that check real. Asserting the
 * absence of the NAME `MESHY_API_KEY` would fail on the provider's own setup hint
 * ("…set THREE_D_PROVIDER=meshy and MESHY_API_KEY"), which is an instruction an
 * administrator is meant to read, not a credential — the first version of this
 * check did exactly that and reported a leak that did not exist.
 */
export const PROVIDER_SECRET_CANARY = 'e2e-canary-provider-key-000000000000';

export const STUDIO_PRODUCT_NAMES = {
  prepared: 'E2E Studio Verification Posy',
  brokenUpload: 'E2E Studio Broken Upload Posy',
};
