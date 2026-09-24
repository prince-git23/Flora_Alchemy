import React, { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext.jsx';
import PromoBar from './components/PromoBar.jsx';
import Navbar from './components/Navbar.jsx';
import Footer from './components/Footer.jsx';
import MinimalHeader from './components/MinimalHeader.jsx';
import AdminRoute from './components/AdminRoute.jsx';
import RouteErrorBoundary from './components/RouteErrorBoundary.jsx';
import RouteBootstrapGate from './components/RouteBootstrapGate.jsx';

/**
 * Phase 17 — route-level code splitting.
 *
 * Every page is lazy-loaded, so the initial bundle contains only the shell
 * (router, nav, providers) and the code for the route actually visited.
 * The heavy three.js dependency ships with HomePage's chunk only, and the
 * entire admin portal is downloaded only by staff. Route chunks are cached
 * by the browser after first visit; a small shared loader keeps navigation
 * visually continuous.
 */

const HomePage = lazy(() => import('./pages/HomePage.jsx'));
const ShopPage = lazy(() => import('./pages/ShopPage.jsx'));
const ProductPage = lazy(() => import('./pages/ProductPage.jsx'));
const CustomGiftsPage = lazy(() => import('./pages/CustomGiftsPage.jsx'));
const CartPage = lazy(() => import('./pages/CartPage.jsx'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage.jsx'));
const OrderSuccessPage = lazy(() => import('./pages/OrderSuccessPage.jsx'));
const OrderTrackingPage = lazy(() => import('./pages/OrderTrackingPage.jsx'));
const AccountPage = lazy(() => import('./pages/AccountPage.jsx'));
const WishlistPage = lazy(() => import('./pages/WishlistPage.jsx'));
const SearchPage = lazy(() => import('./pages/SearchPage.jsx'));
const CollectionsPage = lazy(() => import('./pages/CollectionsPage.jsx'));
const OurStoryPage = lazy(() => import('./pages/OurStoryPage.jsx'));
const HowItsMadePage = lazy(() => import('./pages/HowItsMadePage.jsx'));
const CustomRequestPage = lazy(() => import('./pages/CustomRequestPage.jsx'));
const FloraJournalPage = lazy(() => import('./pages/FloraJournalPage.jsx'));
const GiftFinderPage = lazy(() => import('./pages/GiftFinderPage.jsx'));
const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));
const ConversationPage = lazy(() => import('./pages/ConversationPage.jsx'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage.jsx'));

// Admin / Handler Pages — never downloaded by storefront visitors.
const AdminDashboardPage = lazy(() => import('./pages/admin/AdminDashboardPage.jsx'));
const AdminOrdersPage = lazy(() => import('./pages/admin/AdminOrdersPage.jsx'));
const AdminOrderDetailPage = lazy(() => import('./pages/admin/AdminOrderDetailPage.jsx'));
const AdminProductsPage = lazy(() => import('./pages/admin/AdminProductsPage.jsx'));
const AdminProductDetailPage = lazy(() => import('./pages/admin/AdminProductDetailPage.jsx'));
const AdminCollectionsPage = lazy(() => import('./pages/admin/AdminCollectionsPage.jsx'));
const AdminCollectionDetailPage = lazy(() => import('./pages/admin/AdminCollectionDetailPage.jsx'));
const AdminCustomersPage = lazy(() => import('./pages/admin/AdminCustomersPage.jsx'));
const AdminCustomerDetailPage = lazy(() => import('./pages/admin/AdminCustomerDetailPage.jsx'));
const AdminInventoryPage = lazy(() => import('./pages/admin/AdminInventoryPage.jsx'));
const AdminInventoryHistoryPage = lazy(() => import('./pages/admin/AdminInventoryHistoryPage.jsx'));
const AdminAnalyticsOverviewPage = lazy(() => import('./pages/admin/AdminAnalyticsOverviewPage.jsx'));
const AdminSalesRevenuePage = lazy(() => import('./pages/admin/AdminSalesRevenuePage.jsx'));
const AdminPerformancePage = lazy(() => import('./pages/admin/AdminPerformancePage.jsx'));
const AdminGeneralSettingsPage = lazy(() => import('./pages/admin/AdminGeneralSettingsPage.jsx'));
const AdminCommerceSettingsPage = lazy(() => import('./pages/admin/AdminCommerceSettingsPage.jsx'));
const AdminAccessPage = lazy(() => import('./pages/admin/AdminAccessPage.jsx'));
const AdminNotificationsPage = lazy(() => import('./pages/admin/AdminNotificationsPage.jsx'));
const AdminStorePreferencesPage = lazy(() => import('./pages/admin/AdminStorePreferencesPage.jsx'));
const AdminLoginPage = lazy(() => import('./pages/admin/AdminLoginPage.jsx'));
const AdminCreateOrderPage = lazy(() => import('./pages/admin/AdminCreateOrderPage.jsx'));
const AdminCreateProductPage = lazy(() => import('./pages/admin/AdminCreateProductPage.jsx'));
const AdminCustomRequestsPage = lazy(() => import('./pages/admin/AdminCustomRequestsPage.jsx'));
const AdminCustomRequestDetailPage = lazy(() => import('./pages/admin/AdminCustomRequestDetailPage.jsx'));
const AdminConversationsPage = lazy(() => import('./pages/admin/AdminConversationsPage.jsx'));

// Brand-consistent chunk loader: same palette/typography as the full-screen
// hydration state in DataContext, but sized to slot into the existing page.
function RouteFallback() {
  return (
    <div className="min-h-[50vh] max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-10 py-8" role="status" aria-live="polite" aria-label="Loading page">
      <div className="space-y-6">
        <div className="space-y-2 max-w-xs">
          <div className="h-6 w-48 rounded-md bg-[var(--color-surface-highest)] animate-pulse" />
          <div className="h-3.5 w-64 rounded-md bg-[var(--color-surface-container)] animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-[var(--color-botanical-border)] overflow-hidden">
              <div className="w-full aspect-[4/3] bg-[var(--color-surface-highest)] animate-pulse" />
              <div className="p-4 space-y-2.5">
                <div className="h-3 w-1/3 rounded-md bg-[var(--color-surface-container)] animate-pulse" />
                <div className="h-4 w-3/4 rounded-md bg-[var(--color-surface-highest)] animate-pulse" />
                <div className="h-3.5 w-1/4 rounded-md bg-[var(--color-surface-container)] animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname } = location;
  const isAdminRoute = pathname.startsWith('/admin');
  // Conversion/auth pages get a focused minimal header instead of the
  // full marketing navigation — the customer stays in the purchase flow.
  const isMinimalRoute = pathname.startsWith('/checkout') || pathname === '/login';

  // Session hardening: when the backend rejects a token (401), the app
  // clears that session and returns the user to the right login screen.
  // Checkout context is preserved so a mid-purchase session expiry returns
  // the customer to checkout after re-authentication.
  useEffect(() => {
    const onAuthExpired = (e) => {
      const scope = e && e.detail && e.detail.scope;
      if (scope === 'admin') {
        if (pathname !== '/admin/login') navigate('/admin/login', { replace: true });
      } else if (scope === 'customer') {
        if (pathname === '/login') return;
        const redirect = pathname.startsWith('/checkout') ? '?redirect=/checkout' : '';
        navigate(`/login${redirect}`, { replace: true });
      }
    };
    window.addEventListener('fa:auth-expired', onAuthExpired);
    return () => window.removeEventListener('fa:auth-expired', onAuthExpired);
  }, [pathname, navigate]);

  return (
    <ThemeProvider>
    <div className="flex flex-col min-h-screen bg-[var(--color-surface-bg)] text-[var(--color-botanical-text)] selection:bg-[#ffdad3] selection:text-[#772f1f]">
      <ScrollToTop />
      {!isAdminRoute && !isMinimalRoute && <PromoBar />}
      {!isAdminRoute && !isMinimalRoute && <Navbar />}
      {!isAdminRoute && isMinimalRoute && <MinimalHeader variant={pathname.startsWith('/checkout') ? 'checkout' : 'auth'} />}

      <main className="flex-grow">
        {/* Keyed by pathname so navigating away clears a failed route. */}
        <RouteErrorBoundary key={pathname}>
        {/* Phase 20.5 — the bootstrap gate lives INSIDE <main>, so the nav,
            footer, theme and background stay visible while the current
            route's own required data loads. It no longer unmounts the app. */}
        <RouteBootstrapGate>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Storefront Routes */}
            <Route path="/" element={<HomePage />} />
            <Route path="/shop" element={<ShopPage />} />
            <Route path="/product/:id" element={<ProductPage />} />
            <Route path="/custom-gifts" element={<CustomGiftsPage />} />
            <Route path="/gift-finder" element={<GiftFinderPage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/checkout" element={<CheckoutPage />} />
            <Route path="/order-success/:orderId" element={<OrderSuccessPage />} />
            <Route path="/order-success" element={<OrderSuccessPage />} />
            <Route path="/order-tracking/:orderId" element={<OrderTrackingPage />} />
            <Route path="/order-tracking" element={<OrderTrackingPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/wishlist" element={<WishlistPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/collections" element={<CollectionsPage />} />
            <Route path="/our-creations" element={<FloraJournalPage />} />
            <Route path="/our-story" element={<OurStoryPage />} />
            <Route path="/how-its-made" element={<HowItsMadePage />} />
            <Route path="/custom-request" element={<CustomRequestPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/order/:orderId/conversation" element={<ConversationPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />

            {/* Admin / Handler Portal Routes */}
            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="/admin/login" element={<AdminLoginPage />} />
            <Route path="/admin/dashboard" element={<AdminRoute><AdminDashboardPage /></AdminRoute>} />
            {/* Commerce */}
            <Route path="/admin/orders" element={<AdminRoute><AdminOrdersPage /></AdminRoute>} />
            <Route path="/admin/orders/:orderId" element={<AdminRoute><AdminOrderDetailPage /></AdminRoute>} />
            <Route path="/admin/orders/:orderId/conversation" element={<AdminRoute><ConversationPage /></AdminRoute>} />
            <Route path="/admin/orders/new" element={<AdminRoute><AdminCreateOrderPage /></AdminRoute>} />
            <Route path="/admin/products" element={<AdminRoute><AdminProductsPage /></AdminRoute>} />
            <Route path="/admin/products/:productId" element={<AdminRoute><AdminProductDetailPage /></AdminRoute>} />
            <Route path="/admin/products/new" element={<AdminRoute><AdminCreateProductPage /></AdminRoute>} />
            <Route path="/admin/collections" element={<AdminRoute><AdminCollectionsPage /></AdminRoute>} />
            <Route path="/admin/collections/:collectionId" element={<AdminRoute><AdminCollectionDetailPage /></AdminRoute>} />
            {/* Operations */}
            <Route path="/admin/customers" element={<AdminRoute><AdminCustomersPage /></AdminRoute>} />
            <Route path="/admin/customers/:customerId" element={<AdminRoute><AdminCustomerDetailPage /></AdminRoute>} />
            {/* Conversations */}
            <Route path="/admin/conversations" element={<AdminRoute><AdminConversationsPage /></AdminRoute>} />
            {/* Custom Request Operations */}
            <Route path="/admin/custom-requests" element={<AdminRoute><AdminCustomRequestsPage /></AdminRoute>} />
            <Route path="/admin/custom-requests/:requestId" element={<AdminRoute><AdminCustomRequestDetailPage /></AdminRoute>} />
            <Route path="/admin/inventory" element={<AdminRoute><AdminInventoryPage /></AdminRoute>} />
            <Route path="/admin/inventory/history" element={<AdminRoute><AdminInventoryHistoryPage /></AdminRoute>} />
            {/* Insights */}
            <Route path="/admin/analytics" element={<AdminRoute><AdminAnalyticsOverviewPage /></AdminRoute>} />
            <Route path="/admin/analytics/sales" element={<AdminRoute><AdminSalesRevenuePage /></AdminRoute>} />
            <Route path="/admin/analytics/performance" element={<AdminRoute><AdminPerformancePage /></AdminRoute>} />
            {/* System */}
            <Route path="/admin/settings" element={<AdminRoute><AdminGeneralSettingsPage /></AdminRoute>} />
            <Route path="/admin/settings/commerce" element={<AdminRoute><AdminCommerceSettingsPage /></AdminRoute>} />
            <Route path="/admin/access" element={<AdminRoute><AdminAccessPage /></AdminRoute>} />
            <Route path="/admin/settings/notifications" element={<AdminRoute><AdminNotificationsPage /></AdminRoute>} />
            <Route path="/admin/store-preferences" element={<AdminRoute><AdminStorePreferencesPage /></AdminRoute>} />

            {/* Wildcard Fallback */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
        </RouteBootstrapGate>
        </RouteErrorBoundary>
      </main>

      {!isAdminRoute && !isMinimalRoute && <Footer />}
    </div>
    </ThemeProvider>
  );
}
