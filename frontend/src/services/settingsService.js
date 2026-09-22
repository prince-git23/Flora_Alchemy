import api from './apiClient.js';
import { store, signalDataChanged, commitStore } from './dataStore.js';

/**
 * Phase 3C — store configuration now persists in MongoDB via GET/PATCH
 * /api/settings. The service normalizes the backend document into the shape
 * existing storefront/admin components expect. Nothing is reported "saved"
 * until the server confirms.
 */
export function getSettings() {
  const s = store.settings;
  if (!s) return null;
  const shipping = s.shippingConfiguration || {};
  const commerce = s.commerceConfiguration || {};
  const notifications = s.notificationConfiguration || {};
  return {
    storeName: s.storeName || 'Flora Alchemy',
    storeTagline: s.storeTagline || '',
    currency: s.currency || 'INR',
    currencySymbol: '₹',
    timezone: s.timezone || 'Asia/Kolkata',
    storeStatus: s.storeAvailability !== 'closed',
    storeAvailability: s.storeAvailability || 'open',
    acceptNewOrders: s.acceptNewOrders !== false,
    contactEmail: s.contactEmail || '',
    contactPhone: s.contactPhone || '',
    shippingEnabled: shipping.panIndia !== false,
    freeShippingAbove: shipping.freeShippingThreshold ?? 1999,
    standardShippingRate: shipping.standardRate ?? 0,
    expressShippingRate: shipping.expressRate ?? 149,
    shippingConfiguration: shipping,
    customGiftsEnabled: (s.customGiftConfiguration || {}).enabled !== false,
    customGiftConfiguration: s.customGiftConfiguration || {},
    commerceConfiguration: commerce,
    // Commerce page shape
    paymentMethods: commerce.paymentMethods || { upi: true, cards: true, netbanking: true, cod: false, wallets: true },
    autoConfirmOrders: commerce.autoConfirmOrders !== false,
    autoAssignShipping: commerce.autoAssignShipping !== false,
    trackingEnabled: commerce.trackingEnabled !== false,
    taxEnabled: !!commerce.taxEnabled,
    taxRate: commerce.taxRate ?? 0,
    taxLabel: commerce.taxLabel || 'GST',
    minimumOrderValue: commerce.minimumOrderValue ?? 250,
    maximumOrderItems: commerce.maximumOrderItems ?? 20,
    orderCancellationWindow: commerce.orderCancellationWindow ?? 2,
    returnWindow: commerce.returnWindow ?? 7,
    orderPrefix: commerce.orderPrefix || 'FA',
    // Notifications page shape
    emailNotifications: notifications.emailNotifications !== false,
    orderConfirmations: notifications.orderConfirmations !== false,
    orderStatusUpdates: notifications.orderStatusUpdates !== false,
    lowStockAlerts: notifications.lowStockAlerts !== false,
    criticalStockAlerts: notifications.criticalStockAlerts !== false,
    newCustomerRegistrations: !!notifications.newCustomerRegistrations,
    dailyDigest: notifications.dailyDigest !== false,
    weeklyReport: notifications.weeklyReport !== false,
    browserPush: !!notifications.browserPush,
    smsAlerts: !!notifications.smsAlerts,
    alertThresholdLowStock: notifications.alertThresholdLowStock ?? 10,
    alertThresholdCriticalStock: notifications.alertThresholdCriticalStock ?? 5,
    digestTime: notifications.digestTime || '09:00',
    reportDay: notifications.reportDay || 'Monday',
    lastModified: s.updatedAt || new Date().toISOString(),
  };
}

