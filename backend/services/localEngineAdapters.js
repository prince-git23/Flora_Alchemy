/**
 * LOCAL RECONSTRUCTION ENGINES — the SERVER-side contract for the engines the
 * self-hosted GPU agent can run.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before multi-engine dispatch there was exactly ONE local engine: TripoSR,
 * reached through one transport (`local_gpu_agent`) and described by one
 * provider. Adding Hunyuan3D-2mv and ReLi3D cannot be done by adding two more
 * provider names, because the three engines do not agree about what an input IS:
 *
 *   · TripoSR takes ONE photograph (up to 4 candidates, one consumed);
 *   · Hunyuan3D-2mv takes NAMED views in learned slots (front/left/back/right)
 *     and must never be handed a contact sheet as if the grid were one view;
 *   · ReLi3D takes RGBA frames PLUS a recorded camera pose and FOV per frame and
 *     refuses a set without them.
 *
 * So an engine is identified by an ENGINE ID (`local_single_view`,
 * `hunyuan3d_2mv`, `reli3d`) independent of the transport that carries its work,
 * and this module is the ONE place that says what each engine requires. The
 * capture registry (`engineCapabilities.js`) already speaks these ids; it now
 * asks this module what an installed adapter actually needs.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It never runs inference, never reads a checkpoint, never stores bytes and
 * never guesses a camera pose. It validates what the server is about to hand a
 * machine, and it builds `transforms.json` from poses that were RECORDED
 * (`capturePose.js` accepts only `manual` / `imported`). A missing pose is an
 * error that names the frame; it is never completed from the image.
 *
 * EVIDENCE DISCIPLINE
 * -------------------
 * `installed: true` means the adapter code ships in this build. It does NOT mean
 * an engine has produced a real reconstruction here — `evidence` on the capture
 * registry still says `unverified` for the two new engines until a genuine
 * model has been generated, inspected and recorded. And `ready` (below) is never
 * inferred from `installed`: it comes from the GPU agent's own probe, or it is
 * false.
 */

import crypto from 'node:crypto';
import { ApiError } from '../middleware/errorMiddleware.js';
import { isCompletePose } from './capturePose.js';

/* ── identities ──────────────────────────────────────────────────────────── */

export const ENGINE_LOCAL_SINGLE_VIEW = 'local_single_view';
export const ENGINE_HUNYUAN_2MV = 'hunyuan3d_2mv';
export const ENGINE_RELI3D = 'reli3d';

/** The four named slots Hunyuan3D-2mv conditions on, in the order it expects. */
export const HUNYUAN_VIEW_SLOTS = ['front', 'left', 'back', 'right'];
/** Files ReLi3D must return, each kept as its OWN private artifact. */
export const RELI3D_ARTIFACTS = ['illumination', 'run-info'];

/**
 * A job created before engine identity existed has `engineId: ''`. It is a
 * TripoSR job — that was the only local engine — and it must keep working
 * without a migration, so the legacy empty value maps to this engine.
 */
export function engineIdForJob(job) {
  const raw = String(job?.engineId || '').trim();
  return raw || ENGINE_LOCAL_SINGLE_VIEW;
}

/**
 * Every local adapter this build ships.
 *
 * `checkpointEnv` names the environment variable an operator uses to point the
 * adapter at weights the repository does not vendor; the adapter itself reports
 * whether the path resolves. `dependencies` are the Python modules the adapter
 * imports — used by the agent's probe and by the Python contract tests, never
 * installed automatically.
 */
