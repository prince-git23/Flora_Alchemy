/**
 * 3D ASSET STORAGE — 3D Studio (Phase 2) — the PRIVATE media root for GLB files.
 *
 * The rules here mirror the Phase 1 reference-media contract, and they are the
 * reason 3D media never reaches a customer through a public path:
 *
 *   · assets live under their own root (`backend/uploads/3d-media` by default,
 *     overridable with THREE_MEDIA_ROOT) — never under a served public folder,
 *     never the credential-bearing image CDN;
 *   · the ONLY reader is the authenticated `/api/3d/media/...` route, which
 *     re-derives the workspace from the session;
 *   · a storage key is a path RELATIVE to the root, and every read resolves it
 *     back inside the root and refuses anything that escapes (a `..` in a key
 *     must not become a directory traversal);
 *   · a write never silently replaces existing bytes — the caller must ask for
 *     it, which is what keeps a candidate's GLB immutable once validated.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BACKEND_DIR,
  assertWritableDir,
  describeRoot,
  isDurableRoot,
  toStorageError,
} from './privateMediaRoot.js';
import {
  assertDurableWriteAllowed,
  deletePrefix,
  getObject,
  headObject,
  objectStoreStatus,
  putObject,
  storageDriver,
  usingObjectStorage,
} from './privateObjectStorage.js';

export const ASSET_KINDS = ['glb', 'thumbnail'];

/**
 * The private 3D media root.
 *
 * Resolution order, documented so it cannot drift again:
 *   1. `THREE_MEDIA_ROOT` — an absolute path (production: the mounted disk);
 *   2. `UPLOAD_DIR` + `/3d-media` — operators who relocate all uploads;
 *   3. `<backend>/uploads/3d-media` — DEVELOPMENT fallback.
 *
 * It used to be `path.resolve(process.env.UPLOAD_DIR || 'backend/uploads', '3d-media')`,
 * i.e. relative to the process CWD. `render.yaml` starts the API with
 * `cd backend && node server.js`, so that resolved to
 * `backend/backend/uploads/3d-media` — a path no document mentioned, no
 * `.gitignore` rule covered, and a different directory from a process started
 * at the repository root. Anchoring to `BACKEND_DIR` removes that class of
 * failure entirely.
 *
 * `THREE_MEDIA_ROOT` is read per call (not once at import) because the test
 * harnesses and the evidence scripts legitimately point it at a temp directory;
 * every read and write goes through this function, so they always agree.
 */
export function mediaRoot() {
  if (process.env.THREE_MEDIA_ROOT) return path.resolve(process.env.THREE_MEDIA_ROOT);
  if (process.env.UPLOAD_DIR) return path.resolve(process.env.UPLOAD_DIR, '3d-media');
  return path.resolve(BACKEND_DIR, 'uploads/3d-media');
}

/** A filesystem-safe namespace for a workspace (or the platform bucket). */
function workspaceKey(workspaceSlug) {
  const slug = String(workspaceSlug || 'platform');
  return slug.replace(/[^a-zA-Z0-9._-]/g, '_') || 'platform';
}

export function assetDir(fileId, workspaceSlug) {
  return path.join(mediaRoot(), workspaceKey(workspaceSlug), String(fileId));
}

/**
 * Resolve a stored key back to an absolute path, refusing anything that escapes
 * the media root. Returns null for an unusable key so callers treat it as a
 * miss rather than as a filesystem error.
 */
