import React from 'react';

/**
 * HOMEPAGE HERO — the optional catalogue fields that promote a real product
 * photograph into the pinned index story.
 *
 * This is a form-only component. It never uploads art and never invents a
 * product: an empty cutout/model/turntable is a valid state, and the storefront
 * then uses the product's existing photograph. The fields are additive, so an
 * older product simply has hero=false.
 */
export default function ProductHeroFields({ value, onChange }) {
  const form = value || {};
  const patch = (next) => onChange?.(next);

  return (
    <div className="bg-[var(--color-surface-lowest)] rounded-xl border border-[var(--color-botanical-border)] p-6 shadow-xs">
      <h2 className="font-serif text-lg text-[var(--color-botanical-primary)] font-medium mb-1">
        Homepage Hero
      </h2>
      <p className="text-[12px] text-[var(--color-botanical-subtle)] mb-4">
        Promote this product&apos;s real photograph into the index. At least two hero items are
        required for the animated sequence; with fewer, the homepage keeps its static hero.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.hero === true}
              onChange={(e) => patch({ hero: e.target.checked })}
              className="h-4 w-4 rounded border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] focus:ring-[var(--color-focus)]"
            />
            <span className="text-[12px] font-semibold text-[var(--color-botanical-muted)]">
              Use this product in the homepage hero
            </span>
          </label>
          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1 ml-7">
            Only flagged products enter the hero; Beloved Pieces uses the same ordered set.
          </p>
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">
            Hero order
          </label>
          <input
            type="number"
            min="0"
            value={form.heroOrder ?? 0}
            onChange={(e) => patch({ heroOrder: e.target.value })}
            className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
          />
          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">Lower numbers appear first.</p>
        </div>

        <div>
          <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">
            Accent
          </label>
          <input
            type="text"
            value={form.accent || ''}
            maxLength={7}
            placeholder="#964735"
            onChange={(e) => patch({ accent: e.target.value })}
            className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
          />
          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">
            Optional hex tint; leave empty to sample the photograph.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">
            Hero tagline
          </label>
          <input
            type="text"
            value={form.tagline || ''}
            maxLength={180}
            placeholder="A single line that belongs beside the product name"
            onChange={(e) => patch({ tagline: e.target.value })}
            className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">
            Transparent studio cutout <span className="font-normal">(optional)</span>
          </label>
          <input
            type="url"
            value={form.heroCutout || ''}
            placeholder="https://… or /uploads/…"
            onChange={(e) => patch({ heroCutout: e.target.value })}
            className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
          />
          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">
            Tier 2: a real 2000px PNG/WebP with a clean transparent edge. Empty uses the main photo.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">
            Scan / model <span className="font-normal">(optional)</span>
          </label>
          <input
            type="url"
            value={form.model || ''}
            placeholder="https://…/model.glb"
            onChange={(e) => patch({ model: e.target.value })}
            className="w-full text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
          />
          <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">
            Tier 3: a real photogrammetry GLB under 3 MB. The pipeline stores it; it is never synthesised here.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-[12px] font-semibold text-[var(--color-botanical-muted)] mb-1.5">
            Turntable frames <span className="font-normal">(optional, one URL per line)</span>
          </label>
          <textarea
            rows={3}
            value={Array.isArray(form.turntable) ? form.turntable.join('\n') : ''}
            onChange={(e) =>
              patch({
                turntable: e.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .slice(0, 36),
              })
            }
            placeholder={'https://…/frame-01.webp\nhttps://…/frame-02.webp'}
            className="w-full resize-y text-[13px] bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] focus:border-[var(--color-focus)] rounded-lg px-3 py-2 text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] focus:ring-1 focus:ring-[var(--color-focus)] transition"
          />
        </div>
      </div>
    </div>
  );
}
