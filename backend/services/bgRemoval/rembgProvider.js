/**
 * 3D STUDIO — Phase 1 — the OPTIONAL machine-learning provider (rembg).
 *
 * WHY IT IS OPTIONAL
 * ------------------
 * `rembg` separates a product from a BUSY background far better than the
 * deterministic engine, but it costs a Python runtime, several hundred
 * megabytes of wheels and a model download — and, the part that matters for a
 * commercial boutique, the MODEL WEIGHTS carry their own licences, separate
 * from rembg's own MIT code.
 *
 * THE LICENCE GUARD (please read before changing the model list)
 * -------------------------------------------------------------
 * Verified 2026-10-14 against the upstream projects (rembg's own README + the
 * linked model sources):
 *
 *   · `bria-rmbg` (BRIA RMBG) — rembg's **current default**. BRIA's model card
 *     states RMBG is released for non-commercial use and that commercial use is
 *     subject to a commercial agreement with BRIA; rembg's README repeats that
 *     the model needs a paid agreement for commercial use. Flora Alchemy is a
 *     commercial boutique, so this provider REFUSES it — including when an
 *     operator sets it explicitly. A silent non-commercial model in a paid
 *     product is a legal problem, not a technical one.
 *   · `isnet-general-use` (IS-Net / DIS) — the upstream repository scopes
 *     Apache-2.0 to its code; the separately published weights have no clear
 *     licence statement. Unverified, so REFUSED by default (an operator who has
 *     obtained permission can opt in with BGREMOVE_ALLOW_UNVERIFIED_MODEL=1).
 *   · `u2net` / `u2netp` / `silueta` (U-2-Net family) — upstream U-2-Net is
 *     Apache-2.0, which covers the weights. ALLOWED. Default (a modest download
 *     and the fastest of the cleared models).
 *   · `birefnet-general` / `birefnet-general-lite` (BiRefNet) — the official
 *     weights are MIT. ALLOWED. Better on busy backgrounds, heavier than u2net
 *     (the `-lite` checkpoint is the compromise).
 *
 * Two caveats are recorded rather than smoothed over, because an operator
 * choosing a model deserves the whole picture:
 *
 *   · rembg DISTRIBUTES the weights as its own `.onnx` downloads, and at least
 *     one of those files (`u2net.onnx`) has been reported upstream as carrying
 *     no licence statement of its own — the Apache-2.0 assessment above comes
 *     from the U-2-Net repository the weights were trained in, which is the
 *     best available evidence rather than a statement attached to the file.
 *   · `isnet-general-use` is refused for exactly that reason: no licence
 *     statement was found for its weights.
 *
 * The chosen model is recorded on every processed image (`processing.model`) and
 * reported in the API response, so a reviewer can always see which engine and
 * which weights produced a cutout.
 *
 * The provider is only ever selected when an operator ASKS for it
 * (`BGREMOVE_PROVIDER=rembg` or `auto` with a working install) — see
 * `bgRemoval/index.js`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ApiError } from '../../middleware/errorMiddleware.js';

/**
 * Model licence table. `ok: true` means commercially cleared for this project;
 * anything else needs an explicit operator opt-in.
 */
export const MODEL_LICENCES = {
  u2net: { licence: 'Apache-2.0 (U-2-Net upstream)', ok: true },
  u2netp: { licence: 'Apache-2.0 (U-2-Net upstream)', ok: true },
  silueta: { licence: 'Apache-2.0 (U-2-Net upstream)', ok: true },
  'birefnet-general': { licence: 'MIT (BiRefNet official weights)', ok: true },
  'birefnet-general-lite': { licence: 'MIT (BiRefNet official weights)', ok: true },
  'isnet-general-use': {
    licence: 'unverified — upstream weights carry no licence statement',
    ok: false,
  },
  'bria-rmbg': {
    licence: 'NON-COMMERCIAL — commercial use requires a BRIA agreement',
    ok: false,
  },
};

const DEFAULT_MODEL = 'u2net';
const DEFAULT_TIMEOUT_MS = 180_000;

/** Resolve (and validate) the configured model id. */
export function resolveModel(requested) {
  const model = String(requested || process.env.BGREMOVE_MODEL || DEFAULT_MODEL).trim();
  const entry = MODEL_LICENCES[model];
  if (!entry) {
    throw new ApiError(
      500,
      `BGREMOVE_MODEL "${model}" is not a known commercially-reviewed model. ` +
        `Known: ${Object.keys(MODEL_LICENCES).join(', ')}.`,
      'BGREMOVE_MODEL_UNKNOWN'
    );
  }
  if (!entry.ok && process.env.BGREMOVE_ALLOW_UNVERIFIED_MODEL !== '1') {
    throw new ApiError(
      500,
      `BGREMOVE_MODEL "${model}" is not cleared for commercial use (${entry.licence}). ` +
        'Choose u2net or birefnet-general, or set BGREMOVE_ALLOW_UNVERIFIED_MODEL=1 if you have obtained permission.',
      'BGREMOVE_MODEL_NOT_LICENSED'
    );
  }
  return { model, licence: entry.licence };
}

