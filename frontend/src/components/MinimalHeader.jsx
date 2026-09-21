import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * Focused header for conversion/auth pages (checkout, login, register).
 * Replaces the full storefront PromoBar/Navbar so the customer stays
 * in the purchase or sign-in flow instead of being re-marketed to.
 */
export default function MinimalHeader({ variant = 'auth' }) {
  const isCheckout = variant === 'checkout';

  return (
    <header className="w-full bg-[var(--color-surface-lowest)] border-b border-[var(--color-botanical-border)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3" aria-label="Flora Alchemy home">
          <img
            loading="lazy"
            decoding="async"
            src="/assets/images/flora-asset-27.jpg"
            alt="Flora Alchemy"
            className="h-7 w-auto object-contain"
          />
          <span className="font-serif text-[20px] tracking-tight font-medium text-[var(--color-botanical-primary)]">
            Flora Alchemy
          </span>
        </Link>

        {isCheckout ? (
          <Link
            to="/cart"
            className="text-[12px] font-semibold text-[#964735] hover:underline"
          >
            Return to Cart
          </Link>
        ) : (
          <Link
            to="/"
            className="text-[12px] font-semibold text-[#964735] hover:underline flex items-center gap-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Shop
          </Link>
        )}
      </div>
    </header>
  );
}