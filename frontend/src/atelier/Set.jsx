import React, { useMemo, useRef } from 'react';
import { RoundedBox, Float, ContactShadows } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ATELIER } from './palette.js';
import { woodTexture, woodRoughnessTexture, paperTexture } from './textures.js';
import { NameCard, useColourLerp } from './Flora.jsx';

/**
 * THE ROOM.
 *
 * A workbench, not a stage: the atelier is meant to read as a place where this
 * gift is actually assembled, so the set is built from the same few honest
 * materials (oak, cotton-rag paper, brass, wax) and lit by a window that the
 * camera never quite leaves.
 *
 * Every mesh here is procedural geometry with a canvas texture. There is no
 * HDRI download and no imported model, so the first 3D frame costs no network
 * request beyond the lazy chunk itself.
 */

/** Oak workbench: a solid top with an apron and four tapered legs. */
export function Workbench({ width = 3.4, depth = 2.1 }) {
  const map = useMemo(() => {
    const texture = new THREE.CanvasTexture(woodTexture({ size: 1024, seed: 7 }));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 1.4);
    texture.anisotropy = 8;
    return texture;
  }, []);

  const roughnessMap = useMemo(() => {
    const texture = new THREE.CanvasTexture(woodRoughnessTexture({ size: 512 }));
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 1.4);
    return texture;
  }, []);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map,
        roughnessMap,
        roughness: 0.74,
        metalness: 0.03,
        color: '#ffffff',
      }),
    [map, roughnessMap]
  );

  return (
    <group>
      <RoundedBox args={[width, 0.11, depth]} radius={0.018} smoothness={3} castShadow receiveShadow position={[0, -0.055, 0]}>
        <primitive object={material} attach="material" />
      </RoundedBox>

      {/* Apron and legs: thinner stock, slightly darker so the top reads as the
          work surface rather than as one extruded slab. */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[0, -0.17, side * (depth / 2 - 0.09)]} castShadow>
          <boxGeometry args={[width - 0.22, 0.12, 0.05]} />
          <meshStandardMaterial color={ATELIER.oakDark} roughness={0.8} />
        </mesh>
      ))}
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sx, sz]) => (
        <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.16), -0.62, sz * (depth / 2 - 0.14)]} castShadow>
          <cylinderGeometry args={[0.042, 0.055, 1.02, 10]} />
          <meshStandardMaterial color={ATELIER.oakDark} roughness={0.82} />
        </mesh>
      ))}
    </group>
  );
}

/** A curved back wall with a window: the source of every shadow in the scene. */
export function StudioShell() {
  const paperMap = useMemo(() => {
    const texture = new THREE.CanvasTexture(paperTexture({ tone: '#efe4d2', size: 512, seed: 12 }));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 2);
    return texture;
  }, []);

  return (
    <group>
      {/* Wall, curved so the room has no visible corner seam behind the table. */}
      <mesh position={[0, 1.1, -1.55]} receiveShadow>
        <cylinderGeometry args={[2.9, 2.9, 3.4, 48, 1, true, Math.PI * 0.62, Math.PI * 0.76]} />
        <meshStandardMaterial map={paperMap} color="#e8dcc8" roughness={0.96} side={THREE.BackSide} />
      </mesh>

      {/* Window: a bright opening the key light belongs to. */}
      <group position={[-1.05, 1.35, -1.42]}>
        <mesh>
          <planeGeometry args={[1.0, 1.5]} />
          <meshBasicMaterial color="#fff3df" />
        </mesh>
        <mesh position={[0, 0, 0.012]}>
          <planeGeometry args={[0.94, 1.44]} />
          <meshBasicMaterial color="#ffe9c9" transparent opacity={0.75} />
        </mesh>
        {[-0.47, 0, 0.47].map((x) => (
          <mesh key={x} position={[x, 0, 0.02]}>
            <boxGeometry args={[0.012, 1.5, 0.012]} />
            <meshStandardMaterial color="#5b4a38" roughness={0.7} />
          </mesh>
        ))}
        <mesh position={[0, 0, 0.02]}>
          <boxGeometry args={[1.02, 0.014, 0.014]} />
          <meshStandardMaterial color="#5b4a38" roughness={0.7} />
        </mesh>
      </group>

      {/* Shelf with stacked stock boxes and a jar of dried stems. */}
      <group position={[1.25, 1.0, -1.38]}>
        <mesh receiveShadow castShadow>
          <boxGeometry args={[0.95, 0.035, 0.26]} />
          <meshStandardMaterial color={ATELIER.oakDark} roughness={0.8} />
        </mesh>
        {[
          [-0.28, 0.09, 0.0, '#d9c9ae'],
          [-0.06, 0.07, 0.01, '#c9b697'],
          [0.24, 0.11, -0.01, '#e2d4bd'],
        ].map(([x, y, z, colour], i) => (
          <mesh key={i} position={[x, y + 0.02, z]} castShadow receiveShadow>
            <boxGeometry args={[0.17, 0.14 + (i % 2) * 0.04, 0.17]} />
            <meshStandardMaterial color={colour} roughness={0.88} />
          </mesh>
        ))}
        <mesh position={[0.42, 0.12, 0]} castShadow>
          <cylinderGeometry args={[0.045, 0.05, 0.19, 14]} />
          <meshStandardMaterial color="#b8ac96" roughness={0.5} metalness={0.05} transparent opacity={0.72} />
        </mesh>
      </group>
    </group>
  );
}