export const LOCAL_ENGINE_ADAPTERS = {
  triposr: {
    adapterId: 'triposr',
    engineId: ENGINE_LOCAL_SINGLE_VIEW,
    label: 'TripoSR (single photograph)',
    model: 'TripoSR',
    modelVersion: 'triposr-1.0',
    transport: 'local_gpu_agent',
    installed: true,
    legacy: true,
    inputMode: 'single_view',
    minInputs: 1,
    maxInputs: 4,
    namedViews: [],
    requiredViews: [],
    requiresPose: false,
    requiresRgba: false,
    producesArtifacts: [],
    dependencies: ['torch', 'tsr'],
    checkpointEnv: 'TRIPOSR_HOME',
    entrypoint: 'tools/3d-worker/worker.py',
    defaults: { marchingCubesResolution: 256, segmenter: 'rembg' },
    hardware: {
      minVramMb: 4096,
      shapeVramMb: 4096,
      textureVramMb: 0,
      notes: 'Measured baseline on the owner\'s RTX 4050 (6 GB): 256 marching cubes.',
    },
    evidence: 'measured',
  },

  hunyuan3d_2mv: {
    adapterId: 'hunyuan3d_2mv',
    engineId: ENGINE_HUNYUAN_2MV,
    label: 'Hunyuan3D-2mv (local, multi-view shape)',
    model: 'Hunyuan3D-2mv',
    modelVersion: '2mv',
    transport: 'local_gpu_agent',
    installed: true,
    inputMode: 'named_multi_view',
    minInputs: 2,
    maxInputs: 4,
    /** The slots the model was trained on; the server sends these names verbatim. */
    namedViews: HUNYUAN_VIEW_SLOTS,
    requiredViews: ['front', 'left', 'back'],
    optionalViews: ['right'],
    /** Named slots only. A sheet would be reconstructed as one framed photograph. */
    acceptsSheet: false,
    requiresPose: false,
    requiresRgba: false,
    producesArtifacts: [],
    dependencies: ['torch', 'hy3dgen'],
    checkpointEnv: 'HUNYUAN3D_MODEL_PATH',
    entrypoint: 'tools/3d-worker/engines/hunyuan3d.py',
    defaults: {
      octreeResolution: 256,
      numChunks: 8000,
      guidanceScale: 5.0,
      numInferenceSteps: 50,
      seed: 1234,
    },
    /** Shape and texture are separate stages; this build runs SHAPE ONLY. */
    stages: { shape: true, texture: false },
    hardware: {
      minVramMb: 6144,
      shapeVramMb: 6144,
      textureVramMb: 16384,
      notes:
        'Shape needs ~6 GB; the texture stage needs ~16 GB and is deliberately NOT part of this adapter. ' +
        'A local run in Phase D2 measured 5708 MiB peak for shape at three unposed views.',
    },
    licence: {
      name: 'Tencent Hunyuan Community Licence',
      commercialUse: 'restricted',
      territory: 'excludes the EU, United Kingdom and South Korea',
    },
    evidence: 'unverified',
  },

  reli3d: {
    adapterId: 'reli3d',
    engineId: ENGINE_RELI3D,
    label: 'ReLi3D (local, pose-required, relightable)',
    model: 'ReLi3D',
    modelVersion: 'reli3d-1.0',
    transport: 'local_gpu_agent',
    installed: true,
    inputMode: 'posed_rgba',
    minInputs: 3,
    maxInputs: 8,
    namedViews: [],
    requiredViews: [],
    optionalViews: [],
    acceptsSheet: false,
    /** Each frame needs a RECORDED camera-to-world pose and FOV. No inference. */
    requiresPose: true,
    requiresFov: true,
    acceptsUnposed: false,
    /** ReLi3D's entrypoint reads RGBA; a JPEG has no matte and is refused. */
    requiresRgba: true,
    producesArtifacts: [...RELI3D_ARTIFACTS],
    dependencies: ['torch', 'reli3d'],
    checkpointEnv: 'RELI3D_HOME',
    entrypointEnv: 'RELI3D_ENTRYPOINT',
    entrypoint: 'demos/reli3d/infer_from_transforms.py (the official release script under RELI3D_HOME)',
    defaults: {
      /** Written into transforms.json so a reviewer can see the convention. */
      cameraModel: 'OPENCV',
    },
    hardware: {
      minVramMb: 12288,
      shapeVramMb: 12288,
      textureVramMb: 0,
      /** An honest estimate, not a measurement: neither the paper, the project
       *  page nor the official release README publishes a VRAM minimum, and no
       *  machine in this deployment has run it. The figure below is what the
       *  release's architecture (DINOv2 conditioning, triplane paths, a
       *  differentiable PBR renderer) plausibly needs; verify on the target card.
       */
      notes:
        'No published VRAM figure exists; this deployment has never run ReLi3D, so nothing here is measured. ' +
        'The minimum is a PLANNING estimate only — nothing here is measured, and the official native ' +
        'extensions (uv_unwrapper, texture_baker) need a CUDA toolchain the Windows PC does not have.',
    },
    licence: {
      name: 'Stability AI model licence',
      commercialUse: 'verify before any integration',
      territory: 'per licence text',
    },
    evidence: 'unverified',
  },
};

