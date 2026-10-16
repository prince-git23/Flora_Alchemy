/**
 * 3D STUDIO — Phase 1 — PRIVATE storage for 3D reference media.
 *
 * Why not the existing public upload folder?
 * ------------------------------------------
 * Storefront product photos are meant to be public — they are the catalogue.
 * A 3D REFERENCE image is different: it is an unreviewed working asset, often a
 * photograph the administrator has not approved for publication, and the
 * Phase 1 brief is explicit that unapproved source images must not be publicly
 * accessible. So reference media is written to its own root, outside the
 * frontend's `public/` directory (and outside any CDN-configured folder), and
 * is served only through an authenticated, workspace-checked API route.
 *
 * Consequences, stated plainly:
 *   · these files are NOT served by Vite/the CDN — an admin page fetches them
 *     through the API with its bearer token, which is why the review UI shows
 *     blob URLs rather than image URLs;
 *   · a multi-instance deployment therefore needs a shared volume (or object
 *     storage) for this directory, exactly like any other uploaded file. That
 *     limitation is recorded in docs/IMAGE_STUDIO.md rather than hidden.
 *
 * The layout is `<root>/<workspaceKey>/<imageId>/<kind>.<ext>`, so:
 *   · one workspace's media is physically separable (easy to audit, easy to
 *     delete on tenant teardown);
 *   · every asset of one image is a single directory (removal is one call);
 *   · the workspace segment is derived from the SERVER-side workspace, never
 *     from a client-supplied value.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../middleware/errorMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute root. Created LAZILY so a read-only deployment that never uses the
 *  studio cannot fail at import time. */
const ROOT = process.env.REFERENCE_MEDIA_DIR
  ? path.resolve(process.env.REFERENCE_MEDIA_DIR)
  : path.resolve(__dirname, '../reference-media');

/** Asset kinds the studio stores. `original` is written once and never
 *  overwritten — the "never overwrite the original" rule is enforced here. */
export const ASSET_KINDS = ['original', 'cutout', 'neutral'];

const EXTENSION_BY_KIND = { original: null, cutout: 'png', neutral: 'png' };

export function mediaRoot() {
  return ROOT;
}

/** A filesystem-safe workspace segment. A workspace slug is already URL-safe;
 *  this is belt-and-braces so a surprising slug can never escape the root. */
function workspaceKey(workspaceSlug) {
  const raw = String(workspaceSlug || 'platform').trim() || 'platform';
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
}

export function imageDir(imageId, workspaceSlug) {
  return path.join(ROOT, workspaceKey(workspaceSlug), String(imageId));
}

/**
 * Resolve a stored relative key inside the root, refusing anything that would
 * escape it. Every read goes through here, so a corrupted or tampered
 * storageKey is a 404 rather than a filesystem read.
 */
export function resolveStorageKey(storageKey) {
  const relative = String(storageKey || '').replace(/\\/g, '/');
  if (!relative || relative.includes('\0')) {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
  const absolute = path.resolve(ROOT, relative);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolute !== ROOT && !absolute.startsWith(rootWithSep)) {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
  return absolute;
}

function extensionFor(kind, format) {
  if (EXTENSION_BY_KIND[kind]) return EXTENSION_BY_KIND[kind];
  const normalized = String(format || 'jpg').toLowerCase();
  if (normalized === 'jpeg') return 'jpg';
  return normalized.replace(/[^a-z0-9]/g, '') || 'bin';
}

/**
 * Write one asset and return its metadata. The ORIGINAL is never overwritten:
 * a second write of the same image's original is refused, because the only
 * legitimate writer of it is creation.
 *
 * The check is by KIND, not by filename: an earlier revision tested only the
 * path it was about to write, so a second write with a different format wrote
 * `original.png` next to `original.jpg` and both "originals" existed. One
 * reference image now has at most one original, whatever its format.
 */
export async function writeAsset({ imageId, workspaceSlug, kind, buffer, format }) {
  if (!ASSET_KINDS.includes(kind)) {
    throw new ApiError(500, `Unknown asset kind "${kind}".`, 'ASSET_KIND_UNKNOWN');
  }
  const dir = imageDir(imageId, workspaceSlug);
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${kind}.${extensionFor(kind, format)}`;
  const absolute = path.join(dir, fileName);
  if (kind === 'original') {
    const existing = await fsp.readdir(dir).catch(() => []);
    if (existing.some((name) => name.startsWith('original.'))) {
      throw new ApiError(
        409,
        'The original image for this reference already exists and is never overwritten.',
        'ORIGINAL_IMMUTABLE'
      );
    }
  }
  await fsp.writeFile(absolute, buffer);
  const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
  return {
    storageKey: relative,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    fileName,
  };
}

/** Read an asset, or throw the 404 the API contract uses for a missing file. */
export async function readAsset(storageKey) {
  const absolute = resolveStorageKey(storageKey);
  try {
    return await fsp.readFile(absolute);
  } catch {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
}

export async function assetExists(storageKey) {
  try {
    await fsp.access(resolveStorageKey(storageKey));
    return true;
  } catch {
    return false;
  }
}

/** Remove every asset of one image. Safe to call twice. */
export async function removeImageAssets(imageId, workspaceSlug) {
  const dir = imageDir(imageId, workspaceSlug);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** File size of an asset without reading it into memory (used by the API's
 *  content-length, so a large cutout is not buffered twice). */
export async function assetStat(storageKey) {
  const absolute = resolveStorageKey(storageKey);
  const stat = await fsp.stat(absolute).catch(() => null);
  return stat ? { size: stat.size, mtime: stat.mtime } : null;
}

/** Ensure the root exists — called by the write path, never at import. */
export async function ensureRoot() {
  await fsp.mkdir(ROOT, { recursive: true });
}