/** Ribbon spool, ink pot with pen, and a stack of cards. */
export function BenchTools({ paletteColour = ATELIER.blush }) {
  const spoolRef = useRef();
  useFrame((_, delta) => {
    if (spoolRef.current) spoolRef.current.rotation.y += delta * 0.06;
  });

  return (
    <group>
      {/* Ribbon spool, left back. */}
      <group position={[-0.85, 0.0, -0.42]} rotation={[0, 0.4, 0]}>
        <mesh position={[0, 0.11, 0]} castShadow>
          <cylinderGeometry args={[0.03, 0.03, 0.22, 12]} />
          <meshStandardMaterial color="#8a6a4a" roughness={0.85} />
        </mesh>
        <mesh ref={spoolRef} position={[0, 0.1, 0]} castShadow>
          <cylinderGeometry args={[0.15, 0.15, 0.13, 28]} />
          <meshStandardMaterial color={paletteColour} roughness={0.62} />
        </mesh>
      </group>

      {/* Ink pot and pen, right back. */}
      <group position={[0.95, 0.0, -0.5]}>
        <mesh position={[0, 0.06, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.075, 0.09, 0.12, 20]} />
          <meshStandardMaterial color="#2b2119" roughness={0.35} metalness={0.15} />
        </mesh>
        <mesh position={[0, 0.125, 0]}>
          <cylinderGeometry args={[0.068, 0.068, 0.008, 20]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.2} metalness={0.4} />
        </mesh>
        <mesh position={[0.09, 0.02, 0.06]} rotation={[0, 0.4, 0.35]} castShadow>
          <cylinderGeometry args={[0.007, 0.0035, 0.36, 8]} />
          <meshStandardMaterial color="#1d1510" roughness={0.4} />
        </mesh>
      </group>

      {/* Stack of cards, front left: the calligraphy station's raw stock. */}
      <group position={[-0.62, 0.005, 0.42]} rotation={[0, -0.24, 0]}>
        {[0, 0.006, 0.012].map((y) => (
          <mesh key={y} position={[0, y, 0]} rotation={[0, y * 8, 0]} receiveShadow castShadow>
            <boxGeometry args={[0.44, 0.005, 0.3]} />
            <meshStandardMaterial color={y === 0.012 ? ATELIER.paper : '#eee3d1'} roughness={0.95} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** The calligraphy station: the finished card, angled toward the camera. */
export function CalligraphyStation({ name }) {
  return (
    <group position={[0.36, 0.012, 0.5]} rotation={[0, -0.32, 0]}>
      <NameCard name={name} />
      {/* The pen rests on the card's corner, out of the text's way. */}
      <mesh position={[0.19, 0.004, -0.1]} rotation={[0, 0.5, 0.12]} castShadow>
        <cylinderGeometry args={[0.0065, 0.003, 0.3, 8]} />
        <meshStandardMaterial color="#20170f" roughness={0.42} metalness={0.1} />
      </mesh>
      <mesh position={[0.32, 0.004, -0.14]} rotation={[0, 0.5, 0.12]} castShadow>
        <cylinderGeometry args={[0.0045, 0.0065, 0.07, 8]} />
        <meshStandardMaterial color={ATELIER.brass} metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  );
}

/** The wax station: the seal stamp standing in its own pool of light. */
export function WaxStation({ sealColour = ATELIER.terracotta, pressed = false }) {
  const stampRef = useRef();
  useFrame((_, delta) => {
    if (!stampRef.current) return;
    const target = pressed ? 0.035 : 0.16;
    stampRef.current.position.y += (target - stampRef.current.position.y) * Math.min(1, delta * 6);
  });

  return (
    <group position={[-0.34, 0.01, 0.5]} rotation={[0, 0.42, 0]}>
      {/* Wax stick. */}
      <mesh position={[0.16, 0.018, -0.08]} rotation={[Math.PI / 2, 0, 0.2]} castShadow>
        <cylinderGeometry args={[0.018, 0.018, 0.3, 12]} />
        <meshStandardMaterial color={sealColour} roughness={0.5} />
      </mesh>
      {/* Brass stamp: handle, shaft, engraved head. */}
      <group ref={stampRef} position={[0, 0.16, 0]}>
        <mesh position={[0, 0.12, 0]} castShadow>
          <sphereGeometry args={[0.055, 20, 16]} />
          <meshStandardMaterial color={ATELIER.brassDark} roughness={0.42} metalness={0.55} />
        </mesh>
        <mesh position={[0, 0.05, 0]} castShadow>
          <cylinderGeometry args={[0.016, 0.016, 0.12, 12]} />
          <meshStandardMaterial color={ATELIER.brass} metalness={0.72} roughness={0.3} />
        </mesh>
        <mesh position={[0, -0.015, 0]} castShadow>
          <cylinderGeometry args={[0.05, 0.05, 0.022, 32]} />
          <meshStandardMaterial color={ATELIER.brass} metalness={0.74} roughness={0.28} />
        </mesh>
      </group>
      {/* Pressed wax pool waiting for the stamp. */}
      <mesh position={[0, 0.004, 0.02]} receiveShadow>
        <cylinderGeometry args={[0.055, 0.06, 0.008, 32]} />
        <meshStandardMaterial color={sealColour} roughness={0.42} />
      </mesh>
    </group>
  );
}

/** Grounding: a soft contact shadow under the composition, tier-gated by the caller. */
export function Grounding({ y = -0.11, opacity = 0.42 }) {
  return (
    <ContactShadows
      position={[0, y, 0]}
      opacity={opacity}
      scale={4.2}
      blur={2.6}
      far={1.2}
      resolution={512}
      color="#2a1d12"
    />
  );
}

/** A single loose petal drifting down — the room is in use, not frozen. */
export function DriftingPetal({ seed = 0, colour = ATELIER.blush }) {
  const ref = useRef();
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.05, 0.02, 0.045, 0.075, 0, 0.09);
    shape.bezierCurveTo(-0.045, 0.075, -0.05, 0.02, 0, 0);
    const g = new THREE.ShapeGeometry(shape, 8);
    g.computeVertexNormals();
    return g;
  }, []);

  /* ONE material per petal, not per render: the scene re-renders on every
     chapter change, and an inline `new Material(...)` here would orphan a
     shader program each time. Colour changes animate through lerp instead. */
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.7, side: THREE.DoubleSide }),
    // Created once; the colour prop is applied by useColourLerp below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const materialRef = useRef(material);
  useColourLerp(materialRef, colour, 2.4);

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime * 0.35 + seed;
    ref.current.position.y = 0.55 + Math.sin(t) * 0.18;
    ref.current.rotation.z = Math.sin(t * 0.8) * 1.2;
    ref.current.rotation.x = Math.cos(t * 0.6) * 0.9;
  });

  return (
    <Float speed={1.1} rotationIntensity={0.6} floatIntensity={0.5}>
      <mesh ref={ref} geometry={geometry} material={material} />
    </Float>
  );
}

export default Workbench;