/** Stable engine ids, in registry order. */
export const LOCAL_ENGINE_IDS = Object.values(LOCAL_ENGINE_ADAPTERS).map((adapter) => adapter.engineId);

/** Resolve an adapter by ENGINE ID or by ADAPTER ID. `null` when unknown. */
export function localEngineAdapter(engineIdOrAdapter = '') {
  const key = String(engineIdOrAdapter || '').trim().toLowerCase();
  if (!key) return LOCAL_ENGINE_ADAPTERS.triposr;
  for (const adapter of Object.values(LOCAL_ENGINE_ADAPTERS)) {
    if (adapter.engineId === key || adapter.adapterId === key) return adapter;
  }
  return null;
}

/** Resolve, or refuse with a code the studio already understands. */
export function requireLocalEngineAdapter(engineIdOrAdapter = '') {
  const adapter = localEngineAdapter(engineIdOrAdapter);
  if (!adapter) {
    throw new ApiError(
      422,
      `"${engineIdOrAdapter}" is not a reconstruction engine this build can dispatch to.`,
      'ENGINE_UNKNOWN'
    );
  }
  if (!adapter.installed) {
    throw new ApiError(
      422,
      `${adapter.label} has no local adapter in this build.`,
      'ENGINE_NOT_INSTALLED'
    );
  }
  return adapter;
}

/**
 * Map the ADAPTER ids an agent reports onto the ENGINE ids jobs are stored with.
 * An agent that declares nothing is a legacy TripoSR agent: its claims must keep
 * matching the jobs the old protocol created (`engineId: ''`).
 */
export function engineIdsForAdapters(adapterIds = []) {
  const ids = new Set();
  const declared = Array.isArray(adapterIds) ? adapterIds : [];
  for (const raw of declared) {
    const adapter = localEngineAdapter(raw);
    if (adapter) ids.add(adapter.engineId);
  }
  if (ids.size === 0) {
    // Backwards compatibility: an agent built before multi-engine support sends
    // no engine list, and it can only run TripoSR. Matching it with anything
    // else would hand it work it cannot do.
    ids.add(ENGINE_LOCAL_SINGLE_VIEW);
  }
  if (ids.has(ENGINE_LOCAL_SINGLE_VIEW)) ids.add('');
  return [...ids];
}

/** The ADAPTER ids a claim response should name, for the agent's dispatcher. */
export function adapterIdsForEngineIds(engineIds = []) {
  const out = [];
  for (const id of engineIds) {
    const adapter = localEngineAdapter(id);
    if (adapter && !out.includes(adapter.adapterId)) out.push(adapter.adapterId);
  }
  return out;
}

/** Describe the local adapters for the studio (no paths, no credentials). */
export function describeLocalEngines() {
  return Object.values(LOCAL_ENGINE_ADAPTERS).map((adapter) => ({
    id: adapter.engineId,
    adapterId: adapter.adapterId,
    label: adapter.label,
    installed: adapter.installed,
    inputMode: adapter.inputMode,
    minInputs: adapter.minInputs,
    maxInputs: adapter.maxInputs,
    requiredViews: adapter.requiredViews,
    namedViews: adapter.namedViews,
    requiresPose: adapter.requiresPose,
    requiresRgba: adapter.requiresRgba,
    producesArtifacts: adapter.producesArtifacts,
    dependencies: adapter.dependencies,
    checkpointEnv: adapter.checkpointEnv,
    defaults: adapter.defaults,
    hardware: adapter.hardware,
    evidence: adapter.evidence,
  }));
}

/* ── image facts ─────────────────────────────────────────────────────────── */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read the IHDR chunk of a PNG. A 13-byte header is enough to state colour type
 * and dimensions — the ONLY facts needed to refuse a JPEG for an engine that
 * reads alpha, or to fill transforms.json's intrinsics from the real frame size.
 *
 * Returns null for anything that is not a PNG with a readable IHDR.
 */
export function readPngHeader(buffer) {
  try {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (bytes.length < 33) return null;
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    const length = bytes.readUInt32BE(8);
    const type = bytes.toString('ascii', 12, 16);
    if (type !== 'IHDR' || length !== 13) return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const bitDepth = bytes[24];
    const colorType = bytes[25];
    if (!width || !height) return null;
    return {
      format: 'png',
      width,
      height,
      bitDepth,
      colorType,
      /** 4 = greyscale+alpha, 6 = RGBA. Only these two carry an alpha channel. */
      hasAlpha: colorType === 4 || colorType === 6,
      alphaKind: colorType === 6 ? 'rgba' : colorType === 4 ? 'ga' : 'none',
    };
  } catch {
    return null;
  }
}