/** The Python interpreter to use: an explicit path, then the venv beside the
 *  repo, then whatever `python` resolves to on PATH. */
function candidates() {
  const list = [];
  if (process.env.BGREMOVE_PYTHON) list.push(process.env.BGREMOVE_PYTHON);
  list.push(path.resolve(process.cwd(), 'tools/bgremove/.venv/Scripts/python.exe'));
  list.push(path.resolve(process.cwd(), 'tools/bgremove/.venv/bin/python'));
  list.push('python');
  list.push('python3');
  return list;
}

function run(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, spawnError: err.message, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, spawnError: err.code || err.message, stdout, stderr });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * The worker rembg runs as a separate process, driven through its LIBRARY API —
 * not its CLI.
 *
 * Why not the CLI: rembg's command line is not a stable interface to script
 * against. Its `i` subcommand takes the output as a POSITIONAL argument and no
 * longer accepts `--output` at all, and `python -m rembg` is not portable
 * because the package ships no `__main__` module. A provider pinned to those
 * details breaks on the next release, silently, at the moment an administrator
 * uploads a product photo. The library is the surface rembg's own docs
 * recommend for repeated work, so it is the one used here.
 *
 * The script is passed as the single argument to `python -c`, with the model
 * and the two paths following it: with `-c`, Python parses every remaining
 * argument as argv, so `sys.argv[1..3]` are exactly what was passed and no
 * shell quoting is involved (the process is spawned directly, never through a
 * shell).
 */
const WORKER = `
import sys
from rembg import remove, new_session

model, source, target, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
session = new_session(model)  # downloads the weights on first use, then caches them
with open(source, 'rb') as fh:
    data = fh.read()
# Decontamination (opt-in) rewrites the COLOUR of soft edge pixels, never their
# alpha: it removes the coloured halo a product keeps when it was photographed
# against a strongly coloured background (petals over green foliage).
kwargs = {'decontaminate': True} if mode == 'decontaminate' else {}
out = remove(data, session=session, **kwargs)
with open(target, 'wb') as fh:
    fh.write(out)
`;

/** Probe script: reports the interpreter's rembg version and the models it can
 *  actually run, so a misconfigured `BGREMOVE_MODEL` is a clear 500 naming the
 *  alternatives rather than a Python traceback in a log nobody reads. */
const PROBE = `
import json
import rembg
import onnxruntime
from rembg.sessions import sessions_names
print('rembg-ok')
print(json.dumps({
    'version': getattr(rembg, '__version__', ''),
    'models': sorted(sessions_names),
    'onnxruntime': getattr(onnxruntime, '__version__', ''),
}))
`;

let probeCache = null;

/**
 * Is a working rembg install reachable? Probed ONCE per process and cached —
 * importing rembg (and onnxruntime) takes seconds, so probing per request would
 * double every upload's latency. `BGREMOVE_PROBE=0` skips the probe entirely.
 *
 * @returns {Promise<{available: boolean, python?: string, version?: string, reason?: string}>}
 */
