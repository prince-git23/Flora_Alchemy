import React from 'react';
import { Link } from 'react-router-dom';
import { Gift, ArrowRight, Mail } from 'lucide-react';

// Every footer link points at a real, existing route (Phase 3G-A rule:
// no decorative href="#" links, no fake destinations).
//
// PHASE 5 — the newsletter entry form was REMOVED. It accepted an email
// address and answered a "Subscribe" click with a toast saying no email would
// be sent, so the visitor's address was collected by a control that could not
// do what it promised. No newsletter API exists; a status line says so plainly
// instead of imitating a signup.
const FOOTER_COLUMNS = [
  {
    title: 'Shop',
    links: [
      { label: 'All Gifts', to: '/shop' },
      { label: 'Flowers & Bouquets', to: '/shop?category=bouquets' },
      { label: 'Handmade Cards', to: '/shop?category=cards' },
      { label: 'Charms & Keepsakes', to: '/shop?category=charms' },
      { label: 'Hampers', to: '/shop?category=hampers' },
    ],
  },
  {
    title: 'Gifting',
    links: [
      { label: 'Gift Finder', to: '/gift-finder' },
      { label: 'Custom Gift Studio', to: '/custom-gifts' },
      { label: 'Birthday Gifts', to: '/shop?occasion=birthday' },
      { label: 'Anniversary Gifts', to: '/shop?occasion=anniversary' },
      { label: 'Festival Gifts', to: '/shop?occasion=festival' },
    ],
  },
  {
    title: 'About',
    links: [
      { label: 'Our Story', to: '/our-story' },
      { label: "How It's Made", to: '/how-its-made' },
      { label: 'Our Creations', to: '/our-creations' },
      { label: 'Custom Request', to: '/custom-request' },
    ],
  },
  {
    title: 'Help',
    links: [
      { label: 'Order Tracking', to: '/order-tracking' },
      { label: 'Shopping Bag', to: '/cart' },
      { label: 'Saved Gifts', to: '/wishlist' },
      { label: 'My Account', to: '/account' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="w-full bg-[var(--color-surface-low)] border-t border-[var(--color-botanical-border)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 lg:py-20">
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-12 gap-8 sm:gap-10 pb-12 border-b border-[var(--color-botanical-border)]">
          {/* Brand Col */}
          <div className="col-span-2 sm:col-span-2 md:col-span-4 space-y-4">
            <Link to="/" className="flex items-center gap-3" aria-label="Flora Alchemy home">
              <img
                loading="lazy"
                decoding="async"
                src="/branding/flora-alchemy-logo.jpg"
                alt=""
                className="h-7 w-auto object-contain"
              />
              <span className="font-serif text-[22px] tracking-tight font-medium text-[var(--color-botanical-primary)]">
                Flora Alchemy
              </span>
            </Link>
            <p className="text-[14px] leading-relaxed text-[var(--color-botanical-muted)] max-w-sm">
              Handcrafted pipe-cleaner floral art, deckled botanical cards, and personalized gift keepsakes made to endure through quiet seasons.
            </p>

            <Link
              to="/gift-finder"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] border border-[var(--color-botanical-border)] hover:border-[#964735] transition-colors group text-left"
            >
              <Gift className="w-4 h-4 text-[var(--color-accent)] shrink-0" aria-hidden="true" />
              <span className="text-[12px] font-semibold text-[var(--color-botanical-primary)]">Not sure what to gift? Use Gift Finder</span>
              <ArrowRight className="w-3.5 h-3.5 text-[var(--color-botanical-subtle)] group-hover:text-[var(--color-accent)] transition-colors shrink-0" aria-hidden="true" />
            </Link>

            {/* PHASE 5 — no email field and no Subscribe button until a real
                newsletter service exists. A status line is honest; a form that
                discards the address is not. */}
            <div className="pt-2">
              <p className="text-[11px] uppercase tracking-wider font-bold text-[var(--color-botanical-muted)]/80 mb-2">
                Studio Newsletter
              </p>
              <p className="flex items-start gap-2 max-w-sm text-[13px] leading-relaxed text-[var(--color-botanical-muted)]">
                <Mail className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-accent)]" aria-hidden="true" />
                <span>Coming soon — new pieces and seasonal studio notes will be shared here. There is no signup yet.</span>
              </p>
            </div>
          </div>

          {/* Link Columns */}
          {FOOTER_COLUMNS.map((col) => (
            <nav key={col.title} className="col-span-1 md:col-span-2 space-y-3" aria-label={col.title}>
              <h3 className="text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-text)]">{col.title}</h3>
              <ul className="space-y-2 text-[13px] text-[var(--color-botanical-muted)]">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link to={link.to} className="hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-1">
                      {link.label}
                    </Link>
                  </li>
                ))}
                {col.title === 'Help' && (
                  <li>
                    <Link to="/admin/login" className="text-[12px] text-[#a89f99] hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-1">
                      Staff / Admin Login
                    </Link>
                  </li>
                )}
              </ul>
            </nav>
          ))}
        </div>

        {/* Bottom copyright */}
        <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-[13px] text-[var(--color-botanical-muted)] text-center sm:text-left">
          <p>© 2025 Flora Alchemy. All rights reserved. Handcrafted in India.</p>
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
            <Link to="/shop" className="hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-1">Curated Catalog</Link>
            <Link to="/custom-gifts" className="hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-1">Bespoke Studio</Link>
            <Link to="/order-tracking" className="hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-1">Track Order</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
