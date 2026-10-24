import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ATELIER, PALETTES, RIBBONS, SEALS, pick } from './palette.js';
import { waxSealTexture, ribbonTexture, paperTexture, cardTexture } from './textures.js';

/**
 * THE FLORA — every stem, petal and leaf is generated from geometry here.
 *
 * Why procedural: a generated bouquet must also *change* (the palette station
 * recolours it, the ribbon station re-wraps it), and shipping one baked model
 * per palette would freeze the product into four meshes that can drift from the
 * catalogue. Geometry+material also keeps the atelier free of a second asset
 * pipeline and of any downloaded 3D file.
 *
 * The shapes are deliberately stylised botanicals — paper-flower sculpture, the
 * thing the shop actually sells — never a claim to be a photographed rose.
 */

/** A tapered, longitudinally curved petal: the primitive every flower is made of. */
function makePetalGeometry(width = 0.5, length = 1, curl = 0.45, waist = 0.72) {
  const cols = 6;
  const rows = 8;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let r = 0; r <= rows; r += 1) {
    const v = r / rows; // 0 at the base, 1 at the tip
    // Width profile: narrow at the base, widest at the waist, tapering to a tip.
    const profile = Math.sin(Math.PI * Math.min(1, v * waist + 0.06)) * (1 - Math.pow(v, 3) * 0.35);
    for (let cIdx = 0; cIdx <= cols; cIdx += 1) {
      const u = cIdx / cols;
      const x = (u - 0.5) * width * Math.max(0.05, profile);
      const y = v * length;
      // Curl away from the flower's axis, and cup across the width.
      const z = Math.sin(v * Math.PI) * curl * 0.32 - Math.pow(Math.abs(u - 0.5) * 2, 2) * 0.12;
      positions.push(x, y, z);
      uvs.push(u, v);
    }
  }
  for (let r = 0; r < rows; r += 1) {
    for (let cIdx = 0; cIdx < cols; cIdx += 1) {
      const a = r * (cols + 1) + cIdx;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A lanceolate leaf — eucalyptus and the posy's greenery. */
function makeLeafGeometry(length = 1, width = 0.42) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(width, length * 0.25, width * 0.7, length * 0.75, 0, length);
  shape.bezierCurveTo(-width * 0.7, length * 0.75, -width, length * 0.25, 0, 0);
  const geometry = new THREE.ShapeGeometry(shape, 10);
  geometry.translate(0, 0, 0);
  // Cup the leaf so it catches the key light instead of reading as flat paper.
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    pos.setZ(i, -Math.abs(x) * 0.5 + Math.sin((y / length) * Math.PI) * 0.06);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

const petalGeometry = makePetalGeometry(0.46, 0.62, 0.5);
const petalGeometryInner = makePetalGeometry(0.34, 0.42, 0.7);
const leafGeometry = makeLeafGeometry(0.34, 0.09);

/** Smoothly move a material's colour toward a target — never a hard swap. */
export function useColourLerp(ref, target, speed = 3.4) {
  const targetRef = useRef(new THREE.Color(target));
  const initialised = useRef(false);
  targetRef.current.set(target);
  useFrame((_, delta) => {
    const material = ref.current;
    if (!material || !material.color) return;
    if (!initialised.current) {
      material.color.copy(targetRef.current);
      initialised.current = true;
      return;
    }
    material.color.lerp(targetRef.current, Math.min(1, delta * speed));
  });
}

/**
 * A paper rose: three rings of petals at descending scale.
 *
 * `seededRandom` keeps every bloom identical between visits (a bouquet that
 * reshuffles itself on re-render would look like a bug) while still being
 * irregular enough to read as handmade.
 */
function Rose({ position, scale = 1, petalColour, coreColour, rotated = 0, dense = true }) {
  const groupRef = useRef();

  /* ONE material per ring rather than one per petal: a petal-per-material rose
     is ~20 shader programs and 20 colour lerps for the same visual result, and
     the palette station then has twenty things to animate instead of two. */
  const outerMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: petalColour, roughness: 0.72, metalness: 0.02, side: THREE.DoubleSide }),
    // Intentionally created once; colour is animated by useColourLerp below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const innerMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: coreColour, roughness: 0.66, metalness: 0.02, side: THREE.DoubleSide }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const outer = useRef(outerMaterial);
  const inner = useRef(innerMaterial);
  useColourLerp(outer, petalColour);
  useColourLerp(inner, coreColour);

  const petals = useMemo(() => {
    const rows = [];
    const rings = dense ? [{ count: 9, radius: 0.11, tilt: 1.42, scale: 1 }, { count: 7, radius: 0.07, tilt: 1.16, scale: 0.78 }, { count: 5, radius: 0.035, tilt: 0.9, scale: 0.56 }] : [{ count: 7, radius: 0.1, tilt: 1.4, scale: 1 }, { count: 5, radius: 0.05, tilt: 1.0, scale: 0.62 }];
    rings.forEach((ring, ringIndex) => {
      for (let i = 0; i < ring.count; i += 1) {
        const angle = (i / ring.count) * Math.PI * 2 + ringIndex * 0.42;
        rows.push({
          key: `${ringIndex}-${i}`,
          position: [Math.cos(angle) * ring.radius, ringIndex * 0.05, Math.sin(angle) * ring.radius],
          rotation: [ring.tilt, -angle, Math.sin(angle) * 0.16],
          scale: ring.scale,
          inner: ringIndex > 0,
        });
      }
    });
    return rows;
  }, [dense]);

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = rotated + Math.sin(state.clock.elapsedTime * 0.12) * 0.02;
  });

  return (
    <group ref={groupRef} position={position} scale={scale}>
      <mesh material={innerMaterial}>
        <sphereGeometry args={[0.055, 12, 10]} />
      </mesh>
      {petals.map((petal) => (
        <mesh
          key={petal.key}
          geometry={petal.inner ? petalGeometryInner : petalGeometry}
          material={petal.inner ? innerMaterial : outerMaterial}
          position={petal.position}
          rotation={petal.rotation}
          scale={[petal.scale, petal.scale, petal.scale]}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  );
}

/** Eucalyptus: a stem with paired, silvery leaves. */
function Eucalyptus({ position, rotation = 0, leafColour = ATELIER.sage, height = 0.62, pairs = 5 }) {
  const groupRef = useRef();
  const leafMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: leafColour, roughness: 0.8, side: THREE.DoubleSide }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const leafRef = useRef(leafMaterial);
  useColourLerp(leafRef, leafColour, 3);

  const leaves = useMemo(
    () =>
      Array.from({ length: pairs }).flatMap((_, i) => {
        const y = (i + 1) * (height / (pairs + 1));
        return [-1, 1].map((side) => ({
          key: `${i}-${side}`,
          position: [side * 0.055, y, 0],
          rotation: [0.25, side * 1.15, side * 0.5],
          scale: 1 - i * 0.08,
        }));
      }),
    [pairs, height]
  );

  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.z = rotation + Math.sin(state.clock.elapsedTime * 0.35 + position[0]) * 0.012;
    }
  });

  return (
    <group ref={groupRef} position={position} rotation={[0, 0, rotation]}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <cylinderGeometry args={[0.006, 0.009, height, 5]} />
        <meshStandardMaterial color="#6b7351" roughness={0.88} />
      </mesh>
      {leaves.map((leaf) => (
        <mesh key={leaf.key} geometry={leafGeometry} material={leafMaterial} position={leaf.position} rotation={leaf.rotation} scale={leaf.scale} castShadow />
      ))}
    </group>
  );
}