export function resolveStorageKey(storageKey) {
  if (!storageKey || typeof storageKey !== 'string') return null;
  const root = mediaRoot();
  const resolved = path.resolve(root, storageKey);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

export function extensionFor(kind, format) {
  if (kind === 'glb') return 'glb';
  if (kind === 'thumbnail') return String(format || 'png').toLowerCase() === 'jpeg' ? 'jpg' : 'png';
  return 'bin';
}

export async function ensureRoot() {
  await assertWritableDir(mediaRoot(), { label: '3D media' });
  return mediaRoot();
}

/** Boot/health description (no absolute path in the payload). */
export async function mediaStatus({ probe = true } = {}) {
  if (usingObjectStorage()) {
    const object = await objectStoreStatus({ probe });
    return { kind: '3d', ...object, envVar: 'MEDIA_STORAGE_DRIVER', insideAppTree: false, path: undefined };
  }
  const status = await describeRoot({
    kind: '3d',
    root: mediaRoot(),
    envVar: 'THREE_MEDIA_ROOT',
    probe: probe || Boolean(String(process.env.THREE_MEDIA_ROOT || '').trim()),
  });
  return { ...status, driver: 'fs', path: undefined };
}

/** For server-side logs only (never a response body). */
export function mediaRootInfo() {
  if (usingObjectStorage()) {
    return { root: '(object storage)', durable: true, driver: storageDriver() };
  }
  return { root: mediaRoot(), durable: isDurableRoot(mediaRoot()), driver: 'fs' };
}

/** The object-storage key for one asset slot (same layout as the directory). */
function objectKeyFor(fileId, workspaceSlug, fileName) {
  return `${workspaceKey(workspaceSlug)}/${String(fileId)}/${fileName}`;
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Write one asset. Returns `{ storageKey, bytes, sha256 }` where `storageKey` is
 * relative to the media root.
 *
 * `overwrite` defaults to FALSE: a second write to the same slot is refused, so
 * a validated GLB cannot be quietly swapped for different bytes behind an
 * already-approved asset.
 */
export async function writeAsset({ fileId, workspaceSlug = 'platform', kind, buffer, format = 'png', overwrite = false, expectSha256 = '' } = {}) {
  if (!ASSET_KINDS.includes(kind)) {
    throw Object.assign(new Error(`Unsupported asset kind: ${kind}`), { code: 'INVALID_KIND' });
  }
  if (!buffer || buffer.length === 0) {
    throw Object.assign(new Error('An asset buffer is required.'), { code: 'VALIDATION_ERROR' });
  }

  const ext = extensionFor(kind, format);
  const fileName = kind === 'glb' ? `model.${ext}` : `thumbnail.${ext}`;

  // ── OBJECT DRIVER (R2) — same key layout, same immutability semantics … ──
  if (usingObjectStorage()) {
    const key = objectKeyFor(fileId, workspaceSlug, fileName);
    const existing = await headObject(key).catch((err) => {
      if (err?.code === 'STORAGE_KEY_INVALID') return null;
      throw err;
    });
    if (existing && !overwrite) {
      // IDEMPOTENT RETRY: an interrupted run (bytes uploaded, document not yet
      // saved) may re-PUT the IDENTICAL bytes — same key, same sha — which is a
      // no-op for the store and lets the flow finish. Different bytes are still
      // refused: that is what keeps a validated GLB immutable.
      if (expectSha256 && existing.sha256 && existing.sha256 === expectSha256) {
        return { storageKey: key, bytes: existing.bytes, sha256: existing.sha256, idempotent: true };
      }
      throw Object.assign(new Error('This asset already exists and will not be overwritten.'), {
        code: 'ASSET_IMMUTABLE',
        storageKey: key,
      });
    }
    const written = await putObject({
      key,
      buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
      contentType: kind === 'glb' ? 'model/gltf-binary' : `image/${ext === 'jpg' ? 'jpeg' : 'png'}`,
      metadata: { kind, workspace: workspaceKey(workspaceSlug) },
    });
    return { storageKey: written.key, bytes: written.bytes, sha256: written.sha256 };
  }

  // PRODUCTION GUARD — never write private media into the ephemeral deploy
  // directory (see privateObjectStorage.assertDurableWriteAllowed).
  assertDurableWriteAllowed({ root: mediaRoot(), label: '3D media' });

  await ensureRoot();
  const dir = assetDir(fileId, workspaceSlug);
  await assertWritableDir(dir, { label: '3D media' });

  const absolute = path.join(dir, fileName);

  if (!overwrite) {
    const exists = await fs
      .access(absolute)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw Object.assign(new Error('This asset already exists and will not be overwritten.'), {
        code: 'ASSET_IMMUTABLE',
        storageKey: path.relative(mediaRoot(), absolute),
      });
    }
  }

  try {
    await fs.writeFile(absolute, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  } catch (err) {
    // A raw EACCES/ENOSPC here used to become a generic 500 on the generation
    // path; it is a storage condition, and the client is told exactly that.
    throw toStorageError(err, { label: '3D media' });
  }
  const stat = await fs.stat(absolute);
  return {
    storageKey: path.relative(mediaRoot(), absolute),
    bytes: stat.size,
    sha256: await sha256File(absolute).catch(() => ''),
  };
}

/**
 * OVERWRITE a slot deliberately. Used only for the derived thumbnail, which is
 * regenerable and is not the evidence of generation — the GLB is.
 */
export async function replaceAsset(args) {
  return writeAsset({ ...args, overwrite: true });
}

/** Read an asset's bytes, or null when the key is unusable or missing. */
export async function readAsset(storageKey) {
  if (usingObjectStorage()) {
    return getObject(storageKey).catch((err) => {
      if (err?.code === 'STORAGE_KEY_INVALID' || err?.code === 'STORAGE_MISSING') return null;
      throw err;
    });
  }
  const absolute = resolveStorageKey(storageKey);
  if (!absolute) return null;
  try {
    return await fs.readFile(absolute);
  } catch {
    return null;
  }
}

export async function assetExists(storageKey) {
  if (usingObjectStorage()) {
    return headObject(storageKey)
      .then((head) => Boolean(head))
      .catch((err) => (err?.code === 'STORAGE_KEY_INVALID' ? false : Promise.reject(err)));
  }
  const absolute = resolveStorageKey(storageKey);
  if (!absolute) return false;
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

/** Remove every file belonging to one asset id. Missing files are not an error. */
export async function removeAssetFiles(fileId, workspaceSlug) {
  if (usingObjectStorage()) {
    await deletePrefix(`${workspaceKey(workspaceSlug)}/${String(fileId)}`).catch((err) => {
      if (err?.code === 'STORAGE_KEY_INVALID') return;
      throw err;
    });
    return;
  }
  const dir = assetDir(fileId, workspaceSlug);
  const root = mediaRoot();
  const rel = path.relative(root, dir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
  await fs.rm(dir, { recursive: true, force: true });
}