export async function probeRembg({ force = false } = {}) {
  if (probeCache && !force) return probeCache;
  if (process.env.BGREMOVE_PROBE === '0') {
    probeCache = { available: false, reason: 'probe disabled (BGREMOVE_PROBE=0)' };
    return probeCache;
  }
  for (const python of candidates()) {
    const r = await run(python, ['-c', PROBE], { timeoutMs: 60_000 });
    const lines = String(r.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (r.ok && lines.includes('rembg-ok')) {
      let detail = {};
      const last = lines[lines.length - 1];
      if (last && last.startsWith('{')) {
        try {
          detail = JSON.parse(last);
        } catch {
          /* report what we have without the detail block */
        }
      }
      probeCache = {
        available: true,
        python,
        version: detail.version || '',
        onnxruntime: detail.onnxruntime || '',
        models: Array.isArray(detail.models) ? detail.models : [],
      };
      return probeCache;
    }
    if (r.spawnError === 'ENOENT') continue; // interpreter not present
    // An interpreter that exists but cannot import rembg: remember why, but
    // keep trying the other candidates (a venv may be the working one).
    probeCache = { available: false, reason: (r.stderr || r.spawnError || 'import failed').trim().slice(0, 300) };
  }
  probeCache = probeCache || { available: false, reason: 'no Python interpreter with rembg found' };
  return probeCache;
}

export function resetProbeCache() {
  probeCache = null;
}

/**
 * Remove the background with rembg and return the same shape as the
 * deterministic engine, so the calling service does not branch on provider.
 */
export async function removeBackground(inputBuffer, options = {}) {
  const probe = await probeRembg();
  if (!probe.available) {
    throw new ApiError(
      503,
      `The rembg engine is not available on this server (${probe.reason || 'not installed'}).`,
      'BGREMOVE_UNAVAILABLE'
    );
  }
  const { model, licence } = resolveModel(options.model);
  // A model this build's licence table clears may still not exist in the
  // installed rembg (the model list grows between releases). Say which models
  // the interpreter DOES have instead of letting Python fail obscurely.
  if (probe.models?.length && !probe.models.includes(model)) {
    throw new ApiError(
      500,
      `This rembg install does not provide "${model}". Available: ${probe.models.join(', ')}.`,
      'BGREMOVE_MODEL_UNAVAILABLE'
    );
  }
  const decontaminate = options.decontaminate ?? process.env.BGREMOVE_DECONTAMINATE === '1';

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fa-bgremove-'));
  const token = crypto.randomBytes(8).toString('hex');
  const prepared = path.join(tmpDir, `prepared-${token}.png`);
  const output = path.join(tmpDir, `cutout-${token}.png`);

  try {
    // Prepare the SAME way the deterministic engine does — auto-orient, apply
    // any administrator crop, bound the working size — so a crop means the same
    // thing whichever engine runs.
    let pipeline = sharp(inputBuffer, { failOn: 'error' }).rotate();
    try {
      await pipeline.metadata();
    } catch (err) {
      throw new ApiError(422, 'That file is not a readable image.', 'UNREADABLE_IMAGE', {
        cause: err.message,
      });
    }
    if (options.crop) {
      const meta = await sharp(inputBuffer).metadata();
      const rotated = meta.orientation && meta.orientation >= 5;
      const srcW = rotated ? meta.height : meta.width;
      const srcH = rotated ? meta.width : meta.height;
      const clampC = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
      const left = clampC(Math.round(options.crop.x * srcW), 0, srcW - 1);
      const top = clampC(Math.round(options.crop.y * srcH), 0, srcH - 1);
      pipeline = pipeline.extract({
        left,
        top,
        width: clampC(Math.round(options.crop.width * srcW), 1, srcW - left),
        height: clampC(Math.round(options.crop.height * srcH), 1, srcH - top),
      });
    }
    const maxDim = options.maxDimension || 1600;
    await pipeline
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(prepared);

    const started = Date.now();
    // `python -c <script> <model> <in> <out> <mode>` — the library API, with the
    // arguments after the code exposed as sys.argv (see WORKER above).
    const result = await run(
      probe.python,
      ['-c', WORKER, model, prepared, output, decontaminate ? 'decontaminate' : 'plain'],
      { timeoutMs: Number(process.env.BGREMOVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) }
    );
    if (!result.ok) {
      throw new ApiError(
        result.timedOut ? 504 : 502,
        `The rembg engine failed${result.timedOut ? ' (timed out)' : ''}: ${(
          result.stderr || result.spawnError || `exit ${result.code}`
        )
          .trim()
          .slice(0, 300)}`,
        'BGREMOVE_FAILED'
      );
    }
    const elapsedMs = Date.now() - started;

    const cutout = await sharp(output).png({ compressionLevel: 9 }).toBuffer();
    const { analyseCutout } = await import('./cutoutMetrics.js');
    const analysis = await analyseCutout(cutout);

    return {
      provider: 'rembg',
      model,
      modelLicence: licence,
      cutout,
      neutral: null, // composed by the caller through one shared path
      width: analysis.width,
      height: analysis.height,
      foregroundBox: analysis.foregroundBox,
      metrics: { ...analysis.metrics, engineMs: elapsedMs },
      warnings: analysis.warnings,
      // Decontamination is recorded as a NOTE: it changed the colour of edge
      // pixels (deliberately), but nothing about the result is wrong.
      notes: decontaminate
        ? ['Edge colour decontamination was applied to remove background colour fringing.']
        : [],
      confidence: analysis.confidence,
    };
  } finally {
    // Abandoned temp files are cleaned up unconditionally — the failure path
    // matters more than the success path here, because a retry loop must not
    // fill the disk.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