export async function updateSettings(updates) {
  const body = {};
  if (updates.storeName !== undefined) body.storeName = updates.storeName;
  if (updates.storeStatus !== undefined || updates.storeAvailability !== undefined) {
    body.storeAvailability =
      updates.storeAvailability ||
      (updates.storeStatus ? 'open' : 'closed');
  }
  if (updates.acceptNewOrders !== undefined) body.acceptNewOrders = !!updates.acceptNewOrders;
  if (updates.currency !== undefined) body.currency = updates.currency;
  if (
    updates.shippingConfiguration !== undefined ||
    updates.freeShippingAbove !== undefined ||
    updates.standardShippingRate !== undefined ||
    updates.expressShippingRate !== undefined
  ) {
    const current = getSettings() || {};
    body.shippingConfiguration = {
      ...(current.shippingConfiguration || {}),
      ...(updates.shippingConfiguration || {}),
      freeShippingThreshold: updates.freeShippingAbove ?? updates.shippingConfiguration?.freeShippingThreshold ?? current.shippingConfiguration?.freeShippingThreshold,
      standardRate: updates.standardShippingRate ?? updates.shippingConfiguration?.standardRate ?? current.shippingConfiguration?.standardRate,
      expressRate: updates.expressShippingRate ?? updates.shippingConfiguration?.expressRate ?? current.shippingConfiguration?.expressRate,
    };
  }
  if (updates.customGiftsEnabled !== undefined || updates.customGiftConfiguration !== undefined) {
    const current = getSettings() || {};
    body.customGiftConfiguration = {
      ...(current.customGiftConfiguration || {}),
      ...(updates.customGiftConfiguration || {}),
      enabled:
        updates.customGiftsEnabled ??
        updates.customGiftConfiguration?.enabled ??
        current.customGiftConfiguration?.enabled,
    };
  }
  if (updates.storeTagline !== undefined) body.storeTagline = updates.storeTagline;
  if (updates.contactEmail !== undefined) body.contactEmail = updates.contactEmail;
  if (updates.contactPhone !== undefined) body.contactPhone = updates.contactPhone;
  if (updates.timezone !== undefined) body.timezone = updates.timezone;

  // Commerce configuration (shipping handled above; the rest maps to the
  // backend commerceConfiguration blob).
  const commerceKeys = [
    'paymentMethods', 'autoConfirmOrders', 'autoAssignShipping', 'trackingEnabled',
    'taxEnabled', 'taxRate', 'taxLabel', 'minimumOrderValue', 'maximumOrderItems',
    'orderCancellationWindow', 'returnWindow', 'orderPrefix',
  ];
  if (updates.commerceConfiguration !== undefined || commerceKeys.some((k) => updates[k] !== undefined)) {
    const current = getSettings() || {};
    body.commerceConfiguration = {
      ...(current.commerceConfiguration || {}),
      ...(updates.commerceConfiguration || {}),
    };
    commerceKeys.forEach((k) => {
      if (updates[k] !== undefined) body.commerceConfiguration[k] = updates[k];
    });
  }

  // Notification configuration.
  const notificationKeys = [
    'emailNotifications', 'orderConfirmations', 'orderStatusUpdates', 'lowStockAlerts',
    'criticalStockAlerts', 'newCustomerRegistrations', 'dailyDigest', 'weeklyReport',
    'browserPush', 'smsAlerts', 'alertThresholdLowStock', 'alertThresholdCriticalStock',
    'digestTime', 'reportDay',
  ];
  if (updates.notificationConfiguration !== undefined || notificationKeys.some((k) => updates[k] !== undefined)) {
    const current = getSettings() || {};
    body.notificationConfiguration = {
      ...(current.notificationConfiguration || {}),
      ...(updates.notificationConfiguration || {}),
    };
    notificationKeys.forEach((k) => {
      if (updates[k] !== undefined) body.notificationConfiguration[k] = updates[k];
    });
  }

  const res = await api.patch('/settings', body, { scope: 'admin' });
  if (!res.ok) throw new Error(res.message || 'Settings could not be saved.');
  store.settings = res.data.settings;
  commitStore();
  signalDataChanged('data', ['settings']);
  return getSettings();
}

export function resetSettings() {
  throw new Error('Resetting to defaults requires a backend operation — use updateSettings.');
}

export function getShippingCost(subtotal) {
  const settings = getSettings();
  if (!settings) return 0;
  if (subtotal >= settings.freeShippingAbove) return 0;
  return settings.standardShippingRate;
}

export function isStoreOpen() {
  const s = getSettings();
  return s ? s.storeStatus : true;
}
