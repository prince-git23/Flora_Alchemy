import React from 'react';
import { Link } from 'react-router-dom';

/**
 * PHASE 1 — SHOP ATTRIBUTION (one component, every catalogue surface).
 *
 * Answers "which shop does this belong to?" with REAL backend data only:
 * `product.shop = { slug, displayName }` (or `collection.shop`). Nothing is
 * invented — no maker name, no studio fallback, no badge. When the backend
 * could not resolve an ACTIVE shop the component renders NOTHING rather than
 * fabricating an attribution.
 *
 * Used by ProductCard, Product Detail, Search, Gift Finder, the Shop page and
 * the wishlist so every surface reads the identical contract.
 *
 * `variant` only changes typography — never the data.
 */
export default function ShopAttribution({
  shop,
  variant = 'inline',
  className = '',
  linkClassName = '',
  prefix = 'By',
}) {
  if (!shop || !shop.slug) return null;
  const label = shop.displayName || shop.slug;
  const to = `/shops/${encodeURIComponent(shop.slug)}`;

  if (variant === 'block') {
    return (
      <span className={`block min-w-0 ${className}`}>
        <span className="block text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
          {prefix}
        </span>
        <Link
          to={to}
          className={`inline-flex items-center min-h-[24px] text-[13px] font-semibold text-[var(--color-botanical-text)] hover:text-[var(--color-accent)] transition-colors truncate ${linkClassName}`}
        >
          {label}
        </Link>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-baseline gap-1 min-w-0 ${className}`}>
      <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)] shrink-0">
        {prefix}
      </span>
      <Link
        to={to}
        className={`inline-flex items-center min-h-[24px] text-[12px] font-semibold text-[var(--color-botanical-text)] hover:text-[var(--color-accent)] transition-colors truncate ${linkClassName}`}
      >
        {label}
      </Link>
    </span>
  );
}