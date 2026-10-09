import mongoose from 'mongoose';

/**
 * Phase 4 — BOOT RESILIENCE (deployment correctness).
 *
 * The driver's 5s server-selection window is the right value for a live
 * request: a request must fail fast rather than hang. It is the wrong value
 * for a COLD process on a shared cluster, where a single slow SRV/DNS lookup
 * or handshake used to be fatal — the container exited, the platform
 * restarted it, and a transient network hiccup became a crash loop (observed
 * repeatedly against Atlas in Phase 4, both for the suites' isolated servers
 * and for the browser E2E stack).
 *
 * Startup therefore retries the initial connect a bounded number of times,
 * each attempt still using the fail-fast 5s selection timeout, so runtime
 * behaviour is unchanged. Every attempt is logged, and a genuine
 * misconfiguration (bad credentials, wrong host) still exits loudly after the
 * final attempt.
 */

/** Attempts for the INITIAL connect only (runtime selection stays at 5s). */
const BOOT_ATTEMPTS = Math.max(1, Number(process.env.MONGO_CONNECT_ATTEMPTS) || 3);
const SELECTION_TIMEOUT_MS = 5000;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Connect to MongoDB. Throws on failure so server.js can exit loudly.
 */
export async function connectDB(uri = process.env.MONGO_URI) {
  if (!uri) {
    throw new Error('MONGO_URI is not set. Copy backend/.env.example to backend/.env and configure it.');
  }
  mongoose.set('strictQuery', true);

  let lastError = null;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: SELECTION_TIMEOUT_MS });
      return mongoose.connection;
    } catch (err) {
      lastError = err;
      // A refused connect leaves the driver connecting/disconnecting; it must
      // be settled before connect() may be called again.
      await mongoose.disconnect().catch(() => {});
      if (attempt < BOOT_ATTEMPTS) {
        const backoff = 1000 * attempt;
        console.warn(
          `[db] initial connect attempt ${attempt}/${BOOT_ATTEMPTS} failed (${err.message}) — retrying in ${backoff}ms`
        );
        await wait(backoff);
      }
    }
  }
  throw lastError;
}

export function isConnected() {
  return mongoose.connection.readyState === 1;
}
