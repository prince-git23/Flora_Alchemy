/**
 * PROCEDURAL MATERIALS — every pixel the atelier shows is generated here.
 *
 * No HDRI, no texture download, no CDN: the workshop must look the same on a
 * plane, behind a corporate proxy and offline, and the storefront must never
 * gain a second asset pipeline. Textures are drawn with Canvas2D at load time
 * (in the lazy chunk, never on first paint) and cached per configuration.
 *
 * The one thing that is NOT procedural is the product photography, which is
 * already part of the storefront — the atelier does not claim to depict it.
 */

import { ATELIER } from './palette.js';

/** Small deterministic PRNG so a texture is identical on every visit. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvas(size, height = size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  return c;
}

const cache = new Map();
function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

/** Warm oak with open grain, the workshop's largest surface. */
export function woodTexture({ size = 1024, seed = 7 } = {}) {
  return memo(`wood-${size}-${seed}`, () => {
    const c = canvas(size);
    const ctx = c.getContext('2d');
    const random = rng(seed);
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#6d5138');
    grad.addColorStop(0.5, '#8a6a4a');
    grad.addColorStop(1, '#67492f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Grain: long, slightly wandering strokes rather than noise, because oak
    // reads as lines to the eye and as noise to a shader.
    for (let i = 0; i < 220; i += 1) {
      const y = random() * size;
      const wobble = 6 + random() * 20;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${40 + random() * 40}, ${26 + random() * 24}, ${16 + random() * 16}, ${0.05 + random() * 0.16})`;
      ctx.lineWidth = 0.6 + random() * 2.4;
      ctx.moveTo(-20, y);
      for (let x = 0; x <= size + 20; x += 24) {
        ctx.lineTo(x, y + Math.sin(x / 90 + i) * wobble * 0.2 + (random() - 0.5) * 1.2);
      }
      ctx.stroke();
    }
    // Knots, sparse.
    for (let i = 0; i < 4; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const r = 12 + random() * 26;
      const knot = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
      knot.addColorStop(0, 'rgba(52,34,22,0.55)');
      knot.addColorStop(1, 'rgba(52,34,22,0)');
      ctx.fillStyle = knot;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.5, random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    return c;
  });
}

/** Roughness companion for the oak: grain is marginally smoother than the pores. */
export function woodRoughnessTexture({ size = 512, seed = 9 } = {}) {
  return memo(`wood-rough-${size}-${seed}`, () => {
    const c = canvas(size);
    const ctx = c.getContext('2d');
    const random = rng(seed);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 2600; i += 1) {
      const v = 110 + Math.floor(random() * 90);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(random() * size, random() * size, 1 + random() * 3, 1);
    }
    return c;
  });
}

/** Cotton-rag paper with visible fibre and deckled tone variation. */
export function paperTexture({ size = 512, tone = '#f7f1e6', seed = 3 } = {}) {
  return memo(`paper-${size}-${tone}-${seed}`, () => {
    const c = canvas(size);
    const ctx = c.getContext('2d');
    const random = rng(seed);
    ctx.fillStyle = tone;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 9000; i += 1) {
      const alpha = 0.02 + random() * 0.06;
      ctx.fillStyle = random() > 0.5 ? `rgba(120,100,78,${alpha})` : `rgba(255,255,255,${alpha})`;
      ctx.fillRect(random() * size, random() * size, 1 + random() * 1.8, 1);
    }
    // Fibres: short curved threads, the thing that reads as "handmade paper".
    for (let i = 0; i < 130; i += 1) {
      ctx.strokeStyle = `rgba(140,120,96,${0.04 + random() * 0.06})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const x = random() * size;
      const y = random() * size;
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + (random() - 0.5) * 22, y + (random() - 0.5) * 22, x + (random() - 0.5) * 34, y + (random() - 0.5) * 30);
      ctx.stroke();
    }
    return c;
  });
}

/**
 * The wax seal, engraved with up to three initials.
 *
 * This is the moment the atelier stops being decoration: the monogram typed in
 * the overlay is stamped into the wax the customer is looking at, and the same
 * letters travel to the studio. Drawn as a radial wax pool + engraved letters,
 * with a bevel highlight so it reads as pressed rather than printed.
 */
