import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * HERO FRAGMENTS — the index's ONE lazy WebGL surface.
 *
 * Every visible fragment is a crop of the ACTIVE PRODUCT PHOTOGRAPH, drawn into
 * a small atlas on the client at mount. Nothing is illustrated or synthesised:
 * if the photograph cannot be read, the canvas simply draws the rings and the
 * DOM hero remains complete. The canvas is decorative, pointer-events-none and
 * aria-hidden.
 *
 * Motion is a function of the scrub value handed in by HeroStage
 * (`motionRef.current = { p, swirl }`), plus a slow idle drift. The same canvas
 * draws four nested light rings, bokeh discs, a sparkle burst and the 60-disc
 * light streak; there is no second renderer and no post-processing.
 */

const MAX_FRAGMENTS = 150;
const MOBILE_FRAGMENTS = 40;
const ATLAS_COLS = 4;
const CELL = 128;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function seeded(i, salt = 1) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.32, 'rgba(255,249,238,0.72)');
  g.addColorStop(1, 'rgba(255,249,238,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Build a 4×4 atlas of soft-edged crops from the product photograph.
 * The source is drawn cover into a square first, so portrait and landscape
 * photographs both yield usable fragments. The radial destination-in pass is
 * what turns a rectangular crop into a petal-shaped piece with a feathered
 * edge; the pixels themselves are untouched.
 */
function photoAtlas(image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS_COLS * CELL;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const sx0 = ((image.naturalWidth || image.width) - side) / 2;
  const sy0 = ((image.naturalHeight || image.height) - side) / 2;

  for (let row = 0; row < ATLAS_COLS; row += 1) {
    for (let col = 0; col < ATLAS_COLS; col += 1) {
      const i = row * ATLAS_COLS + col;
      const zoom = 0.22 + seeded(i, 2) * 0.2;
      const crop = side * zoom;
      const maxOffset = side - crop;
      const sx = sx0 + seeded(i, 3) * maxOffset;
      const sy = sy0 + seeded(i, 4) * maxOffset;
      const dx = col * CELL;
      const dy = row * CELL;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, CELL, CELL);
      ctx.clip();
      ctx.drawImage(image, sx, sy, crop, crop, dx, dy, CELL, CELL);
      /* Feather the square crop into a petal. */
      const feather = ctx.createRadialGradient(dx + CELL / 2, dy + CELL / 2, CELL * 0.18, dx + CELL / 2, dy + CELL / 2, CELL * 0.52);
      feather.addColorStop(0, 'rgba(0,0,0,1)');
      feather.addColorStop(0.62, 'rgba(0,0,0,0.92)');
      feather.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = feather;
      ctx.fillRect(dx, dy, CELL, CELL);
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Hero image could not be loaded for fragments.'));
    img.src = url;
  });
}

