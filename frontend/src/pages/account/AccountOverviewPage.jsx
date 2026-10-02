import React, { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { ArrowRight, Package, Heart, MapPin, ShieldCheck, Pencil, User as UserIcon, Mail, Phone, ShoppingBag, Bell, Sparkles } from 'lucide-react';
import EditProfileModal from './EditProfileModal.jsx';
import { useStoreVersion } from '../../hooks/useStoreVersion.js';
import { getOrdersByCustomer, getCustomerFacingStatus, formatDate, formatINR } from '../../services/orderService.js';
import { fetchNotifications } from '../../services/notificationService.js';
import { getMyCustomRequests } from '../../services/customRequestService.js';
import { RequestStatusPill } from '../../components/StatusPill.jsx';
import { useStore } from '../../context/StoreContext.jsx';
import { isOutOfStock } from '../../services/productService.js';

/**
 * MY ACCOUNT — the customer's front door.
 *
 * The essentials only: who you are, your most recent orders, a glance at your
 * saved gifts, and the way into settings. Deliberately NOT a business console —
 * no revenue, no analytics, no inventory, no workspace or role concept.
 */
export default function AccountOverviewPage() {
  useStoreVersion();
  const { profile, account, reload } = useOutletContext();
  const { wishlist, addItemToCart } = useStore();
  const [editOpen, setEditOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [customRequests, setCustomRequests] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [notif, reqs] = await Promise.all([
        fetchNotifications().catch(() => ({ notifications: [] })),
        getMyCustomRequests().catch(() => []),
      ]);
      if (cancelled) return;
      setNotifications(notif.notifications || []);
      setCustomRequests(reqs || []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const name = (profile && profile.name) || (account && account.name) || '';
  const email = (profile && profile.email) || (account && account.email) || '';
  const phone = (profile && profile.phone) || '';
  const customerId = (profile && (profile.id || profile._id)) || (account && account.customerId) || null;
  const addresses = (profile && profile.addresses) || [];
  const defaultAddress = addresses.find((a) => a.isDefault) || addresses[0] || null;
  const orders = customerId ? getOrdersByCustomer(customerId) : [];
  const recentOrders = orders.slice(0, 3);
  const savedPreview = wishlist.slice(0, 4);

  return (
    <div className="space-y-10">
      {/* ── Profile card ────────────────────────────────────────────── */}
      <section className="relative bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] shadow-xs p-6 sm:p-7 overflow-hidden">
        <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center font-serif text-[22px] shrink-0">
              {(name || email || '?').trim().charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h2 className="font-serif text-[22px] text-[var(--color-botanical-primary)] leading-tight truncate">
                {name || 'Welcome'}
              </h2>
              <p className="text-[13px] text-[var(--color-botanical-subtle)] truncate flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 shrink-0" /> {email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors shrink-0 self-start sm:self-auto"
          >
            <Pencil className="w-3.5 h-3.5" /> Edit profile
          </button>
        </div>

        <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
          <MiniStat icon={UserIcon} label="Name" value={name || '—'} />
          <MiniStat icon={Phone} label="Phone" value={phone || 'Not added'} />
          <MiniStat
            icon={MapPin}
            label="Default address"
            value={defaultAddress ? [defaultAddress.city, defaultAddress.state].filter(Boolean).join(', ') || 'Saved' : 'Not added'}
          />
        </div>
      </section>

      {/* ── Recent orders ───────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Recent Orders"
          trailing={orders.length > 0 ? { to: '/account/orders', label: 'View all orders' } : null}
        />
        {recentOrders.length === 0 ? (
          <EmptyCard
            icon={Package}
            title="No orders yet"
            body="Your handcrafted floral orders will appear here once you place one."
            cta={{ to: '/shop', label: 'Browse gifts' }}
          />
        ) : (
          <ul className="space-y-3">
            {recentOrders.map((order) => {
              const orderId = order.orderId || order.id;
              return (
                <li key={orderId}>
                  <Link
                    to={`/order-tracking/${orderId}`}
                    className="flex flex-wrap items-center justify-between gap-3 bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] px-5 py-4 hover:border-[var(--color-accent)] hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]">#{orderId}</span>
                      <span className="text-[12px] text-[var(--color-botanical-subtle)]">
                        {formatDate(order.createdAt || order.date)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="px-2.5 py-1 rounded-full bg-[var(--color-badge-bg)] text-[var(--color-badge-fg)] text-[10px] font-bold uppercase tracking-wider">
                        {getCustomerFacingStatus(order.orderStatus || order.status || 'new')}
                      </span>
                      <span className="text-[14px] font-bold text-[var(--color-botanical-primary)]">
                        {formatINR(order.total || 0)}
                      </span>
                      <ArrowRight className="w-4 h-4 text-[var(--color-botanical-subtle)]" />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Saved gifts ─────────────────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Saved Gifts"
          trailing={wishlist.length > 0 ? { to: '/account/saved', label: 'View saved gifts' } : null}
        />
        {savedPreview.length === 0 ? (
          <EmptyCard
            icon={Heart}
            title="Nothing saved yet"
            body="Tap the heart on any bloom, card or hamper to keep it here."
            cta={{ to: '/shop', label: 'Find a gift' }}
          />
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {savedPreview.map((item) => (
              <li
                key={item.id}
                className="bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] p-3 flex flex-col gap-2 group"
              >
                <Link to={`/product/${item.id}`} className="relative block aspect-square rounded-xl overflow-hidden bg-[var(--color-surface-low)]">
                  <img
                    loading="lazy"
                    decoding="async"
                    src={item.images ? item.images[0] : item.image || ''}
                    alt={item.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </Link>
                <Link
                  to={`/product/${item.id}`}
                  className="font-serif text-[13px] text-[var(--color-botanical-primary)] font-medium hover:text-[var(--color-accent)] transition-colors line-clamp-2"
                >
                  {item.name}
                </Link>
                <div className="mt-auto flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold text-[var(--color-botanical-primary)]">
                    ₹{Number(item.price || 0).toLocaleString('en-IN')}
                  </span>
                  <button
                    type="button"
                    onClick={() => addItemToCart(item)}
                    disabled={isOutOfStock(item)}
                    title="Move to bag"
                    aria-label={`Move ${item.name} to bag`}
                    className="w-7 h-7 rounded-full bg-[var(--color-btn)] text-white flex items-center justify-center hover:bg-[var(--color-btn-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ShoppingBag className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Studio activity (notifications + custom requests) ───────── */}
      {(notifications.length > 0 || customRequests.length > 0) && (
        <section>
          <SectionHeader
            title="From the Studio"
            trailing={notifications.length > 0 ? { to: '/notifications', label: 'All updates' } : null}
          />
          <div className="space-y-3">
            {notifications.slice(0, 2).map((n) => (
              <div
                key={n._id}
                className="flex items-start gap-3 bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] px-5 py-4"
              >
                <span className="w-9 h-9 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center shrink-0">
                  <Bell className="w-4 h-4 text-[var(--color-accent)]" />
                </span>
                <div className="min-w-0">
                  <p className={`text-[13px] leading-snug ${!n.read ? 'font-semibold text-[var(--color-botanical-primary)]' : 'text-[var(--color-botanical-muted)]'}`}>
                    {n.title}
                  </p>
                  {n.message && (
                    <p className="text-[12px] text-[var(--color-botanical-subtle)] mt-0.5 line-clamp-1">{n.message}</p>
                  )}
                </div>
              </div>
            ))}
            {customRequests.slice(0, 2).map((req) => (
              <div
                key={req._id || req.id}
                className="flex flex-wrap items-center justify-between gap-3 bg-[var(--color-surface-lowest)] rounded-2xl border border-[var(--color-botanical-border)] px-5 py-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-9 h-9 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-[var(--color-accent)]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--color-botanical-primary)] line-clamp-1">
                      {req.description}
                    </p>
                    <p className="text-[11px] text-[var(--color-botanical-subtle)]">
                      Custom request · {new Date(req.createdAt).toLocaleDateString('en-IN')}
                    </p>
                  </div>
                </div>
                <RequestStatusPill status={req.status} />
              </div>
            ))}
            <Link
              to="/custom-request"
              className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-accent)] hover:underline"
            >
              Request something bespoke <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </section>
      )}

      {/* ── Account settings summary ────────────────────────────────── */}
      <section>
        <SectionHeader title="Account Settings" />
        <div className="bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] divide-y divide-[var(--color-botanical-border)] overflow-hidden">
          <SettingsRow
            icon={UserIcon}
            title="Profile details"
            body="Name, email and phone"
            to="/account/settings"
          />
          <SettingsRow
            icon={MapPin}
            title="Addresses"
            body={addresses.length > 0 ? `${addresses.length} saved address${addresses.length > 1 ? 'es' : ''}` : 'Add a delivery address'}
            to="/account/settings"
          />
          <SettingsRow
            icon={ShieldCheck}
            title="Security & sign out"
            body={email ? `Signed in as ${email}` : 'Your sign-in identity'}
            to="/account/settings"
          />
        </div>
      </section>

      <EditProfileModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        profile={profile}
        customerId={customerId}
        onSaved={reload}
      />
    </div>
  );
}

function SectionHeader({ title, trailing }) {
  return (
    <div className="flex items-center justify-between gap-4 mb-4">
      <h3 className="font-serif text-[20px] text-[var(--color-botanical-primary)]">{title}</h3>
      {trailing && (
        <Link
          to={trailing.to}
          className="text-[12px] font-semibold text-[var(--color-accent)] hover:underline inline-flex items-center gap-1"
        >
          {trailing.label} <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-2xl bg-[var(--color-surface-low)] border border-[var(--color-botanical-border)] px-4 py-3 min-w-0">
      <span className="flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-widest text-[var(--color-botanical-subtle)]">
        <Icon className="w-3.5 h-3.5" /> {label}
      </span>
      <p className="text-[14px] text-[var(--color-botanical-primary)] mt-1 truncate">{value}</p>
    </div>
  );
}

function EmptyCard({ icon: Icon, title, body, cta }) {
  return (
    <div className="relative bg-[var(--color-surface-lowest)] rounded-3xl border border-[var(--color-botanical-border)] p-8 text-center overflow-hidden">
      <div className="absolute -top-12 -right-12 w-36 h-36 rounded-full bg-[var(--color-badge-bg)]/10 blur-3xl pointer-events-none" />
      <div className="relative w-12 h-12 rounded-full bg-[var(--color-surface-low)] mx-auto flex items-center justify-center">
        <Icon className="w-5 h-5 text-[var(--color-accent)]" />
      </div>
      <p className="relative font-serif text-[18px] text-[var(--color-botanical-primary)] mt-3">{title}</p>
      <p className="relative text-[13px] text-[var(--color-botanical-subtle)] mt-1 max-w-sm mx-auto">{body}</p>
      {cta && (
        <Link
          to={cta.to}
          className="relative inline-flex items-center gap-2 mt-5 px-6 py-2.5 rounded-full bg-[var(--color-btn)] text-white text-[12px] font-semibold hover:bg-[var(--color-btn-hover)] transition-colors"
        >
          {cta.label} <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  );
}

function SettingsRow({ icon: Icon, title, body, to }) {
  return (
    <Link to={to} className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--color-surface-low)] transition-colors group">
      <span className="w-10 h-10 rounded-full bg-[var(--color-surface-low)] flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-[var(--color-accent)]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-[var(--color-botanical-primary)]">{title}</span>
        <span className="block text-[12px] text-[var(--color-botanical-subtle)] truncate">{body}</span>
      </span>
      <ArrowRight className="w-4 h-4 text-[var(--color-botanical-subtle)] group-hover:text-[var(--color-accent)] group-hover:translate-x-0.5 transition-all" />
    </Link>
  );
}
