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

export const ASSET_KINDS = ['glb', 'thumbnail'];

const DEFAULT_ROOT = path.resolve(process.env.UPLOAD_DIR || 'backend/uploads', '3d-media');

/** The private media root, resolved once per process. */
export function mediaRoot() {
  return process.env.THREE_MEDIA_ROOT ? path.resolve(process.env.THREE_MEDIA_ROOT) : DEFAULT_ROOT;
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
  await fs.mkdir(mediaRoot(), { recursive: true });
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
export async function writeAsset({ fileId, workspaceSlug = 'platform', kind, buffer, format = 'png', overwrite = false } = {}) {
  if (!ASSET_KINDS.includes(kind)) {
    throw Object.assign(new Error(`Unsupported asset kind: ${kind}`), { code: 'INVALID_KIND' });
  }
  if (!buffer || buffer.length === 0) {
    throw Object.assign(new Error('An asset buffer is required.'), { code: 'VALIDATION_ERROR' });
  }

  await ensureRoot();
  const dir = assetDir(fileId, workspaceSlug);
  await fs.mkdir(dir, { recursive: true });

  const ext = extensionFor(kind, format);
  const fileName = kind === 'glb' ? `model.${ext}` : `thumbnail.${ext}`;
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

  await fs.writeFile(absolute, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
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
  const absolute = resolveStorageKey(storageKey);
  if (!absolute) return null;
  try {
    return await fs.readFile(absolute);
  } catch {
    return null;
  }
}

export async function assetExists(storageKey) {
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
  const dir = assetDir(fileId, workspaceSlug);
  const root = mediaRoot();
  const rel = path.relative(root, dir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
  await fs.rm(dir, { recursive: true, force: true });
}