function ringGeometry(radius, flatten) {
  const pts = [];
  for (let i = 0; i <= 180; i += 1) {
    const a = (i / 180) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * flatten, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export default function HeroFragments({ imageUrl, accent = '', motionRef, className = '' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host || !imageUrl) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 10);

    const disposables = [];
    const soft = softTexture();
    disposables.push(soft);

    const token = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    const glow = new THREE.Color(accent || token || '#964735');
    const white = new THREE.Color('#fff8ec');

    /* Four nested ellipses. The group is tilted -14deg and every ring has its
       own rotation so the orbit reads as depth rather than a flat target. */
    const rings = new THREE.Group();
    rings.rotation.x = THREE.MathUtils.degToRad(-14);
    const ringObjs = [];
    for (let i = 0; i < 4; i += 1) {
      const geo = ringGeometry(2.1 + i * 0.27, 0.46 + i * 0.015);
      const mat = new THREE.LineBasicMaterial({
        color: i === 0 ? glow : white,
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.LineLoop(geo, mat);
      line.rotation.z = i * 0.42;
      rings.add(line);
      ringObjs.push(line);
      disposables.push(geo, mat);
    }
    scene.add(rings);

    const fragmentCount = window.matchMedia('(max-width: 767px)').matches ? MOBILE_FRAGMENTS : MAX_FRAGMENTS;
    const positions = new Float32Array(fragmentCount * 3);
    const cells = new Float32Array(fragmentCount * 2);
    const sizes = new Float32Array(fragmentCount);
    const angles = new Float32Array(fragmentCount);
    const alphas = new Float32Array(fragmentCount);
    const seeds = [];
    for (let i = 0; i < fragmentCount; i += 1) {
      const cell = Math.floor(seeded(i, 7) * ATLAS_COLS * ATLAS_COLS);
      cells[i * 2] = (cell % ATLAS_COLS) / ATLAS_COLS;
      cells[i * 2 + 1] = Math.floor(cell / ATLAS_COLS) / ATLAS_COLS;
      sizes[i] = 0.62 + seeded(i, 8) * 0.8;
      angles[i] = seeded(i, 9) * Math.PI * 2;
      seeds.push({
        angle: seeded(i, 10) * Math.PI * 2,
        radius: 0.55 + seeded(i, 11) * 1.45,
        y: (seeded(i, 12) - 0.5) * 1.9,
        z: (seeded(i, 13) - 0.5) * 1.8,
        speed: 0.3 + seeded(i, 14) * 0.7,
        phase: seeded(i, 15) * 6.28,
      });
    }

    const fragmentGeo = new THREE.BufferGeometry();
    fragmentGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    fragmentGeo.setAttribute('aCell', new THREE.BufferAttribute(cells, 2));
    fragmentGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    fragmentGeo.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
    fragmentGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

    const fragmentMat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: null },
        uDpr: { value: Math.min(window.devicePixelRatio || 1, 1.5) },
        uHasPhoto: { value: 0 },
        uGlow: { value: glow },
      },
      vertexShader: `
        uniform float uDpr;
        attribute vec2 aCell;
        attribute float aSize;
        attribute float aAngle;
        attribute float aAlpha;
        varying vec2 vCell;
        varying float vAngle;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uDpr * (96.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
          vCell = aCell;
          vAngle = aAngle;
          vAlpha = aAlpha;
        }
      `,
      fragmentShader: `
        uniform sampler2D uAtlas;
        uniform float uHasPhoto;
        uniform vec3 uGlow;
        varying vec2 vCell;
        varying float vAngle;
        varying float vAlpha;
        void main() {
          float c = cos(vAngle);
          float s = sin(vAngle);
          vec2 local = (gl_PointCoord - 0.5) * mat2(c, -s, s, c) + 0.5;
          vec4 tex = texture2D(uAtlas, vCell + local / ${ATLAS_COLS}.0);
          if (tex.a < 0.05) discard;
          vec3 colour = mix(uGlow * 0.55, tex.rgb, uHasPhoto);
          gl_FragColor = vec4(colour, tex.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const fragments = new THREE.Points(fragmentGeo, fragmentMat);
    fragments.frustumCulled = false;
    scene.add(fragments);
    disposables.push(fragmentGeo, fragmentMat);

    /* Bokeh discs and sparkles are additive light, separate from the photo
       fragments so the product's pixels keep their real colour. */
    const makePoints = (count, size, color, opacity) => {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        pos[i * 3] = (seeded(i, 22) - 0.5) * 12;
        pos[i * 3 + 1] = (seeded(i, 23) - 0.5) * 7;
        pos[i * 3 + 2] = -0.5 - seeded(i, 24) * 2;
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        map: soft,
        size,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      const pts = new THREE.Points(geo, mat);
      scene.add(pts);
      disposables.push(geo, mat);
      return pts;
    };
    const bokeh = makePoints(46, 0.42, 0xfff0d8, 0);
    const sparkles = makePoints(110, 0.09, 0xfffdf5, 0);

    const streakGeo = new THREE.BufferGeometry();
    const streakCount = 60;
    streakGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(streakCount * 3), 3));
    const streakMat = new THREE.PointsMaterial({
      map: soft,
      size: 0.3,
      color: 0xfff4e2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const streak = new THREE.Points(streakGeo, streakMat);
    streak.rotation.z = THREE.MathUtils.degToRad(-11);
    scene.add(streak);
    disposables.push(streakGeo, streakMat);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(host);
    else window.addEventListener('resize', resize);

    let imageTexture = null;
    let cancelled = false;
    loadImage(imageUrl)
      .then((img) => {
        if (cancelled) return;
        imageTexture = photoAtlas(img);
        if (!imageTexture) return;
        fragmentMat.uniforms.uAtlas.value = imageTexture;
        fragmentMat.uniforms.uHasPhoto.value = 1;
        fragmentMat.needsUpdate = true;
        disposables.push(imageTexture);
      })
      .catch(() => {
        /* Leave the additive colour fallback; the card still shows the photo. */
      });

    let visible = true;
    let pageVisible = !document.hidden;
    let raf = 0;
    let last = performance.now();
    const clock = new THREE.Clock();
    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) start();
        })
      : null;
    io?.observe(host);

    const onVisibility = () => {
      pageVisible = !document.hidden;
      if (pageVisible) start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    function start() {
      if (raf || !visible || !pageVisible) return;
      last = performance.now();
      raf = requestAnimationFrame(render);
    }

    function render(now) {
      raf = 0;
      if (!visible || !pageVisible) return;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = clock.getElapsedTime();
      const p = clamp01(motionRef?.current?.p ?? 0);
      const swirl = clamp01(motionRef?.current?.swirl ?? 0);
      const storm = smooth(0.46, 0.62, p) * (1 - smooth(0.74, 0.88, p));

      const ringBase = 0.2 + swirl * 0.6;
      ringObjs.forEach((ring, i) => {
        ring.material.opacity = ringBase * (0.82 - i * 0.11);
        ring.rotation.z += dt * (i % 2 === 0 ? 0.045 : -0.035);
        const s = 0.96 + i * 0.035 + Math.sin(t * 0.4 + i) * 0.012 + swirl * 0.15;
        ring.scale.setScalar(s);
      });
      rings.rotation.z = p * 0.55 + swirl * 0.8;

      for (let i = 0; i < fragmentCount; i += 1) {
        const s = seeds[i];
        const lift = clamp01(swirl);
        const radius = (0.25 + s.radius * lift) * (1 + storm * 0.22);
        const a = s.angle + lift * 2.35 + t * 0.1 * s.speed;
        positions[i * 3] = Math.cos(a) * radius;
        positions[i * 3 + 1] = Math.sin(a) * radius * 0.5 + s.y * (0.25 + lift * 0.85);
        positions[i * 3 + 2] = s.z * (0.3 + lift * 0.8);
        angles[i] = s.phase + lift * 3 + t * 0.2;
        alphas[i] = lift * (0.58 + seeded(i, 30) * 0.42);
      }
      fragmentGeo.attributes.position.needsUpdate = true;
      fragmentGeo.attributes.aAngle.needsUpdate = true;
      fragmentGeo.attributes.aAlpha.needsUpdate = true;
      fragmentMat.uniforms.uDpr.value = Math.min(window.devicePixelRatio || 1, 1.5);

      bokeh.material.opacity = storm * 0.55;
      bokeh.rotation.z = t * 0.015;
      sparkles.material.opacity = Math.exp(-Math.pow((p - 0.585) / 0.055, 2)) * 0.95;
      sparkles.rotation.z = -t * 0.02;

      const streakAmt = smooth(0.52, 0.6, p) * (1 - smooth(0.7, 0.8, p));
      streakMat.opacity = streakAmt * 0.8;
      const sp = streakGeo.attributes.position;
      for (let i = 0; i < streakCount; i += 1) {
        const u = i / (streakCount - 1);
        sp.setXYZ(
          i,
          -5.8 + u * 11.6 + (smooth(0.5, 0.7, p) - 0.5) * 1.8,
          1.1 + Math.sin(u * Math.PI) * 1.1,
          0.6
        );
      }
      sp.needsUpdate = true;

      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    }

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      io?.disconnect();
      ro?.disconnect();
      if (!ro) window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      disposables.forEach((d) => d.dispose?.());
      scene.clear();
      renderer.dispose();
    };
  }, [imageUrl, accent, motionRef]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