export function waxSealTexture({ initials = 'FA', hex = ATELIER.terracotta, size = 512 } = {}) {
  return memo(`wax-${initials}-${hex}-${size}`, () => {
    const c = canvas(size);
    const ctx = c.getContext('2d');
    const random = rng(initials ? initials.charCodeAt(0) : 5);
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.44;

    // Pool: slightly irregular edge, darker at the rim.
    const pool = ctx.createRadialGradient(cx, cy * 0.94, r * 0.15, cx, cy, r);
    pool.addColorStop(0, hex);
    pool.addColorStop(0.72, hex);
    pool.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = pool;
    ctx.beginPath();
    const points = 96;
    for (let i = 0; i <= points; i += 1) {
      const angle = (i / points) * Math.PI * 2;
      const wobble = 1 + Math.sin(angle * 5 + 1.2) * 0.02 + (random() - 0.5) * 0.02;
      const px = cx + Math.cos(angle) * r * wobble;
      const py = cy + Math.sin(angle) * r * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();

    // Pressed ring.
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = size * 0.018;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();

    // Initials — engraved (dark) with a light lower edge, so a single flat
    // texture still reads as depth under the key light.
    const text = String(initials || 'FA').slice(0, 3).toUpperCase();
    const fontSize = size * (text.length > 2 ? 0.3 : text.length > 1 ? 0.34 : 0.42);
    ctx.font = `600 ${fontSize}px 'Newsreader', Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillText(text, cx, cy + size * 0.012);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillText(text, cx, cy - size * 0.006);

    // Specular flecks: wax is never perfectly matte at this scale.
    for (let i = 0; i < 40; i += 1) {
      ctx.fillStyle = `rgba(255,255,255,${0.02 + random() * 0.05})`;
      ctx.fillRect(cx + (random() - 0.5) * r * 1.6, cy + (random() - 0.5) * r * 1.6, 1, 1);
    }
    return c;
  });
}

/**
 * The calligraphy card: the recipient's name written in a script face with the
 * atelier's own flourish rules. Uses the fonts the storefront already ships
 * (Newsreader / serif fallback) — never a webfont download.
 */
export function cardTexture({ name = '', size = 1024 } = {}) {
  const clean = String(name || '').toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 18).trim();
  return memo(`card-${clean}-${size}`, () => {
    const c = canvas(size, Math.round(size * 0.62));
    const ctx = c.getContext('2d');
    const random = rng(11);
    const { width, height } = c;

    ctx.fillStyle = ATELIER.paper;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 5200; i += 1) {
      ctx.fillStyle = `rgba(120,100,78,${0.02 + random() * 0.05})`;
      ctx.fillRect(random() * width, random() * height, 1, 1);
    }

    // Ruled margin + deckled border, drawn as ink rather than as a UI line.
    ctx.strokeStyle = 'rgba(36,26,18,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(width * 0.08, height * 0.1, width * 0.84, height * 0.8);

    ctx.fillStyle = ATELIER.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = `500 ${Math.round(width * 0.055)}px 'Newsreader', Georgia, serif`;
    ctx.globalAlpha = 0.6;
    ctx.fillText('For', width / 2, height * 0.3);
    ctx.globalAlpha = 1;

    const nameSize = Math.round(width * (clean.length > 12 ? 0.085 : clean.length > 8 ? 0.11 : 0.135));
    ctx.font = `500 ${nameSize}px 'Newsreader', Georgia, serif`;
    ctx.fillText(clean || 'Someone Special', width / 2, height * 0.5);

    // A single flourish stroke under the name — the atelier's signature.
    ctx.strokeStyle = 'rgba(150,71,53,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(width * 0.28, height * 0.63);
    ctx.bezierCurveTo(width * 0.42, height * 0.69, width * 0.58, height * 0.57, width * 0.73, height * 0.64);
    ctx.stroke();

    ctx.globalAlpha = 0.45;
    ctx.font = `400 ${Math.round(width * 0.033)}px 'Newsreader', Georgia, serif`;
    ctx.fillText('wrapped by hand in the atelier', width / 2, height * 0.78);
    ctx.globalAlpha = 1;
    return c;
  });
}

/** A woven ribbon face: satin has directional sheen, twine has cross threads. */
export function ribbonTexture({ hex = '#b98f7d', kind = 'frayed-silk', size = 256 } = {}) {
  return memo(`ribbon-${hex}-${kind}-${size}`, () => {
    const c = canvas(size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, size, size);
    if (kind === 'deckled-twine') {
      for (let i = 0; i < size; i += 4) {
        ctx.strokeStyle = i % 8 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(60,44,28,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(size, i + 2);
        ctx.stroke();
      }
    } else if (kind === 'velvet-cord') {
      for (let i = 0; i < 900; i += 1) {
        ctx.fillStyle = `rgba(255,255,255,${0.01 + Math.random() * 0.03})`;
        ctx.fillRect(Math.random() * size, Math.random() * size, 1, 2);
      }
    } else {
      // Satin: fine diagonal weft.
      for (let i = -size; i < size * 2; i += 3) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + size, size);
        ctx.stroke();
      }
    }
    return c;
  });
}

/**
 * A neutral warm studio environment, generated as a 2:1 equirectangular canvas
 * and pre-filtered by three's PMREM. This is what makes brass, wax and silk
 * read as materials instead of flat colour — and it costs no network request.
 */
export function studioEnvironmentTexture({ size = 512 } = {}) {
  return memo(`env-${size}`, () => {
    const c = canvas(size * 2, size);
    const ctx = c.getContext('2d');
    const sky = ctx.createLinearGradient(0, 0, 0, size);
    sky.addColorStop(0, '#f4ead8');
    sky.addColorStop(0.45, '#e7dcc7');
    sky.addColorStop(0.55, '#b9a58a');
    sky.addColorStop(1, '#4a3a2b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, size * 2, size);

    // Two soft window lights, exactly where the scene's key and rim are, so the
    // reflections agree with the shadows.
    const key = ctx.createRadialGradient(size * 0.55, size * 0.32, 4, size * 0.55, size * 0.32, size * 0.42);
    key.addColorStop(0, 'rgba(255,244,222,0.95)');
    key.addColorStop(1, 'rgba(255,244,222,0)');
    ctx.fillStyle = key;
    ctx.fillRect(0, 0, size * 2, size);

    const rim = ctx.createRadialGradient(size * 1.5, size * 0.5, 4, size * 1.5, size * 0.5, size * 0.3);
    rim.addColorStop(0, 'rgba(255,214,160,0.5)');
    rim.addColorStop(1, 'rgba(255,214,160,0)');
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, size * 2, size);
    return c;
  });
}

export default {
  woodTexture,
  woodRoughnessTexture,
  paperTexture,
  waxSealTexture,
  cardTexture,
  ribbonTexture,
  studioEnvironmentTexture,
};
