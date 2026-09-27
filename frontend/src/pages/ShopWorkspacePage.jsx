import React from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';

/**
 * Phase 22.4 — PUBLIC SHOP PAGE (/shops/:workspaceSlug).
 *
 * Renders the resolved ACTIVE workspace's identity behind its public address.
 * The resolver (ShopWorkspaceGate) has already verified the slug, so this
 * page only ever shows confirmed shops.
 *
 * Phase 22.5 (deferred by design): per-shop catalogue hydration — products,
 * collections and workspace settings are fetched into DataContext keyed by
 * this slug. Until that lands, the page states plainly that the full shop
 * view follows, rather than silently rendering the single-tenant storefront
 * under a multi-tenant URL (which would misattribute another shop's goods).
 */
export default function ShopWorkspacePage() {
  const { workspaceSlug } = useParams();
  const { shop } = useOutletContext() || {};
  const name = shop?.displayName || workspaceSlug || 'Shop';

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-[70vh] py-14 sm:py-20 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-96 h-96 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 -left-24 w-80 h-80 rounded-full bg-[var(--color-botanical-sage-light)]/10 blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-2xl mx-auto px-4 sm:px-6 text-center space-y-6">
        <span className="inline-flex items-center gap-2 bg-[var(--color-surface-high)] px-3.5 py-1 rounded-full">
          <span
            className="material-symbols-outlined text-[15px] text-[var(--color-accent)]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            storefront
          </span>
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--color-accent)]">
            Workspace live
          </span>
        </span>

        <h1 className="font-serif text-[36px] leading-[44px] tracking-[-0.015em] text-[var(--color-botanical-primary)]">
          {name}
        </h1>

        <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] max-w-md mx-auto">
          You are viewing the public address of this workspace:{' '}
          <span className="font-mono text-[14px] font-semibold text-[var(--color-botanical-text)]">
            /shops/{shop?.slug || workspaceSlug}
          </span>
        </p>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-[var(--color-surface-container)] border border-[var(--color-botanical-border)] text-left">
          <span className="material-symbols-outlined text-[20px] text-[var(--color-accent)] mt-0.5">construction</span>
          <p className="text-[12px] leading-relaxed text-[var(--color-botanical-muted)]">
            This workspace is active. Its shopfront — products, collections and
            workspace-specific settings — arrives with the per-shop catalogue
            hydration phase (22.5); until then this address confirms the
            workspace identity only, and deliberately does not borrow the main
            store&rsquo;s catalogue.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link
            to="/"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-btn)] text-white px-6 py-3 text-[13px] font-semibold shadow-md hover:bg-[var(--color-btn-hover)] transition-all active:translate-y-px"
          >
            <span className="material-symbols-outlined text-[18px]">storefront</span>
            Main Storefront
          </Link>
          <Link
            to="/admin/login"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--color-surface-high)] text-[var(--color-botanical-text)] px-6 py-3 text-[13px] font-semibold hover:bg-[var(--color-surface-highest)] transition-all"
          >
            <span className="material-symbols-outlined text-[18px]">badge</span>
            Staff Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
