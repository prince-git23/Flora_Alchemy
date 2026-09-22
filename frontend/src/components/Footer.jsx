import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, ArrowRight } from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';

// Every footer link points at a real, existing route (Phase 3G-A rule:
// no decorative href="#" links, no fake destinations).
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
  const [email, setEmail] = useState('');
  const { showToast } = useStore();

  const handleSubscribe = (e) => {
    e.preventDefault();
    if (email.trim()) {
      // Honest prototype feedback — no email infrastructure exists yet
      // (Phase 3D.5, E-05).
      showToast('Newsletter signup is currently a preview. No email will be sent.');
      setEmail('');
    }
  };

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
                src="/assets/images/flora-asset-27.jpg"
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

            <div className="pt-2">
              <p className="text-[11px] uppercase tracking-wider font-bold text-[var(--color-botanical-muted)]/80 mb-2">
                Join Our Studio Newsletter
              </p>
              <form onSubmit={handleSubscribe} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 max-w-sm">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Your email address"
                  aria-label="Your email address"
                  className="w-full px-4 py-2.5 rounded-full bg-[var(--color-surface-lowest)] text-[13px] text-[var(--color-botanical-text)] placeholder:text-[var(--color-botanical-subtle)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-focus)]"
                  required
                />
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover)] transition-colors text-[12px] font-semibold tracking-wide shrink-0 touch-target flex items-center justify-center"
                >
                  Subscribe
                </button>
              </form>
              <p className="text-[11px] text-[var(--color-botanical-subtle)] mt-2 max-w-sm">
                Preview only — newsletter emails aren't connected yet, so nothing is sent.
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
                    <Link to={link.to} className="hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-0.5">
                      {link.label}
                    </Link>
                  </li>
                ))}
                {col.title === 'Help' && (
                  <li>
                    <Link to="/admin/login" className="text-[12px] text-[#a89f99] hover:text-[var(--color-botanical-primary)] transition-colors inline-block py-0.5">
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
            <Link to="/shop" className="hover:text-[var(--color-botanical-primary)] transition-colors">Curated Catalog</Link>
            <Link to="/custom-gifts" className="hover:text-[var(--color-botanical-primary)] transition-colors">Bespoke Studio</Link>
            <Link to="/order-tracking" className="hover:text-[var(--color-botanical-primary)] transition-colors">Track Order</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