/** Decode an input's bytes from `data` (base64) or `buffer`. */
export function decodeImageBytes(image) {
  if (Buffer.isBuffer(image?.buffer) && image.buffer.length) return image.buffer;
  const raw = String(image?.data || '');
  if (!raw) return null;
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Is this row a composite source sheet rather than a view?
 *
 * The server's `isSourceSheet` is the authority upstream, but validation runs on
 * the projected image payload too (a test can call it directly, and the agent
 * re-validates), so the same facts travel on every image: `sheet`, `composite`
 * and `source.type`. A sheet is NEVER a view for ANY engine.
 */
export function isSheetImage(image) {
  if (!image || typeof image !== 'object') return false;
  if (image.sheet === true || image.composite === true) return true;
  const type = String(image.source?.type || '').toLowerCase();
  return type === 'composite' || type === 'sheet' || type === 'contact-sheet';
}

/* ── camera mathematics (recorded poses only) ────────────────────────────── */

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const vec3 = (value) => (value && finite(value.x) && finite(value.y) && finite(value.z) ? value : null);

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function norm(a) {
  return Math.hypot(a.x, a.y, a.z);
}
function unit(a) {
  const length = norm(a);
  if (!length || !Number.isFinite(length)) return null;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}

/**
 * Build the camera-to-world matrix for ONE recorded pose.
 *
 * Convention: right-handed, +Y up, camera looks down its own −Z (the OpenGL /
 * `transforms.json` convention). Columns are [right, up, backward, position],
 * bottom row [0, 0, 0, 1]. The pose's own `position` and `target` are metres,
 * already validated by `capturePose.normalisePose`.
 *
 * This is CONSTRUCTION from recorded numbers, not estimation: no part of the
 * input is inferred from pixels, and a degenerate pose is refused.
 */
export function cameraToWorldMatrix(pose) {
  const position = vec3(pose?.position);
  const target = vec3(pose?.target);
  if (!position || !target) {
    throw new ApiError(422, 'A camera pose needs finite position and target vectors.', 'POSE_INCOMPLETE');
  }
  const backward = unit(subtract(position, target));
  if (!backward) {
    throw new ApiError(
      422,
      'The camera position and target are the same point, so no camera-to-world rotation exists.',
      'POSE_DEGENERATE'
    );
  }
  // Choose an up reference that is not parallel to the view direction; a
  // straight-down capture would otherwise produce a zero cross product.
  const upRef = Math.abs(dot(backward, { x: 0, y: 1, z: 0 })) > 0.999
    ? { x: 0, y: 0, z: 1 }
    : { x: 0, y: 1, z: 0 };
  const right = unit(cross(upRef, backward));
  if (!right) {
    throw new ApiError(422, 'The recorded pose has no usable orientation.', 'POSE_DEGENERATE');
  }
  const up = cross(backward, right);
  return [
    [right.x, up.x, backward.x, position.x],
    [right.y, up.y, backward.y, position.y],
    [right.z, up.z, backward.z, position.z],
    [0, 0, 0, 1],
  ];
}

/**
 * Validate a 4×4 camera-to-world matrix that CAME FROM SOMEWHERE ELSE (an
 * imported transforms.json, a future importer, a test). ReLi3D trusts this
 * matrix completely, so every property that makes it a pose is checked:
 * finite numbers, an affine bottom row, an (approximately) orthonormal
 * rotation, a right-handed basis (determinant > 0), and a plausible scale.
 */
export function validateTransformMatrix(matrix) {
  const errors = [];
  if (!Array.isArray(matrix) || matrix.length !== 4) {
    return { ok: false, errors: ['transform_matrix must be a 4×4 array.'] };
  }
  for (let row = 0; row < 4; row += 1) {
    if (!Array.isArray(matrix[row]) || matrix[row].length !== 4) {
      return { ok: false, errors: [`transform_matrix row ${row} must have 4 numbers.`] };
    }
    for (let col = 0; col < 4; col += 1) {
      if (!finite(matrix[row][col])) {
        return { ok: false, errors: [`transform_matrix[${row}][${col}] is not a finite number.`] };
      }
    }
  }
  const bottom = matrix[3];
  if (bottom[0] !== 0 || bottom[1] !== 0 || bottom[2] !== 0 || bottom[3] !== 1) {
    errors.push('transform_matrix is not affine: the bottom row must be [0, 0, 0, 1].');
  }
  const column = (index) => ({ x: matrix[0][index], y: matrix[1][index], z: matrix[2][index] });
  const right = column(0);
  const up = column(1);
  const backward = column(2);
  for (const [name, axis] of [['x', right], ['y', up], ['z', backward]]) {
    const length = norm(axis);
    if (Math.abs(length - 1) > 1e-3) {
      errors.push(`transform_matrix column ${name} has length ${length.toFixed(4)}; a rotation column must be unit length.`);
    }
  }
  if (Math.abs(dot(right, up)) > 1e-3 || Math.abs(dot(right, backward)) > 1e-3 || Math.abs(dot(up, backward)) > 1e-3) {
    errors.push('transform_matrix columns are not orthogonal.');
  }
  const determinant = dot(cross(right, up), backward);
  if (!(determinant > 0)) {
    errors.push('transform_matrix is left-handed (determinant ≤ 0), so it is not a camera frame here.');
  }
  const position = { x: matrix[0][3], y: matrix[1][3], z: matrix[2][3] };
  if (Math.abs(position.x) > 1000 || Math.abs(position.y) > 1000 || Math.abs(position.z) > 1000) {
    errors.push('transform_matrix translation is outside the metre-scale bounds for a product capture.');
  }
  return { ok: errors.length === 0, errors, determinant, position };
}

/* ── transforms.json (ReLi3D input) ──────────────────────────────────────── */

/**
 * Build `transforms.json` from frames that ALREADY carry recorded poses.
 *
 * Every frame must have an RGBA PNG with a readable header, a complete pose and
 * a finite FOV. One missing pose refuses the WHOLE export: a file with some
 * frames posed and others silently filled in is exactly the lie this module
 * exists to prevent.
 *
 * `file_path` is the frame's own storage filename as the agent will lay it out,
 * never an absolute path from this server.
 */
export function buildTransformsJson({ frames = [], cameraModel = 'OPENCV' } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new ApiError(422, 'transforms.json needs at least one frame.', 'RELI3D_NO_FRAMES');
  }
  const prepared = [];
  const errors = [];

  for (const [index, frame] of frames.entries()) {
    const label = frame?.viewAngle || frame?.label || `frame ${index + 1}`;
    if (isSheetImage(frame)) {
      errors.push(`"${label}" is a composite sheet, not a captured frame.`);
      continue;
    }
    if (!isCompletePose(frame?.pose)) {
      errors.push(`"${label}" has no complete recorded pose (position, target, FOV, source).`);
      continue;
    }
    const fov = Number(frame.pose.fov);
    if (!Number.isFinite(fov) || fov < 5 || fov > 120) {
      errors.push(`"${label}" has FOV ${frame?.pose?.fov}; a calibrated pose needs 5–120°.`);
      continue;
    }
    const bytes = decodeImageBytes(frame);
    const header = bytes ? readPngHeader(bytes) : null;
    if (!header) {
      errors.push(`"${label}" is not a readable PNG frame; ReLi3D consumes RGBA PNG frames.`);
      continue;
    }
    if (!header.hasAlpha) {
      errors.push(`"${label}" is a PNG with no alpha channel (colour type ${header.colorType}); an RGBA frame is required.`);
      continue;
    }
    const matrix = cameraToWorldMatrix(frame.pose);
    const check = validateTransformMatrix(matrix);
    if (!check.ok) {
      errors.push(`"${label}" produced an invalid transform: ${check.errors.join(' ')}`);
      continue;
    }
    const aspect = header.width / header.height;
    prepared.push({
      // The OFFICIAL ReLi3D loader (demos/reli3d/infer_from_transforms.py) reads:
    // file_path relative to the object directory, camera_fov in RADIANS, frames
    // sorted by view_index, and a pixel-centre principal point by default — so
    // this export speaks that dialect natively instead of hoping it interpolates.
    file_path: `rgba/${String(index).padStart(4, '0')}.png`,
      transform_matrix: matrix,
      camera_fov: (fov * Math.PI) / 180,
      view_index: index,
      camera_principal_point: [header.width / 2, header.height / 2],
      // Intrinsics are DERIVED from the recorded FOV and the frame's real pixel
      // size — the same two facts NeRF-style loaders expect, stated explicitly.
      fl_x: 0.5 * header.width / Math.tan((fov * Math.PI) / 360),
      fl_y: 0.5 * header.height / Math.tan((fov * Math.PI) / 360),
      cx: header.width / 2,
      cy: header.height / 2,
      w: header.width,
      h: header.height,
      aspect_ratio: Number(aspect.toFixed(6)),
      // Provenance travels WITH the file: which reference produced this frame,
      // which bytes it was, how the pose came to exist, and the view label.
      referenceId: String(frame.id || ''),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      view: String(frame.viewAngle || ''),
      pose_source: String(frame.pose.source || ''),
    });
  }

  if (errors.length) {
    throw new ApiError(
      422,
      `transforms.json was refused: ${errors.join(' ')}`,
      'RELI3D_TRANSFORMS_INVALID',
      { issues: errors }
    );
  }

  const first = prepared[0];
  return {
    camera_model: String(cameraModel || 'OPENCV'),
    // Mixed intrinsics are stated as per-frame values; the top-level pair is the
    // first frame's, which is what loaders read when they ignore per-frame keys.
    fl_x: first.fl_x,
    fl_y: first.fl_y,
    cx: first.cx,
    cy: first.cy,
    w: first.w,
    h: first.h,
    frames: prepared,
    // This file is GENERATED from recorded poses; it is not a capture device's
    // output, and saying so prevents anyone reading it as calibration evidence.
    provenance: {
      generator: 'flora-alchemy/local-engine-adapters',
      poseSources: [...new Set(prepared.map((frame) => frame.pose_source))],
      frameCount: prepared.length,
      inferredPoses: 0,
      cameraFovUnit: 'radians',
      fileLayout: 'official-object-dir',
      generatedAt: new Date().toISOString(),
    },
  };
}

