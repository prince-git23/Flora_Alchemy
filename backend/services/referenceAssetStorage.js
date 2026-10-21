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

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError } from '../middleware/errorMiddleware.js';
import {
  assertWritableDir,
  describeRoot,
  isDurableRoot,
  resolvePrivateRoot,
  toStorageError,
} from './privateMediaRoot.js';
import {
  assertDurableWriteAllowed,
  deletePrefix,
  findObjectByPrefix,
  getObject,
  headObject,
  objectStoreStatus,
  putObject,
  storageDriver,
  usingObjectStorage,
} from './privateObjectStorage.js';

/**
 * Absolute root. Created LAZILY so a read-only deployment that never uses the
 * studio cannot fail at import time.
 *
 * Resolved through `privateMediaRoot.resolvePrivateRoot` so it can never depend
 * on the process CWD, and so production can point it at a mounted disk
 * (`REFERENCE_MEDIA_DIR=/var/data/flora-alchemy/references`). Resolution is
 * still at import time ON PURPOSE: the E2E stack pins this variable before the
 * first media import, and a root that changes mid-process would split writes
 * and reads across two trees (the Phase 6 defect).
 */
const ROOT = resolvePrivateRoot('REFERENCE_MEDIA_DIR', 'reference-media');

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
export async function writeAsset({ imageId, workspaceSlug, kind, buffer, format, expectSha256 = '' }) {
  if (!ASSET_KINDS.includes(kind)) {
    throw new ApiError(500, `Unknown asset kind "${kind}".`, 'ASSET_KIND_UNKNOWN');
  }

  // ── OBJECT DRIVER (R2) — same key layout, same by-KIND immutability ─────
  if (usingObjectStorage()) {
    const fileName = `${kind}.${extensionFor(kind, format)}`;
    const key = `${workspaceKey(workspaceSlug)}/${String(imageId)}/${fileName}`;
    if (kind === 'original') {
      // "At most one original, whatever its format" — enforced by prefix scan,
      // exactly like the directory listing the filesystem path performs.
      const existing = await findObjectByPrefix(`${workspaceKey(workspaceSlug)}/${String(imageId)}/original.`).catch(
        (err) => {
          if (err?.code === 'STORAGE_KEY_INVALID') return null;
          throw err;
        }
      );
      if (existing) {
        // Idempotent retry of the SAME bytes is a no-op; different bytes are
        // refused — the ORIGINAL_IMMUTABLE rule, with a crash-safe exception.
        if (expectSha256 && existing.sha256 && existing.sha256 === expectSha256) {
          return {
            storageKey: existing.key,
            bytes: existing.bytes,
            sha256: existing.sha256,
            fileName,
            idempotent: true,
          };
        }
        throw new ApiError(
          409,
          'The original image for this reference already exists and is never overwritten.',
          'ORIGINAL_IMMUTABLE'
        );
      }
    }
    const written = await putObject({
      key,
      buffer,
      contentType: `image/${extensionFor(kind, format) === 'jpg' ? 'jpeg' : extensionFor(kind, format)}`,
      metadata: { kind, workspace: workspaceKey(workspaceSlug) },
    });
    return { storageKey: written.key, bytes: written.bytes, sha256: written.sha256, fileName };
  }

  // PRODUCTION GUARD — never write private media into the ephemeral deploy
  // directory (see privateObjectStorage.assertDurableWriteAllowed).
  assertDurableWriteAllowed({ root: ROOT, label: 'Reference media' });

  const dir = imageDir(imageId, workspaceSlug);
  // A filesystem failure here used to surface as a bare 500, which is
  // indistinguishable from any other server fault. `assertWritableDir` probes
  // the directory and every write below is translated into a typed 503, so the
  // administrator is told the truth ("the server could not store it, retry") and
  // the log keeps the syscall and path.
  await assertWritableDir(dir, { label: 'Reference media' });
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
  try {
    await fsp.writeFile(absolute, buffer);
  } catch (err) {
    throw toStorageError(err, { label: 'Reference media' });
  }
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
  if (usingObjectStorage()) {
    const bytes = await getObject(storageKey).catch((err) => {
      if (err?.code === 'STORAGE_KEY_INVALID' || err?.code === 'STORAGE_MISSING') return null;
      throw err;
    });
    if (!bytes) throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
    return bytes;
  }
  const absolute = resolveStorageKey(storageKey);
  try {
    return await fsp.readFile(absolute);
  } catch {
    throw new ApiError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  }
}

export async function assetExists(storageKey) {
  if (usingObjectStorage()) {
    return headObject(storageKey)
      .then((head) => Boolean(head))
      .catch((err) => (err?.code === 'STORAGE_KEY_INVALID' ? false : Promise.reject(err)));
  }
  try {
    await fsp.access(resolveStorageKey(storageKey));
    return true;
  } catch {
    return false;
  }
}

/** Remove every asset of one image. Safe to call twice. */
export async function removeImageAssets(imageId, workspaceSlug) {
  if (usingObjectStorage()) {
    await deletePrefix(`${workspaceKey(workspaceSlug)}/${String(imageId)}`).catch((err) => {
      if (err?.code === 'STORAGE_KEY_INVALID') return;
      throw err;
    });
    return;
  }
  const dir = imageDir(imageId, workspaceSlug);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** File size of an asset without reading it into memory (used by the API's
 *  content-length, so a large cutout is not buffered twice). */
export async function assetStat(storageKey) {
  if (usingObjectStorage()) {
    const head = await headObject(storageKey).catch(() => null);
    return head ? { size: head.bytes, mtime: head.lastModified || new Date(0) } : null;
  }
  const absolute = resolveStorageKey(storageKey);
  const stat = await fsp.stat(absolute).catch(() => null);
  return stat ? { size: stat.size, mtime: stat.mtime } : null;
}

/** Ensure the root exists and is writable — called by the write path, never at
 *  import, so a deployment that never opens the studio cannot fail to boot. */
export async function ensureRoot() {
  await assertWritableDir(ROOT, { label: 'Reference media' });
  return ROOT;
}

/**
 * Boot/health description of this root. Never throws: the API must still serve
 * the storefront when the private media disk is unavailable.
 *
 * `durable: false` is the important field — it means the files will not survive
 * a redeploy, which is exactly the failure mode that left DB rows pointing at
 * bytes that no longer existed.
 */
export async function mediaStatus({ probe = true } = {}) {
  if (usingObjectStorage()) {
    const object = await objectStoreStatus({ probe });
    return { kind: 'reference', ...object, envVar: 'MEDIA_STORAGE_DRIVER', insideAppTree: false, path: undefined };
  }
  const status = await describeRoot({
    kind: 'reference',
    root: ROOT,
    envVar: 'REFERENCE_MEDIA_DIR',
    // A configured root is always probed; an unconfigured one only when the
    // caller asks (production), so a dev/test boot does not create directories
    // in the working tree.
    probe: probe || Boolean(String(process.env.REFERENCE_MEDIA_DIR || '').trim()),
  });
  // Keep the absolute path out of HTTP payloads; it is a server-side detail.
  return { ...status, driver: 'fs', path: undefined };
}

/** For server-side logs only (never a response body). */
export function mediaRootInfo() {
  if (usingObjectStorage()) {
    return { root: '(object storage)', durable: true, driver: storageDriver() };
  }
  return { root: ROOT, durable: isDurableRoot(ROOT), driver: 'fs' };
}
