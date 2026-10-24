import React from 'react';

/**
 * THE STATIC ATELIER — the same composition without WebGL.
 *
 * This is not an error page and not a poster: it is the workshop as a composed
 * still built from the storefront's own product photography, and it still
 * reflects the customer's choices (monogram on the seal, wax colour, ribbon
 * colour). A device with no WebGL, save-data on, or a reduced-motion visitor who
 * prefers not to be filmed gets a designed still rather than a blank rectangle,
 * and the station controls beside it keep working exactly as they do in 3D.
 *
 * It is also the Suspense fallback while the cinematic chunk is being fetched,
 * so the section never flashes an empty stage.
 */
export default function AtelierStatic({ config = {}, palette, seal, ribbon, loading = false }) {
  const monogram = (config.monogram || 'FA').slice(0, 3);
  return (
    <div className="absolute inset-0" data-atelier-static data-atelier-static-reason={loading ? 'loading' : 'no-webgl'}>
      {/* Backdrop: a warm pool of lamplight over a paper surface. */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_38%_30%,#6b5236_0%,#3a2b1e_45%,#1e150f_100%)]" aria-hidden="true" />

      {/* The composition: real product photography, stacked as paper layers. */}
      <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <div className="relative aspect-[4/5] w-[min(62vw,30rem)] translate-x-[6%] -translate-y-[4%] opacity-95">
          <img
            src="/assets/images/flora-asset-03.jpg"
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full rounded-[2rem] object-cover shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)]"
            style={{ transform: 'rotate(-2.5deg) scale(0.94)' }}
          />
          <img
            src="/assets/images/flora-asset-09.jpg"
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full rounded-[2rem] object-cover opacity-90 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.85)]"
            style={{ transform: 'translate(9%, 6%) rotate(1.6deg)' }}
          />

          {/* The wrap and the ribbon, drawn as CSS so they carry the choices. */}
          <div
            className="absolute bottom-[6%] left-1/2 h-[42%] w-[52%] -translate-x-1/2 rounded-b-[1.6rem] rounded-t-[40%] shadow-2xl"
            style={{ background: `linear-gradient(160deg, ${palette?.secondary || '#9a7b9b'} 0%, rgba(0,0,0,0.55) 100%)` }}
          />
          <div
            className="absolute bottom-[26%] left-1/2 h-[9%] w-[56%] -translate-x-1/2 rounded-full opacity-95"
            style={{ background: ribbon?.hex || '#b98f7d' }}
          />
          <div
            className="absolute bottom-[18%] left-1/2 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full border border-black/25 font-serif text-lg tracking-[0.12em] text-black/45 shadow-inner"
            style={{ background: `radial-gradient(circle at 38% 32%, ${seal?.hex || '#964735'} 0%, rgba(0,0,0,0.6) 130%)` }}
          >
            {monogram}
          </div>
        </div>
      </div>

      {/* Same film grain as the live stage, so the swap is not obvious. */}
      <div className="atelier-grain pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/45" aria-hidden="true" />
    </div>
  );
}