/* ── input validation per engine ─────────────────────────────────────────── */

const ORDER = { front: 0, back: 1, left: 2, right: 3 };

function orderedBySlot(images, slots) {
  return [...images].sort((a, b) => {
    const sa = slots.indexOf(String(a.viewAngle || a.slot || ''));
    const sb = slots.indexOf(String(b.viewAngle || b.slot || ''));
    return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb);
  });
}

/**
 * Validate the exact inputs one engine would receive.
 *
 * Returns `{ ok, errors, inputs }` — never throws for a bad SET (a refusal is a
 * normal outcome the studio renders), but a malformed adapter id is an error.
 * Every engine is validated independently, so a set can be valid for Hunyuan
 * and invalid for ReLi3D, which is the whole point of per-engine contracts.
 */
export function validateEngineInputs({ engineId, images = [], job = null } = {}) {
  const adapter = requireLocalEngineAdapter(engineId || job?.engineId || '');
  const list = (Array.isArray(images) ? images : []).filter(Boolean);
  const errors = [];

  if (list.length < adapter.minInputs) {
    errors.push({
      code: 'ENGINE_TOO_FEW_INPUTS',
      message: `${adapter.label} needs at least ${adapter.minInputs} image${adapter.minInputs === 1 ? '' : 's'}; this job has ${list.length}.`,
    });
  }
  for (const image of list) {
    if (isSheetImage(image)) {
      errors.push({
        code: 'SHEET_NOT_A_VIEW',
        message: `"${image.label || image.viewAngle || image.id || 'A reference'}" is a composite sheet. It is provenance, never a view, and no engine may receive it as one.`,
        referenceId: String(image.id || ''),
      });
    }
  }

  let selected = list.filter((image) => !isSheetImage(image));

  if (adapter.inputMode === 'single_view') {
    selected = selected.slice(0, adapter.maxInputs);
    return finish(adapter, errors, selected);
  }

  if (adapter.inputMode === 'named_multi_view') {
    const slots = adapter.namedViews;
    const bySlot = new Map();
    for (const image of selected) {
      const slot = String(image.viewAngle || image.slot || '').toLowerCase();
      if (!slots.includes(slot)) {
        errors.push({
          code: 'VIEW_UNKNOWN_FOR_ENGINE',
          message: `${adapter.label} conditions on named views (${slots.join(', ')}); "${slot || 'unlabelled'}" is not one of them.`,
          referenceId: String(image.id || ''),
        });
        continue;
      }
      if (bySlot.has(slot)) {
        errors.push({
          code: 'NAMED_VIEW_DUPLICATE',
          message: `Two references are labelled "${slot}". ${adapter.label} takes ONE image per named slot, so this set is ambiguous. Remove or relabel one.`,
          referenceId: String(image.id || ''),
        });
        continue;
      }
      bySlot.set(slot, image);
    }
    for (const slot of adapter.requiredViews) {
      if (!bySlot.has(slot)) {
        errors.push({
          code: 'NAMED_VIEW_MISSING',
          message: `${adapter.label} requires a "${slot}" view and this job has none.`,
          view: slot,
        });
      }
    }
    // Optional slots may be absent; present ones are sent in the model's order.
    const chosen = orderedBySlot([...bySlot.values()], slots);
    if (chosen.length > adapter.maxInputs) {
      errors.push({
        code: 'ENGINE_TOO_MANY_INPUTS',
        message: `${adapter.label} takes at most ${adapter.maxInputs} named views; ${chosen.length} would be sent.`,
      });
    }
    return finish(
      adapter,
      errors,
      chosen.map((image) => ({ ...image, slot: String(image.viewAngle || '').toLowerCase() }))
    );
  }

  if (adapter.inputMode === 'posed_rgba') {
    if (selected.length > adapter.maxInputs) {
      errors.push({
        code: 'ENGINE_TOO_MANY_INPUTS',
        message: `${adapter.label} takes at most ${adapter.maxInputs} frames; this job has ${selected.length}.`,
      });
    }
    const frames = [];
    for (const image of selected) {
      const label = image.label || image.viewAngle || image.id || 'frame';
      if (!isCompletePose(image.pose)) {
        errors.push({
          code: 'POSE_REQUIRED',
          message: `"${label}" has no complete recorded camera pose and FOV. ${adapter.label} refuses unposed frames, and a pose is never inferred here.`,
          referenceId: String(image.id || ''),
        });
        continue;
      }
      const bytes = decodeImageBytes(image);
      const header = bytes ? readPngHeader(bytes) : null;
      if (!header) {
        errors.push({
          code: 'RGBA_REQUIRED',
          message: `"${label}" is not a readable PNG; ${adapter.label} consumes RGBA PNG frames.`,
          referenceId: String(image.id || ''),
        });
        continue;
      }
      if (!header.hasAlpha) {
        errors.push({
          code: 'RGBA_REQUIRED',
          message: `"${label}" is a PNG with no alpha channel (colour type ${header.colorType}); ${adapter.label} consumes RGBA frames.`,
          referenceId: String(image.id || ''),
        });
        continue;
      }
      frames.push({
        ...image,
        frame: {
          width: header.width,
          height: header.height,
          colorType: header.colorType,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      });
    }
    // The transforms file is built HERE, so a set that cannot produce one is
    // refused with the reason rather than handed to a machine to guess with.
    let transforms = null;
    if (!errors.length && frames.length) {
      try {
        transforms = buildTransformsJson({ frames, cameraModel: adapter.defaults?.cameraModel });
      } catch (err) {
        errors.push({ code: err?.code || 'RELI3D_TRANSFORMS_INVALID', message: err?.message || String(err) });
      }
    }
    return { ...finish(adapter, errors, frames), transformsJson: transforms };
  }

  errors.push({
    code: 'ENGINE_CONTRACT_UNKNOWN',
    message: `The adapter for ${adapter.label} declares an input mode this server cannot validate.`,
  });
  return finish(adapter, errors, []);
}

function finish(adapter, errors, inputs) {
  return {
    ok: errors.length === 0,
    engineId: adapter.engineId,
    adapterId: adapter.adapterId,
    inputMode: adapter.inputMode,
    errors,
    inputs,
    inputCount: inputs.length,
    requiresArtifacts: adapter.producesArtifacts,
  };
}

/**
 * Which artifacts an engine must deliver alongside its GLB. A job for any other
 * engine refusing these is deliberate: an unexplained HDR on a TripoSR asset
 * would imply a relighting capability that engine does not have.
 */
export function artifactKindsForEngine(engineId) {
  return [...(localEngineAdapter(engineId)?.producesArtifacts || [])];
}

/** True when this engine id is one the deployment may dispatch to. */
export function isInstalledEngine(engineId) {
  return Boolean(localEngineAdapter(engineId)?.installed);
}

/**
 * Read engine readiness out of one agent heartbeat.
 *
 * `reported` is deliberately separate from `ready`: an engine the agent has not
 * mentioned is NOT ready (we cannot claim otherwise), but it is also not the
 * same as an engine that reported a failed probe. Both refuse work; only one is
 * a configuration problem the operator can fix.
 */
export function engineReadinessFromSnapshot(snapshot = null) {
  const readiness = {};
  for (const adapter of Object.values(LOCAL_ENGINE_ADAPTERS)) {
    readiness[adapter.engineId] = {
      engineId: adapter.engineId,
      adapterId: adapter.adapterId,
      installed: adapter.installed,
      reported: false,
      ready: false,
      detail: snapshot
        ? `The GPU agent has not reported ${adapter.label} on this machine.`
        : `No GPU agent has checked in, so ${adapter.label} cannot be confirmed ready.`,
    };
  }
  const reported = Array.isArray(snapshot?.engines) ? snapshot.engines : [];
  // BACKWARDS COMPATIBILITY — an agent built before multi-engine support sends no
  // engine probes at all, but it has always run TripoSR and reports its model
  // loaded. Treating it as unreported would disable every engine for every such
  // machine, breaking the path this change must preserve. This says exactly what
  // is known, and nothing about engines it never mentioned.
  if (snapshot && reported.length === 0 && snapshot.modelLoaded) {
    readiness[ENGINE_LOCAL_SINGLE_VIEW] = {
      engineId: ENGINE_LOCAL_SINGLE_VIEW,
      adapterId: 'triposr',
      installed: true,
      reported: false,
      ready: true,
      detail: 'The agent is online and reports its TripoSR model loaded (it does not report per-engine probes yet).',
    };
  }
  for (const entry of reported) {
    const adapter = localEngineAdapter(entry?.id || entry?.adapter || entry?.adapterId || '');
    if (!adapter) continue;
    readiness[adapter.engineId] = {
      engineId: adapter.engineId,
      adapterId: adapter.adapterId,
      installed: adapter.installed,
      reported: true,
      ready: entry.ready === true,
      detail: String(entry.detail || ''),
      device: String(entry.device || ''),
      checkpoint: String(entry.checkpoint || ''),
      vramPeakMb: Number(entry.vramPeakMb) || 0,
      installedDependencies: Array.isArray(entry.dependencies) ? entry.dependencies.slice(0, 12).map(String) : [],
      cuda: entry.cuda === true,
    };
  }
  return readiness;
}

/** Readiness for the deployment's CURRENT agent, from the database. */
export async function localEngineReadiness() {
  const { latestAgentSnapshot } = await import('../models/GpuAgent.js');
  const snapshot = await latestAgentSnapshot().catch(() => null);
  return {
    snapshot,
    engines: engineReadinessFromSnapshot(snapshot),
  };
}

/**
 * The agent's declared engines are a CLAIM, not an authority: this server only
 * hands over jobs for adapters that exist here, whatever the machine says.
 */
export function normaliseClaimEngines(declared = []) {
  const adapterIds = (Array.isArray(declared) ? declared : [])
    .map((entry) => localEngineAdapter(entry)?.adapterId)
    .filter(Boolean);
  return [...new Set(adapterIds)];
}

export default {
  ENGINE_LOCAL_SINGLE_VIEW,
  ENGINE_HUNYUAN_2MV,
  ENGINE_RELI3D,
  HUNYUAN_VIEW_SLOTS,
  RELI3D_ARTIFACTS,
  LOCAL_ENGINE_ADAPTERS,
  LOCAL_ENGINE_IDS,
  engineIdForJob,
  localEngineAdapter,
  requireLocalEngineAdapter,
  engineIdsForAdapters,
  adapterIdsForEngineIds,
  describeLocalEngines,
  readPngHeader,
  decodeImageBytes,
  isSheetImage,
  cameraToWorldMatrix,
  validateTransformMatrix,
  buildTransformsJson,
  validateEngineInputs,
  artifactKindsForEngine,
  isInstalledEngine,
  engineReadinessFromSnapshot,
  localEngineReadiness,
  normaliseClaimEngines,
};
