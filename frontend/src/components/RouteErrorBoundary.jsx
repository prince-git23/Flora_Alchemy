import React from 'react';

/**
 * Phase 20.0 — route failure recovery.
 *
 * Every page in App.jsx is lazy-loaded, so a route only works if its chunk can
 * still be fetched. After a new deploy the previously-hashed chunk files are
 * gone, and a tab that is still running the old bundle will request a file that
 * no longer exists. That request fails, the dynamic import rejects, and — with
 * nothing above it to catch the error — React unmounts the *entire* tree: the
 * URL changes but the page is completely blank (not even the navbar survives).
 *
 * This boundary is the missing safety net. It does two things:
 *
 * 1. A stale-chunk failure is recovered automatically with a single silent
 *    reload, which brings in the new build. The reload is guarded by the
 *    currently-loaded build id, so a chunk that is genuinely broken for the
 *    *same* build is never retried — that would be an infinite reload loop.
 * 2. Anything it cannot recover (a real render error, or a chunk that is still
 *    missing after the reload) renders a branded, actionable panel with a
 *    retry, instead of a blank screen.
 */

const CHUNK_ERROR_PATTERN =
  /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed/i;

const RELOAD_GUARD_KEY = 'flora_alchemy_chunk_reload_build';

function isChunkLoadError(error) {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  return CHUNK_ERROR_PATTERN.test(String(error.message || error));
}

/**
 * Identifies the build the current tab is running by the hashed entry script in
 * the document. A reload that picks up a new deploy produces a different id, so
 * it earns one more automatic retry; the same id means the failure is real.
 */
function currentBuildId() {
  try {
    const scripts = Array.from(document.querySelectorAll('script[src*="/assets/"]'));
    if (!scripts.length) return 'unknown';
    return scripts.map((s) => s.getAttribute('src')).join('|');
  } catch {
    return 'unknown';
  }
}

export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[route-error] a page failed to load', error, info?.componentStack || '');

    if (!isChunkLoadError(error)) return;

    // Stale-chunk recovery. Guarded by build id so this can never loop.
    try {
      const buildId = currentBuildId();
      const alreadyTried = sessionStorage.getItem(RELOAD_GUARD_KEY) === buildId;
      if (!alreadyTried) {
        sessionStorage.setItem(RELOAD_GUARD_KEY, buildId);
        window.location.reload();
      }
    } catch {
      /* storage unavailable — fall through to the manual recovery UI */
    }
  }

  handleRetry() {
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunkFailure = isChunkLoadError(error);
    const isAdminArea = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');

    const heading = chunkFailure ? "This page couldn't load" : 'Something went wrong on this page';
    const body = chunkFailure
      ? 'A newer version of the site was released while this tab was open. Reloading will bring in the latest version — your cart and checkout details are kept.'
      : 'This section failed to render. You can try again, or head back and continue browsing.';

    return (
      <div
        className="min-h-[50vh] flex items-center justify-center px-4 py-16"
        role="alert"
        aria-live="assertive"
      >
        <div className="w-full max-w-md text-center rounded-2xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] p-8 shadow-sm">
          <h1 className="font-serif text-xl sm:text-2xl text-[var(--color-botanical-text)]">{heading}</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-botanical-muted)]">{body}</p>

          <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-[var(--color-btn)] text-white text-sm font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
            >
              Reload page
            </button>
            {!chunkFailure && (
              <button
                type="button"
                onClick={this.handleRetry}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-[var(--color-botanical-border)] bg-[var(--color-surface-lowest)] text-[var(--color-botanical-primary)] text-sm font-semibold hover:bg-[var(--color-btn-hover-alt)] hover:text-white transition-colors"
              >
                Try again
              </button>
            )}
            <a
              href={isAdminArea ? '/admin/dashboard' : '/shop'}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl text-[var(--color-botanical-primary)] text-sm font-semibold underline underline-offset-4"
            >
              {isAdminArea ? 'Back to dashboard' : 'Back to shop'}
            </a>
          </div>

          {import.meta.env.DEV && (
            <pre className="mt-6 text-left text-[11px] leading-snug text-[var(--color-botanical-muted)] bg-[var(--color-surface-container)] rounded-lg p-3 overflow-auto max-h-40">
              {String(error?.stack || error)}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
