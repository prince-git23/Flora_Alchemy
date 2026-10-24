import React, { Suspense, lazy, useState } from 'react';

/**
 * THE LAZY BOUNDARY.
 *
 * HomePage imports only this file. Everything heavy — three.js, R3F, drei,
 * post-processing — lives behind this `lazy()` boundary, which is what keeps the
 * storefront's entry bundle free of a renderer (the E2E suite asserts exactly
 * that, FLOW 27) and what stops a shop page paying for a workshop it never
 * opens.
 *
 * The placeholder is the section's own typographic frame at the right height,
 * so the page never jumps when the chunk arrives: no layout shift, no spinner
 * theatre in the middle of the homepage.
 */
const AtelierExperience = lazy(() => import('./AtelierExperience.jsx'));

export default function AtelierSection() {
  const [failed, setFailed] = useState(false);

  if (failed) {
    /* A chunk that cannot be fetched (offline, blocked by a proxy, a stale
       deploy) must not take the homepage down with it. The section collapses to
       a single editorial band that links to the studio instead. */
    return (
      <section className="w-full border-y border-[var(--color-botanical-border)] bg-[var(--color-surface-low)] py-16">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <p className="text-[11px] font-semibold tracking-[0.3em] text-[var(--color-accent)] uppercase">The Atelier</p>
          <h2 className="mt-3 font-serif text-3xl text-[var(--color-botanical-primary)]">Compose your keepsake in the studio</h2>
          <p className="mt-3 text-sm text-[var(--color-botanical-muted)]">
            The 3D workshop could not be loaded on this connection. The full Custom Gift Studio is still available.
          </p>
          <a
            href="/custom-gifts"
            className="mt-5 inline-flex rounded-full bg-[var(--color-btn)] px-5 py-2.5 text-sm font-semibold text-[var(--color-surface-bg)]"
          >
            Open the Custom Gift Studio
          </a>
        </div>
      </section>
    );
  }

  return (
    <Suspense
      fallback={
        <section className="relative grid h-[100svh] w-full place-items-center bg-[#241a12] text-white" aria-busy="true">
          <div className="text-center">
            <p className="text-[10px] font-semibold tracking-[0.34em] text-white/45 uppercase">The Atelier</p>
            <p className="mt-3 font-serif text-3xl text-white/80">Preparing the workshop…</p>
          </div>
        </section>
      }
    >
      <ErrorCapture onError={() => setFailed(true)}>
        <AtelierExperience />
      </ErrorCapture>
    </Suspense>
  );
}

/** A local error boundary: the atelier failing is never the homepage failing. */
class ErrorCapture extends React.Component {
  constructor(props) {
    super(props);
    this.state = { broken: false };
  }

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    if (this.state.broken) return null;
    return this.props.children;
  }
}
