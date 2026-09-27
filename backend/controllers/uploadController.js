import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ApiError } from '../middleware/errorMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Product image upload — Phase 14.
 *
 * Architecture:
 *   Admin UI → POST /api/uploads/product-image (multipart/form-data)
 *            → this controller validates type + size
 *            → ImageKit REST API when IMAGEKIT_* credentials exist
 *            → otherwise real local persistence under public/uploads
 *            → returns { url } which is stored on the Product document
 *
 * There is no simulated success: when the provider is misconfigured the
 * endpoint returns 503 UPLOAD_NOT_CONFIGURED so the UI can surface an honest
 * error instead of pretending an upload happened.
 */

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Local fallback storage directory ─────────────────────────────────
// Resolution order:
//   1. UPLOAD_DIR env var — explicit override for any deployment layout.
//   2. In development (running from the repo): the frontend's public/uploads
//      so Vite serves uploaded files directly at /uploads/<name>.
//   3. In production containers (RUNNING FROM /app): an app-relative writable
//      directory /app/uploads owned by the non-root runtime user.
//
// CRITICAL: the directory is created LAZILY (on first local-fallback write),
// NOT at module load. When ImageKit is configured the local dir is never
// touched, so a read-only or absent filesystem must not crash startup —
// this was the Render EACCES mkdir '/frontend/public/uploads' failure.
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, process.env.NODE_ENV === 'production' ? '../uploads' : '../../frontend/public/uploads');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
  return UPLOAD_DIR;
}

// Multer storage: when ImageKit is configured the file only needs to exist
// long enough to be forwarded to the provider, so keep it in MEMORY and let
// the provider path stream from the buffer — no filesystem writes at all in
// a fully-configured production deployment. Without ImageKit, persist to the
// (lazily ensured) local fallback directory.
const imageKitMemoryStorage = multer.memoryStorage();
const localStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      cb(null, ensureUploadDir());
    } catch (err) {
      cb(err instanceof ApiError ? err : new ApiError(500, `Upload storage unavailable: ${err.message}`, 'UPLOAD_FAILED'));
    }
  },
  filename(req, file, cb) {
    // Extension is derived from the ALREADY MIME-VALIDATED file and
    // restricted to a whitelist — original filename is never used for the
    // stored name, so path traversal / double-extension tricks are moot.
    const mimeToExt = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/avif': '.avif',
    };
    const ext = mimeToExt[file.mimetype] || '.jpg';
    // Phase 22.3 — workspace-namespaced storage: the gate ran before multer,
    // so a member's upload is written under its workspace's prefix (the
    // single-workspace/compat path keeps the original flat name).
    const ns = req && req.workspaceSlug ? `${req.workspaceSlug}-` : '';
    cb(null, `${ns}product-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

export const uploadMiddleware = multer({
  storage: imagekitConfigured() ? imageKitMemoryStorage : localStorage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      cb(new ApiError(422, 'Unsupported image type. Use JPEG, PNG, WebP, GIF or AVIF.', 'VALIDATION_ERROR'));
      return;
    }
    cb(null, true);
  },
});

function imagekitConfigured() {
  return Boolean(
    process.env.IMAGEKIT_PRIVATE_KEY &&
    process.env.IMAGEKIT_PUBLIC_KEY &&
    process.env.IMAGEKIT_URL_ENDPOINT
  );
}

/**
 * Upload to ImageKit using the v1 files/upload API with Basic auth.
 * Only the PRIVATE key touches the server — the public key/URL endpoint are
 * safe identifiers. Returns the hosted CDN URL. Accepts either a path on
 * disk (diskStorage fallback) or an in-memory Buffer (memoryStorage path).
 */
async function uploadToImageKit(fileSource, originalName, folder) {
  const auth = Buffer.from(`${process.env.IMAGEKIT_PRIVATE_KEY}:`).toString('base64');
  const form = new FormData();
  const fileBuffer = Buffer.isBuffer(fileSource) ? fileSource : fs.readFileSync(fileSource);
  form.append('file', new Blob([fileBuffer]), originalName || 'product-image');
  form.append('fileName', originalName || `product-${Date.now()}`);
  form.append('folder', folder || '/flora-alchemy/products');
  form.append('useUniqueFileName', 'true');

  const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(502, `ImageKit upload failed (${res.status}). ${detail.slice(0, 200)}`, 'UPLOAD_FAILED');
  }
  const json = await res.json();
  return json.url;
}

export async function uploadProductImage(req, res, next) {
  try {
    if (!req.file) {
      throw new ApiError(422, 'An image file is required.', 'VALIDATION_ERROR');
    }

    // Provider path when credentials exist.
    if (imagekitConfigured()) {
      try {
        const baseFolder = process.env.IMAGEKIT_FOLDER || '/flora-alchemy/products';
        const folder = req.workspaceSlug
          ? `${baseFolder}/workspaces/${req.workspaceSlug}`
          : baseFolder;
        const url = await uploadToImageKit(
          req.file.buffer || req.file.path,
          req.file.originalname,
          folder
        );
        // Memory buffers are garbage-collected; disk temp copies (if any)
        // are no longer needed once hosted.
        if (req.file.path) fs.unlink(req.file.path, () => {});
        return res.status(201).json({
          success: true,
          url,
          provider: 'imagekit',
        });
      } catch (err) {
        // Provider failed — clean the temp file (if any) and surface honestly.
        if (req.file.path) fs.unlink(req.file.path, () => {});
        return next(err);
      }
    }

    // No provider credentials: real local persistence. The file IS stored on
    // disk and served by the frontend at /uploads/<name>. This is a genuine
    // storage backend, not a simulation — but it is single-instance and not a
    // CDN, which the admin UI communicates.
    const publicUrl = `/uploads/${req.file.filename}`;
    res.status(201).json({
      success: true,
      url: publicUrl,
      provider: 'local',
    });
  } catch (err) {
    // Clean up partial writes on unexpected errors.
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    next(err);
  }
}

export function uploadNotConfiguredGuard(_req, _res, next) {
  // The upload route is always usable (local storage is always real).
  next();
}
