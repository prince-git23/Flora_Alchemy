/**
 * Shared read-only API contract checks.
 *
 * Two callers, one definition of "the API behaves as documented":
 *
 *   · `scripts/production-probe.mjs` — against a DEPLOYED origin, after a
 *     release, with no token and no writes;
 *   · `scripts/release-boot-gate.mjs` — against a LOCALLY BOOTED server in CI,
 *     so an unbootable or mis-mounted revision fails the build instead of the
 *     deploy.
 *
 * Everything here is a GET (or an unauthenticated POST that must be refused
 * BEFORE any handler runs) — nothing in this file can create, mutate or delete
 * a record.
 */

const DEFAULT_TIMEOUT_MS = 45_000;

async function hit(url, { method = 'GET', headers = {} } = {}) {
  try {
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html or empty body */
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: '', error: err.message };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.api            API origin INCLUDING `/api`
 * @param {string} [opts.web]          frontend origin (skipped when omitted)
 * @param {string} [opts.productSlug]  verify public 3D delivery for this slug
 * @param {boolean} [opts.requireDurableMedia] treat "the media root is inside
 *   the app directory" as a FAILURE. True for a deployed origin (that root is
 *   erased on the next redeploy); false for a locally booted server, where an
 *   app-relative root is the documented development default and failing the
 *   gate for it would be noise.
 * @param {(msg: string) => void} [opts.note] extra narration (e.g. a warning)
 * @returns {Promise<{passed:number, failed:number, failures:string[], unreachable:boolean}>}
 */
export async function runContractChecks({
  api,
  web = '',
  productSlug = '',
  requireDurableMedia = true,
  note = () => {},
}) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  const check = (name, ok, detail = '') => {
    if (ok) {
      passed += 1;
      console.log(`  ✔ ${name}`);
    } else {
      failed += 1;
      failures.push(name);
      console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  const base = api.replace(/\/$/, '');

  console.log('· liveness and readiness');
  const health = await hit(`${base}/health`);
  if (health.status === 0) {
    console.error(`\n✘ the API could not be reached at all: ${health.error}`);
    return { passed, failed: failed + 1, failures: [...failures, 'api unreachable'], unreachable: true };
  }
  check('GET /api/health → 200', health.status === 200, String(health.status));
  check('health identifies the service', health.json?.service === 'flora-alchemy-api', JSON.stringify(health.json));
  check('health includes a timestamp', Boolean(health.json?.time));

  const readiness = await hit(`${base}/readiness`);
  check('GET /api/readiness → 200 (database reachable)', readiness.status === 200, `${readiness.status} ${JSON.stringify(readiness.json)}`);

  console.log('\n· private media roots (reported by the revision itself)');
  const media = health.json?.media;
  if (media === undefined) {
    note('this revision does not report media facts — it predates the storage work.');
  } else {
    check('health reports the reference media root', Boolean(media?.reference), JSON.stringify(media));
    check('health reports the 3D media root', Boolean(media?.threeD), JSON.stringify(media));
    check('no absolute media path is exposed', media?.reference?.path === undefined && media?.threeD?.path === undefined);
    if (typeof media?.reference?.durable === 'boolean') {
      const referenceDurable = media.reference.durable === true;
      const threeDurable = media?.threeD?.durable === true;
      if (requireDurableMedia) {
        check(
          'the reference media root is DURABLE (outside the app directory)',
          referenceDurable,
          `durable=${media.reference.durable} (private media is erased on redeploy while false)`
        );
        check(
          'the 3D media root is DURABLE (outside the app directory)',
          threeDurable,
          `durable=${media?.threeD?.durable}`
        );
      } else {
        check('the reference media root reports its durability', true);
        note(
          `reference media durable=${referenceDurable}, 3D media durable=${threeDurable} ` +
            '(an app-relative root is the documented DEVELOPMENT default; production must set the roots)'
        );
      }
    }
  }

  console.log('\n· staff routes are MOUNTED and gated (401, never 404)');
  for (const [label, path, method] of [
    ['GET  /api/references', '/references?draftKey=probe', 'GET'],
    ['GET  /api/references/engine', '/references/engine', 'GET'],
    ['POST /api/references/attach', '/references/attach', 'POST'],
    ['POST /api/references/cleanup', '/references/cleanup', 'POST'],
    ['GET  /api/3d/provider', '/3d/provider', 'GET'],
    ['GET  /api/3d/products/:slug/studio', '/3d/products/__probe__/studio', 'GET'],
  ]) {
    const res = await hit(`${base}${path}`, { method });
    check(`${label} → 401 UNAUTHORIZED`, res.status === 401 && res.json?.code === 'UNAUTHORIZED', `${res.status} ${res.json?.code || ''}`);
  }

  console.log('\n· public 3D delivery');
  if (productSlug) {
    const pub = await hit(`${base}/3d/products/${encodeURIComponent(productSlug)}/public`);
    check(
      `GET /api/3d/products/${productSlug}/public → 200 with a product3d key`,
      pub.status === 200 && pub.json?.success === true && 'product3d' in (pub.json || {}),
      `${pub.status} ${JSON.stringify(pub.json)}`
    );
    const bogus = await hit(`${base}/3d/products/${encodeURIComponent(productSlug)}/model/000000000000000000000000/glb`);
    check(
      'an unknown 3D asset is 404 ASSET_NOT_FOUND (never 403)',
      bogus.status === 404 && bogus.json?.code === 'ASSET_NOT_FOUND',
      `${bogus.status} ${bogus.json?.code || ''}`
    );
  } else {
    const unknown = await hit(`${base}/3d/products/__probe-unknown-slug__/public`);
    check(
      'an unknown product slug is 404 (the public 3D route is mounted)',
      unknown.status === 404 && unknown.json?.code !== undefined,
      `${unknown.status} ${unknown.json?.code || ''}`
    );
  }

  console.log('\n· unknown paths and CORS posture');
  const notFound = await hit(`${base}/__probe-does-not-exist__`);
  check('an unknown path is 404 NOT_FOUND', notFound.status === 404 && notFound.json?.code === 'NOT_FOUND', `${notFound.status}`);
  const foreign = await hit(`${base}/health`, { headers: { Origin: 'https://probe.invalid' } });
  check(
    'a foreign browser origin is refused with 403 ORIGIN_NOT_ALLOWED',
    foreign.status === 403 && foreign.json?.code === 'ORIGIN_NOT_ALLOWED',
    `${foreign.status} ${foreign.json?.code || ''}`
  );

  if (web) {
    console.log('\n· deployed frontend');
    const index = await hit(`${web.replace(/\/$/, '')}/`);
    check('the frontend index is served (200)', index.status === 200, String(index.status));
    check('the served document is the SPA shell', /<div id="root">/.test(index.text));
    check(
      'the frontend points at this API origin',
      index.text.includes(base.replace('/api', '')) || index.text.includes(base),
      `expected ${base} in the served document`
    );
    const mainMatch = index.text.match(/src="(\/assets\/[^"]+\.js)"/);
    if (mainMatch) {
      const bundle = await hit(`${web.replace(/\/$/, '')}${mainMatch[1]}`);
      check('the main bundle is served (200)', bundle.status === 200, String(bundle.status));
      check('the bundle carries the configured API base', bundle.text.includes(base), `expected ${base} inside ${mainMatch[1]}`);
    } else {
      check('the index references a built bundle', false, 'no /assets/*.js reference found');
    }
  }

  return { passed, failed, failures, unreachable: false };
}
