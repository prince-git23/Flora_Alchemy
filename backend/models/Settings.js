import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    storeName: { type: String, default: 'Flora Alchemy' },
    currency: { type: String, default: 'INR' },
    storeAvailability: { type: String, default: 'open' },
    acceptNewOrders: { type: Boolean, default: true },
    shippingConfiguration: {
      freeShippingThreshold: { type: Number, default: 1999 },
      standardRate: { type: Number, default: 150 },
      standardDays: { type: String, default: '3–5 business days' },
      expressRate: { type: Number, default: 250 },
      expressDays: { type: String, default: '1–2 business days' },
      panIndia: { type: Boolean, default: true },
    },
    customGiftConfiguration: {
      enabled: { type: Boolean, default: true },
      basePrice: { type: Number, default: 1850 },
      note: { type: String, default: '' },
    },
    // Brand/contact metadata (Phase 3D.5 — unified settings authority)
    storeTagline: { type: String, default: 'Handcrafted botanical keepsakes' },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    // Commerce configuration (shipping lives under shippingConfiguration above)
    commerceConfiguration: {
      paymentMethods: {
        upi: { type: Boolean, default: true },
        cards: { type: Boolean, default: true },
        netbanking: { type: Boolean, default: true },
        cod: { type: Boolean, default: false },
        wallets: { type: Boolean, default: true },
      },
      autoConfirmOrders: { type: Boolean, default: true },
      autoAssignShipping: { type: Boolean, default: true },
      trackingEnabled: { type: Boolean, default: true },
      taxEnabled: { type: Boolean, default: false },
      taxRate: { type: Number, default: 0 },
      taxLabel: { type: String, default: 'GST' },
      minimumOrderValue: { type: Number, default: 250 },
      maximumOrderItems: { type: Number, default: 20 },
      orderCancellationWindow: { type: Number, default: 2 },
      returnWindow: { type: Number, default: 7 },
      orderPrefix: { type: String, default: 'FA' },
    },
    // Notification preferences (stored, but no email/SMS delivery exists yet)
    notificationConfiguration: {
      emailNotifications: { type: Boolean, default: true },
      orderConfirmations: { type: Boolean, default: true },
      orderStatusUpdates: { type: Boolean, default: true },
      lowStockAlerts: { type: Boolean, default: true },
      criticalStockAlerts: { type: Boolean, default: true },
      newCustomerRegistrations: { type: Boolean, default: false },
      dailyDigest: { type: Boolean, default: true },
      weeklyReport: { type: Boolean, default: true },
      browserPush: { type: Boolean, default: false },
      smsAlerts: { type: Boolean, default: false },
      alertThresholdLowStock: { type: Number, default: 10 },
      alertThresholdCriticalStock: { type: Number, default: 5 },
      digestTime: { type: String, default: '09:00' },
      reportDay: { type: String, default: 'Monday' },
    },
    isFixture: { type: Boolean, default: true },
    // Phase 22.2 — tenant. Absent = the single pre-migration settings
    // singleton (key 'default'); Phase 22.5+ will store one document per
    // workspace with { key: workspaceSlug, workspaceId }. Server-assigned
    // only (client-supplied workspaceId is scrubbed in server.js).
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      index: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

const Settings = mongoose.model('Settings', settingsSchema);
export default Settings;