/** Chamomile: a warm dome of florets inside a ring of white petals. */
function Chamomile({ position, petalColour = '#f4efe2', coreColour = '#d9b45a' }) {
  const petals = useMemo(() => Array.from({ length: 11 }).map((_, i) => (i / 11) * Math.PI * 2), []);
  return (
    <group position={position}>
      <mesh castShadow>
        <sphereGeometry args={[0.035, 12, 10]} />
        <meshStandardMaterial color={coreColour} roughness={0.7} />
      </mesh>
      {petals.map((angle, i) => (
        <mesh key={i} geometry={petalGeometryInner} position={[Math.cos(angle) * 0.03, 0.005, Math.sin(angle) * 0.03]} rotation={[1.48, -angle, 0]} scale={[0.6, 0.5, 0.6]} castShadow>
          <meshStandardMaterial color={petalColour} roughness={0.66} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/** Lavender: a slim spike of buds, the shop's most-repeated stem. */
function Lavender({ position, colour = ATELIER.lavender }) {
  const buds = useMemo(() => Array.from({ length: 9 }).map((_, i) => ({ key: i, y: 0.24 + i * 0.026, scale: 1 - i * 0.06 })), []);
  return (
    <group position={position}>
      <mesh position={[0, 0.14, 0]} castShadow>
        <cylinderGeometry args={[0.004, 0.006, 0.3, 5]} />
        <meshStandardMaterial color="#6e7551" roughness={0.9} />
      </mesh>
      {buds.map((bud) => (
        <mesh key={bud.key} position={[Math.sin(bud.key) * 0.008, bud.y, Math.cos(bud.key) * 0.008]} scale={bud.scale} castShadow>
          <sphereGeometry args={[0.016, 8, 6]} />
          <meshStandardMaterial color={colour} roughness={0.78} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * The posy itself: the composition the customer is composing.
 *
 * Props change with the palette station, so colour and wrap are animated rather
 * than swapped (see `useColourLerp`) — a hard cut would read as a page reload.
 */
export function Bouquet({ paletteId = 'mauve', ribbonId = 'frayed-silk', sealId = 'terracotta', monogram = 'FA', proportionate = true }) {
  const palette = pick(PALETTES, paletteId);
  const ribbon = pick(RIBBONS, ribbonId);
  const seal = pick(SEALS, sealId);
  const groupRef = useRef();
  const wrapRef = useRef();
  const ribbonRef = useRef();

  useColourLerp(wrapRef, palette.secondary, 2.6);
  useColourLerp(ribbonRef, ribbon.hex, 3);

  const sealMap = useMemo(() => {
    const texture = new THREE.CanvasTexture(waxSealTexture({ initials: monogram, hex: seal.hex }));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }, [monogram, seal.hex]);

  const wrapMap = useMemo(() => {
    const texture = new THREE.CanvasTexture(paperTexture({ tone: palette.secondary, size: 512, seed: 4 }));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);
    return texture;
  }, [palette.secondary]);

  const ribbonMap = useMemo(() => {
    const texture = new THREE.CanvasTexture(ribbonTexture({ hex: ribbon.hex, kind: ribbon.id }));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);
    return texture;
  }, [ribbon.hex, ribbon.id]);

  useFrame((state) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.24) * 0.012;
    groupRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.5) * 0.004;
  });

  const dense = proportionate;

  return (
    <group ref={groupRef}>
      {/* Wrap: an open cone of cotton-rag paper, wider at the mouth. */}
      <mesh position={[0, -0.12, 0]} castShadow receiveShadow>
        <coneGeometry args={[0.19, 0.46, 26, 1, true]} />
        <meshStandardMaterial ref={wrapRef} map={wrapMap} color={palette.secondary} roughness={0.92} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.34, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.045, 0.05, 16]} />
        <meshStandardMaterial color={palette.secondary} roughness={0.9} />
      </mesh>

      {/* The blooms: two roses as the focal mass, greenery and filler around them. */}
      <Rose position={[-0.075, 0.16, 0.02]} scale={1.02} petalColour={palette.primary} coreColour={palette.secondary} rotated={0.4} dense={dense} />
      <Rose position={[0.085, 0.2, -0.03]} scale={0.86} petalColour={palette.primary} coreColour={palette.foliage} rotated={2.1} dense={dense} />
      <Rose position={[0.0, 0.1, 0.09]} scale={0.7} petalColour={palette.secondary} coreColour={palette.primary} rotated={4.2} dense={dense} />

      <Eucalyptus position={[-0.14, -0.02, -0.05]} rotation={0.34} leafColour={palette.foliage} pairs={dense ? 5 : 3} />
      <Eucalyptus position={[0.16, -0.03, 0.02]} rotation={-0.28} leafColour={palette.foliage} pairs={dense ? 4 : 3} />
      <Chamomile position={[-0.03, 0.24, -0.06]} />
      <Lavender position={[0.12, 0.02, 0.08]} colour={paletteId === 'sage' ? '#9aa77f' : ATELIER.lavender} />
      <Lavender position={[-0.12, 0.04, 0.07]} colour={paletteId === 'terracotta' ? '#c08b72' : ATELIER.lavender} />

      {/* Ribbon: a band around the wrap plus two loose tails. */}
      <mesh ref={ribbonRef} position={[0, -0.2, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[0.115, 0.017, 8, 40]} />
        <meshStandardMaterial map={ribbonMap} color={ribbon.hex} roughness={ribbon.roughness} metalness={0} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.05, -0.31, 0.04]} rotation={[0.2, 0, side * 0.35]} castShadow>
          <boxGeometry args={[0.03, 0.16, 0.004]} />
          <meshStandardMaterial map={ribbonMap} color={ribbon.hex} roughness={ribbon.roughness} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {/* The seal, engraved with the customer's initials and pressed on the ribbon. */}
      <group position={[0, -0.205, 0.115]} rotation={[Math.PI / 2, 0, 0]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.05, 0.052, 0.016, 40]} />
          <meshStandardMaterial
            attach="material-0"
            color={seal.hex}
            roughness={seal.roughness}
            metalness={seal.metallic || 0}
          />
          <meshStandardMaterial
            attach="material-1"
            map={sealMap}
            color="#ffffff"
            roughness={seal.roughness}
            metalness={seal.metallic || 0}
          />
          <meshStandardMaterial attach="material-2" color={seal.hex} roughness={seal.roughness} />
        </mesh>
      </group>
    </group>
  );
}

/** The keepsake hamper: a pine box with a sliding lid and brass hardware. */
function KeepsakeBox({ accent = ATELIER.brass }) {
  return (
    <group position={[0, 0.0, 0]}>
      <mesh position={[0, 0.09, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.52, 0.18, 0.36]} />
        <meshStandardMaterial color="#b08a62" roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.19, 0]} rotation={[0, 0.06, 0]} castShadow>
        <boxGeometry args={[0.54, 0.018, 0.38]} />
        <meshStandardMaterial color="#c49d72" roughness={0.66} />
      </mesh>
      <mesh position={[0, 0.135, 0.181]} castShadow>
        <boxGeometry args={[0.1, 0.03, 0.012]} />
        <meshStandardMaterial color={accent} metalness={0.7} roughness={0.34} />
      </mesh>
      {/* Brass shears resting on the lid — the atelier's own tool. */}
      <group position={[0.16, 0.205, 0.02]} rotation={[0, 0.5, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.19, 0.008, 0.026]} />
          <meshStandardMaterial color={accent} metalness={0.72} roughness={0.32} />
        </mesh>
        <mesh position={[-0.12, -0.004, 0.012]} rotation={[0, 0, 0.2]} castShadow>
          <torusGeometry args={[0.02, 0.004, 6, 16]} />
          <meshStandardMaterial color={accent} metalness={0.72} roughness={0.32} />
        </mesh>
      </group>
    </group>
  );
}

