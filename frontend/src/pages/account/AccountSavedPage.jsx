import React from 'react';
import { Link } from 'react-router-dom';
import { Heart, ShoppingBag, Trash2, ArrowRight } from 'lucide-react';
import { useStore } from '../../context/StoreContext.jsx';
import { isOutOfStock } from '../../services/productService.js';

/**
 * SAVED GIFTS — the customer's wishlist.
 *
 * Reads the SAME workspace-aware wishlist the storefront uses (it is never
 * duplicated into the profile). Removing a piece drops it from the wishlist;
 * a piece that has been retired stays visible so it can be removed honestly
 * rather than vanishing without explanation.
 */
export default function AccountSavedPage() {
  const { wishlist, wishlistUnavailable, toggleWishlist, removeUnavailableFromWishlist, addItemToCart } = useStore();

  const empty = wishlist.length === 0 && wishlistUnavailable.length === 0;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <span className="block text-[11px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
          Saved treasures
        </span>
        <h2 className="font-serif text-[26px] sm:text-[30px] text-[var(--color-botanical-primary)] font-normal tracking-tight">
          Your Saved Gifts
        </h2>
        <p className="text-[14px] text-[var(--color-botanical-muted)]">
          Pieces you’ve set aside for a birthday, an anniversary, or a quiet surprise.
        </p>
      </div>

      {empty && (
        <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl p-10 sm:p-14 text-center border border-[var(--color-botanical-border)] overflow-hidden">
          <div className="absolute -bottom-14 -left-14 w-40 h-40 rounded-full bg-[var(--color-botanical-sage-light)]/15 blur-3xl pointer-events-none" />
          <div className="relative w-14 h-14 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
            <Heart className="w-6 h-6 text-[var(--color-accent)]" />
          </div>
          <h3 className="relative font-serif text-[22px] text-[var(--color-botanical-primary)] mt-4">
            No saved gifts yet
          </h3>
          <p className="relative text-[14px] text-[var(--color-botanical-muted)] mt-2 max-w-md mx-auto">
            Tap the heart on any bloom, card or hamper to keep it here.
          </p>
          <Link
            to="/shop"
            className="relative inline-flex items-center gap-2 mt-6 px-7 py-3 rounded-full bg-[var(--color-btn)] text-white text-[13px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
          >
            Browse the collection <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {wishlist.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {wishlist.map((item) => (
            <li
              key={item.id}
              className="bg-[var(--color-surface-lowest)] rounded-3xl p-4 border border-[var(--color-botanical-border)] shadow-xs flex flex-col gap-3 group hover:shadow-md transition-shadow"
            >
              <div className="relative aspect-square w-full rounded-2xl overflow-hidden bg-[var(--color-surface-low)]">
                <Link to={`/product/${item.id}`}>
                  <img
                    loading="lazy"
                    decoding="async"
                    src={item.images ? item.images[0] : item.image || ''}
                    alt={item.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </Link>
                <button
                  type="button"
                  onClick={() => toggleWishlist(item)}
                  title="Remove from Saved Gifts"
                  aria-label={`Remove ${item.name} from saved gifts`}
                  className="absolute top-3 right-3 w-8 h-8 rounded-full bg-[var(--color-surface-lowest)]/90 shadow-sm flex items-center justify-center text-[var(--color-accent)] hover:scale-110 transition-transform"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                {isOutOfStock(item) && (
                  <span className="absolute bottom-3 left-3 px-2.5 py-0.5 rounded-full bg-[var(--color-danger)] text-[var(--color-surface-bg)] text-[10px] font-bold uppercase tracking-wider">
                    Out of Stock
                  </span>
                )}
              </div>

              <div className="space-y-1 min-w-0">
                <Link
                  to={`/product/${item.id}`}
                  className="font-serif text-[16px] text-[var(--color-botanical-primary)] font-medium hover:text-[var(--color-accent)] transition-colors line-clamp-2"
                >
                  {item.name}
                </Link>
                <p className="text-[15px] font-bold text-[var(--color-botanical-primary)]">
                  ₹{Number(item.price || 0).toLocaleString('en-IN')}
                </p>
              </div>

              <div className="mt-auto flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => addItemToCart(item)}
                  disabled={isOutOfStock(item)}
                  className="flex-1 py-2 rounded-full bg-[var(--color-btn)] text-white hover:bg-[var(--color-btn-hover)] text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ShoppingBag className="w-3.5 h-3.5" />
                  {isOutOfStock(item) ? 'Out of Stock' : 'Move to Bag'}
                </button>
                <Link
                  to={`/product/${item.id}`}
                  className="px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-primary)] text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors"
                >
                  View
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {wishlistUnavailable.length > 0 && (
        <div className="pt-2">
          <h3 className="font-serif text-[18px] text-[var(--color-botanical-subtle)] mb-4">
            No longer available
          </h3>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {wishlistUnavailable.map((id) => (
              <li
                key={id}
                className="bg-[var(--color-surface-low)] rounded-3xl p-6 border border-dashed border-[var(--color-botanical-border)] flex flex-col items-center gap-4 text-center"
              >
                <div className="space-y-1.5">
                  <p className="text-[24px]">🥀</p>
                  <p className="font-serif text-[16px] text-[var(--color-botanical-muted)]">
                    No longer available
                  </p>
                  <p className="text-[12px] text-[var(--color-botanical-subtle)]">
                    This creation was retired from the collection.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeUnavailableFromWishlist(id)}
                  className="px-4 py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] hover:text-[var(--color-botanical-primary)] text-[12px] font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
