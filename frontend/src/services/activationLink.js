/**
 * The activation link a staff step hands to a human — PRESENTATION ONLY.
 *
 * THE ONE AUTHORITY IS THE SERVER. An activation link is built by the backend
 * (backend/utils/publicOrigin.js) from ONE configured origin —
 * `STAFF_PORTAL_URL`, falling back to `CLIENT_URL`, and to localhost in
 * development only. In production a missing or local origin makes the server
 * REFUSE to mint an invitation at all.
 *
 * This module deliberately does NOT build a URL. Deriving one from
 * `window.location.origin` would silently make the browser the authority:
 * whoever happened to open the console through a preview domain, a tunnel, a
 * LAN address or a Vite preview port would decide what an invited colleague
 * receives by email. That is exactly the bug this module exists to prevent.
 *
 * It only CHECKS the server's link, so a misconfigured deployment becomes
 * visible instead of being copied and mailed:
 *
 *   · missing, or not an absolute URL   → the server did not produce a usable
 *                                         link (never silently substitute one)
 *   · a local address while this console
 *     is NOT itself local                → the deployment is misconfigured: a
 *                                         public portal must never hand out a
 *                                         local-only address
 *
 * A local address IS correct when the console itself is running on loopback,
 * which is how local development works.
 */

/** Route the link must point at (frontend/src/App.jsx: /admin/activate/:token). */
export const ACTIVATION_PATH = '/admin/activate/';

/** localhost / loopback / wildcard host, in either bare or URL form. */
export function isLoopbackHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  // Checked before URL parsing on purpose: a bare "localhost:3000" is read by
  // WHATWG URL as the SCHEME "localhost" with an empty hostname.
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i.test(raw)) return true;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

/** The origin this console is actually being served from (null when unknown). */
function consoleOrigin() {
  if (typeof window === 'undefined') return null;
  return window.location.origin || null;
}

/**
 * @param {string|null|undefined} link the `link` exactly as the API returned it
 * @returns {{url: string, ok: boolean, problem: string}}
 *          `url` is the server's link UNCHANGED — this module never rewrites it.
 */
export function inspectActivationLink(link) {
  const url = typeof link === 'string' ? link : '';

  if (!url) {
    return {
      url: '',
      ok: false,
      problem:
        'The server did not return an activation link, so there is nothing to send. ' +
        'Check that STAFF_PORTAL_URL is set to the public frontend origin.',
    };
  }

  if (!/^https?:\/\//i.test(url)) {
    return {
      url,
      ok: false,
      problem:
        'The server returned a token rather than a full link, so it cannot be shown as an ' +
        'activation address. Set STAFF_PORTAL_URL to the public frontend origin and issue ' +
        'the invitation again.',
    };
  }

  const origin = consoleOrigin();
  // Only a deployment can be wrong about this: when the console itself runs on
  // loopback, a loopback link is the correct local address.
  if (origin && !isLoopbackHost(origin) && isLoopbackHost(url)) {
    return {
      url,
      ok: false,
      problem:
        'This deployment is misconfigured: the server issued a local-only activation link ' +
        'while the portal is running on a public domain. Do not send this link. Set ' +
        'STAFF_PORTAL_URL to the public frontend origin and issue the invitation again.',
    };
  }

  return { url, ok: true, problem: '' };
}
