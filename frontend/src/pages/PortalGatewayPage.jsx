import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Phase 21.1 â€” Portal Access Gateway (/portal).
 *
 * The directory of staff portals, mirroring the reference "Portal Access
 * Gateway" screen. This page is PURE NAVIGATION: choosing a portal only routes
 * to that portal's login form. It never grants a role â€” the server decides
 * whether the authenticated identity may enter the portal it asked for.
 */

const PORTALS = [
  {
    key: 'owner',
    to: '/owner/login',
    tier: 'Tier 01',
    name: 'Owner Portal',
    badge: 'Private Access',
    icon: 'key',
    description:
      'For the business owner and highest-level access. Oversee administrators, staff governance and the live roster.',
    image: '/assets/images/flora-asset-13.jpg',
  },
  {
    key: 'admin',
    to: '/admin/login',
    tier: 'Tier 02',
    name: 'Administrator Portal',
    badge: 'Management',
    icon: 'tune',
    description:
      'For approved administrators managing people, atelier stock logistics and daily operations.',
    image: '/assets/images/flora-asset-05.jpg',
  },
  {
    key: 'staff',
    to: '/staff/login',
    tier: 'Tier 03',
    name: 'Staff Portal',
    badge: 'Operations',
    icon: 'assignment',
    description:
      'For handlers managing daily crafting assignments, custom request notes and fulfilment queues.',
    image: '/assets/images/flora-asset-09.jpg',
  },
];

