/**
 * CAMERA POSE — the record a pose-aware reconstruction engine needs, and the
 * rules that keep it honest.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Two callers need the same arithmetic and the same refusal behaviour: the
 * reference studio (which stores a pose on a view) and the capture-set
 * validator (which judges whether the poses of a set agree). Keeping it here
 * means there is ONE definition of a valid pose, and neither service has to
 * import the other.
 *
 * WHAT IS AND IS NOT ACCEPTED
 * ---------------------------
 * A pose is only ever what a HUMAN or an IMPORT stated. There is deliberately
 * no `inferred` source and no estimation path: a guessed camera position is
 * worse than a missing one, because a pose-aware engine trusts it. A partial
 * pose is refused rather than completed with defaults — ReLi3D-style engines
 * read `transform_matrix` + `camera_fov` per frame, and a fabricated FOV makes
 * every reconstructed surface subtly wrong while looking plausible.
 *
 * Units are metres and degrees, camera-to-world, right-handed Y-up — the
 * convention `transforms.json` uses (OPENGL camera convention is the caller's
 * export problem, not a stored fact).
 *
 * `distance` is DERIVED from position and target, never supplied: two numbers
 * that can disagree are a bug waiting for a reviewer to trust the wrong one.
 */

import { ApiError } from '../middleware/errorMiddleware.js';

/** How a pose came to exist. Never 'inferred' — see the note above. */
export const POSE_SOURCES = ['manual', 'imported'];

export const POSE_RULES = {
  /** Degrees. Below 5° is a telephoto toy; above 120° is not a product lens. */
  minFov: 5,
  maxFov: 120,
  /** Metres. A studio capture is 0.2–5 m; these bounds only catch nonsense. */
  minDistance: 0.05,
  maxDistance: 500,
  /** Absurd coordinates are refused rather than stored and plotted. */
  maxCoordinate: 1000,
  /** Degrees. Two views of one product are captured with the same lens. */
  fovSpreadWarning: 5,
  /** Fractional spread of camera distance that suggests a changed rig. */
  distanceSpreadWarning: 0.1,
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function vector(input, field) {
  if (!input || typeof input !== 'object') {
    throw new ApiError(422, `pose.${field} must be an { x, y, z } object.`, 'POSE_INVALID');
  }
  const out = {};
  for (const axis of ['x', 'y', 'z']) {
    const value = input[axis];
    if (!isFiniteNumber(value)) {
      throw new ApiError(422, `pose.${field}.${axis} must be a finite number.`, 'POSE_INVALID');
    }
    if (Math.abs(value) > POSE_RULES.maxCoordinate) {
      throw new ApiError(
        422,
        `pose.${field}.${axis} is ${value}; positions are metres, so |${axis}| must be ≤ ${POSE_RULES.maxCoordinate}.`,
        'POSE_OUT_OF_RANGE'
      );
    }
    out[axis] = value;
  }
  return out;
}

/**
 * Normalise a submitted pose, or throw. `null` clears it (an explicit act).
 *
 * All-or-nothing: position, target and fov are required together. `source`
 * defaults to 'manual' because that is what an unlabelled human entry is.
 */
export function normalisePose(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(422, 'pose must be an object (or null to clear it).', 'POSE_INVALID');
  }

  const position = vector(input.position, 'position');
  const target = vector(input.target, 'target');

  if (!isFiniteNumber(input.fov)) {
    throw new ApiError(
      422,
      'pose.fov must be a finite number of degrees — a pose without a field of view is not a calibrated pose.',
      'POSE_INCOMPLETE'
    );
  }
  if (input.fov < POSE_RULES.minFov || input.fov > POSE_RULES.maxFov) {
    throw new ApiError(
      422,
      `pose.fov must be between ${POSE_RULES.minFov}° and ${POSE_RULES.maxFov}°.`,
      'POSE_OUT_OF_RANGE'
    );
  }

  const distance = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
  if (distance < POSE_RULES.minDistance) {
    throw new ApiError(
      422,
      'pose.position and pose.target are the same point, so the camera has no view direction.',
      'POSE_DEGENERATE'
    );
  }
  if (distance > POSE_RULES.maxDistance) {
    throw new ApiError(
      422,
      `The camera is ${distance.toFixed(1)} m from its target; poses are metres, so this is not a product capture.`,
      'POSE_OUT_OF_RANGE'
    );
  }

  const source = input.source === undefined || input.source === null || input.source === ''
    ? 'manual'
    : String(input.source);
  if (!POSE_SOURCES.includes(source)) {
    throw new ApiError(
      422,
      `pose.source must be one of ${POSE_SOURCES.join(', ')}. A pose is recorded, never inferred.`,
      'POSE_SOURCE_INVALID'
    );
  }

  return {
    position,
    target,
    fov: input.fov,
    distance,
    source,
  };
}

/** True when a stored pose has everything a pose-aware engine reads. */
export function isCompletePose(pose) {
  if (!pose || typeof pose !== 'object') return false;
  if (!isFiniteNumber(pose.fov)) return false;
  for (const field of ['position', 'target']) {
    for (const axis of ['x', 'y', 'z']) {
      if (!isFiniteNumber(pose[field]?.[axis])) return false;
    }
  }
  return POSE_SOURCES.includes(String(pose.source || ''));
}

/**
 * Do the recorded poses of one set describe ONE rigid capture rig?
 *
 * This is the check Phase D/D2's measurement motivates: the three-view Hunyuan
 * run collapsed because the sheet's cells disagreed about scale and framing
 * (aspect 0.82 → 0.60, a slab). Framing itself is a rendering property this
 * server cannot measure from the photograph, but a changing FOV or camera
 * distance is a RECORDED fact, and it is the cheapest detectable proxy for the
 * failure that was actually measured. It only ever warns — a human decides.
 */
export function poseConsistency(poses = []) {
  const complete = poses.filter(isCompletePose);
  if (complete.length < 2) {
    return { count: complete.length, fovSpread: 0, distanceSpread: 0, fovInconsistent: false, distanceInconsistent: false };
  }
  const fovs = complete.map((pose) => pose.fov);
  const distances = complete.map((pose) => pose.distance);
  const fovSpread = Math.max(...fovs) - Math.min(...fovs);
  const meanDistance = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  const distanceSpread = meanDistance > 0 ? (Math.max(...distances) - Math.min(...distances)) / meanDistance : 0;
  return {
    count: complete.length,
    fovSpread,
    distanceSpread,
    fovInconsistent: fovSpread > POSE_RULES.fovSpreadWarning,
    distanceInconsistent: distanceSpread > POSE_RULES.distanceSpreadWarning,
  };
}

export default { normalisePose, isCompletePose, poseConsistency, POSE_SOURCES, POSE_RULES };