/** The ceramic vessel: speckled stoneware with moss bedding. */
function CeramicVessel({ moss = '#7c8b6d' }) {
  return (
    <group>
      <mesh position={[0, 0.12, 0]} castShadow receiveShadow>
        <latheGeometry
          args={[
            [
              new THREE.Vector2(0.1, 0),
              new THREE.Vector2(0.14, 0.03),
              new THREE.Vector2(0.16, 0.12),
              new THREE.Vector2(0.155, 0.2),
              new THREE.Vector2(0.13, 0.24),
              new THREE.Vector2(0.12, 0.25),
            ],
            32,
          ]}
        />
        <meshStandardMaterial color="#cfc3ae" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.245, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.12, 24]} />
        <meshStandardMaterial color={moss} roughness={0.95} />
      </mesh>
    </group>
  );
}

/** The display stand for a composition: pick the customer's chosen base. */
export function Composition({ baseId = 'keepsake-posy', ...bouquetProps }) {
  if (baseId === 'heirloom-box') {
    return (
      <group position={[0, -0.02, 0]}>
        <KeepsakeBox accent={ATELIER.brass} />
        <group position={[0, 0.25, 0]} scale={0.86}>
          <Bouquet {...bouquetProps} />
        </group>
      </group>
    );
  }
  if (baseId === 'ceramic-pot') {
    return (
      <group position={[0, -0.02, 0]}>
        <CeramicVessel />
        <group position={[0, 0.32, 0]} scale={0.9}>
          <Bouquet {...bouquetProps} />
        </group>
      </group>
    );
  }
  return (
    <group position={[0, 0.28, 0]}>
      <Bouquet {...bouquetProps} />
    </group>
  );
}

/** The card that carries the name — used by the calligraphy station. */
export function NameCard({ name = '' }) {
  const map = useMemo(() => {
    const texture = new THREE.CanvasTexture(cardTexture({ name }));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }, [name]);
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh receiveShadow>
        <planeGeometry args={[0.42, 0.26]} />
        <meshStandardMaterial map={map} roughness={0.95} />
      </mesh>
    </group>
  );
}

export default Bouquet;