export default function PortalGatewayPage() {
  return (
    <div className="min-h-screen w-full flex flex-col justify-between bg-[var(--color-surface-bg)]">
      <header className="w-full bg-[var(--color-surface-bg)]/90 backdrop-blur-xl border-b border-[var(--color-botanical-border)] dark:border-[#3a3530]">
        <div className="h-16 max-w-[80rem] mx-auto px-4 md:px-8 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[var(--color-btn)] flex items-center justify-center text-white shadow-sm shrink-0">
              <span className="material-symbols-outlined text-[18px] text-[#ffdad3]">local_florist</span>
            </div>
            <div className="flex flex-col">
              <span className="font-serif text-[18px] leading-none tracking-tight text-[var(--color-botanical-primary)] dark:text-[#f0ede9]">
                Flora Alchemy
              </span>
              <span className="text-[9px] uppercase tracking-widest text-[var(--color-accent)] font-bold mt-1">
                Staff &amp; Access Authority
              </span>
            </div>
          </Link>
          <nav className="hidden sm:flex items-center gap-5">
            {PORTALS.map((p) => (
              <Link
                key={p.key}
                to={p.to}
                className="text-[13px] leading-[18px] font-semibold text-[var(--color-botanical-muted)] hover:text-[var(--color-botanical-text)] transition-colors dark:text-[#b9b1a8] dark:hover:text-[#f0ede9]"
              >
                {p.name.replace(' Portal', ' Login')}
              </Link>
            ))}
            <span className="h-4 w-px bg-[var(--color-botanical-border)] dark:bg-[#3a3530]" />
            <span className="flex items-center gap-1 text-[13px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f0ede9]">
              <span className="material-symbols-outlined text-[16px]">lock_open</span>
              Access Gateway
            </span>
          </nav>
        </div>
      </header>

      <div className="flex-1 w-full flex items-center justify-center py-12 md:py-16 px-4 md:px-8">
        <div className="w-full max-w-[80rem] mx-auto flex flex-col items-center">
          <div className="flex flex-col items-center text-center max-w-2xl mb-10 md:mb-12">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[var(--color-surface-container)] text-[var(--color-accent)] mb-3 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]" />
              <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em]">Portal Access</span>
            </div>
            <h1 className="font-serif text-[38px] md:text-[56px] leading-[1.08] tracking-[-0.02em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] mb-3">
              Where would you like to go?
            </h1>
            <p className="text-[18px] leading-7 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] max-w-xl">
              Choose the workspace you use to manage Flora Alchemy. Each gateway routes to its own authenticated portal â€” your role is decided by the server, never by the link you click.
            </p>
          </div>

          <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 items-stretch">
            {PORTALS.map((p) => (
              <div
                key={p.key}
                className="group relative flex flex-col bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1 shadow-sm hover:shadow-xl border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
              >
                <div className="relative w-full h-48 md:h-56 rounded-xl overflow-hidden bg-[var(--color-surface-container)] mb-6">
                  <img
                    alt={`${p.name} atelier imagery`}
                    className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
                    src={p.image}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#180f0a]/40 via-transparent to-transparent" />
                  <div className="absolute top-3 left-3">
                    <span className="inline-flex items-center px-3 py-1 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-md text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-accent)] shadow-sm">
                      {p.badge}
                    </span>
                  </div>
                  <div className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-md flex items-center justify-center text-[var(--color-botanical-primary)] shadow-sm group-hover:bg-[var(--color-btn)] group-hover:text-white transition-colors">
                    <span className="material-symbols-outlined text-[20px]">{p.icon}</span>
                  </div>
                </div>
                <div className="flex flex-col flex-1">
                  <div className="flex items-baseline justify-between mb-1">
                    <h2 className="font-serif text-[28px] leading-9 tracking-[-0.01em] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                      {p.name}
                    </h2>
                    <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)]">
                      {p.tier}
                    </span>
                  </div>
                  <p className="text-[15px] leading-6 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8] mb-6 flex-1">
                    {p.description}
                  </p>
                  <Link
                    to={p.to}
                    className="w-full py-3.5 px-6 rounded-full bg-[var(--color-btn)] hover:bg-[var(--color-btn-hover)] dark:bg-[#964735] dark:hover:bg-[#a85a48] text-white text-[13px] leading-[18px] font-semibold text-center flex items-center justify-center gap-2 transition-all shadow-md active:translate-y-px"
                  >
                    <span>{p.name}</span>
                    <span className="material-symbols-outlined text-[18px] transition-transform duration-200 group-hover:translate-x-1">arrow_forward</span>
                  </Link>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between w-full mt-12 pt-8 bg-[var(--color-surface-low)]/60 dark:bg-[#221e1a]/60 rounded-2xl px-6 py-5 gap-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-[var(--color-surface-high)] dark:bg-[#33302c] flex items-center justify-center text-[var(--color-accent)]">
                <span className="material-symbols-outlined text-[22px]">storefront</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[18px] leading-[26px] font-semibold text-[var(--color-botanical-primary)] dark:text-[#f7f4ef]">
                  Need the Public Boutique?
                </span>
                <span className="text-[13px] leading-5 text-[var(--color-botanical-muted)] dark:text-[#b9b1a8]">
                  Browse custom velvet flora collections, bespoke gift notes and keepsakes.
                </span>
              </div>
            </div>
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[var(--color-surface-lowest)] dark:bg-[#1e1b18] text-[var(--color-botanical-primary)] dark:text-[#f7f4ef] text-[13px] leading-[18px] font-semibold shadow-sm hover:bg-[var(--color-badge-bg)] transition-colors border border-[var(--color-botanical-border)] dark:border-[#3a3530]"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_back</span>
              <span>Return to Flora Alchemy storefront</span>
            </Link>
          </div>

          <p className="mt-6 text-center text-[13px] leading-5 text-[var(--color-botanical-subtle)] max-w-2xl">
            Gateway selection routes to the designated login endpoint only. Your role, ownership and account status are resolved by the server on authentication.
          </p>
        </div>
      </div>

      <footer className="w-full bg-[var(--color-surface-low)] dark:bg-[#1e1b18] border-t border-[var(--color-botanical-border)] dark:border-[#3a3530]">
        <div className="max-w-[80rem] mx-auto px-4 md:px-8 py-6 flex flex-col md:flex-row items-center justify-between gap-3">
          <span className="text-[13px] leading-5 text-[var(--color-botanical-subtle)]">
            Â© {new Date().getFullYear()} Flora Alchemy Atelier â€” staff access directory
          </span>
          <span className="text-[11px] leading-4 font-bold uppercase tracking-[0.08em] text-[var(--color-botanical-subtle)]">
            Botanical Infrastructure
          </span>
        </div>
      </footer>
    </div>
  );
}
