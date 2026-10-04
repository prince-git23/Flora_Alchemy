import mongoose from 'mongoose';

/**
 * PROPOSAL — the studio's itemised fulfillment quote for ONE custom request.
 *
 *   CustomRequest → Proposal → ProposalItem[]
 *
 * Design rules (Phase: custom request fulfillment workflow):
 *  · ONE proposal document per request (unique customRequestId). Rebuilding a
 *    withdrawn proposal replaces its contents instead of stacking revisions —
 *    the simplest architecture that still keeps an honest customer record.
 *  · Items are ADMIN-DEFINED dynamic line items ("Preserved rose arrangement",
 *    "Personalized name card", …). They are NOT products: nothing here is
 *    written to the catalogue, collections, inventory or public search.
 *  · Every total is computed SERVER-SIDE from the stored items. A client can
 *    never submit a lineTotal/subtotal/total that the server keeps.
 *  · Money is INR whole paise-free rupees (matches the storefront).
 */
export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'withdrawn'];

const proposalItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true, maxlength: 160 },
    description: { type: String, default: '', maxlength: 500 },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    // Server-calculated: quantity × unitPrice. Never trusted from a client.
    lineTotal: { type: Number, required: true, min: 0 },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: true }
);

const proposalSchema = new mongoose.Schema(
  {
    customRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomRequest',
      required: true,
      // One proposal per request. `unique` already builds the index — an extra
      // `index: true` would register a duplicate (mongoose warns on startup).
      unique: true,
    },
    // Denormalised for ownership checks without a join (server-derived).
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    // Workspace that owns the request (server-derived from the request).
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
    currency: { type: String, default: 'INR' },
    items: { type: [proposalItemSchema], default: [] },
    // Server-calculated totals.
    subtotal: { type: Number, default: 0, min: 0 },
    // Shipping follows the SAME rule the existing checkout applies (workspace
    // settings / free-shipping threshold), locked in at send time so the
    // customer pays exactly the total they reviewed.
    shipping: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: PROPOSAL_STATUSES, default: 'draft', index: true },
    sentAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    // Customer-safe reason when the customer declines the proposal.
    declineReason: { type: String, default: '', maxlength: 500 },
    // Set when the customer accepts: the order the proposal became.
    orderId: { type: String, default: '' },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

proposalSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

const Proposal = mongoose.model('Proposal', proposalSchema);

export default Proposal;
