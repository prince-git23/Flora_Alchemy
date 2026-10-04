import mongoose from 'mongoose';

/**
 * Custom-request lifecycle.
 *
 * The five pre-existing states (pending · reviewing · quoted · accepted ·
 * declined) are kept exactly as they were so every old document stays valid
 * and every existing flow keeps working. The request-to-payment workflow adds
 * the minimum states it genuinely needs:
 *
 *   pending           → submitted, awaiting studio review          (PENDING_REVIEW)
 *   reviewing         → taken into review (staff claim)            (legacy/optional)
 *   accepted          → studio accepted; building the proposal     (ACCEPTED)
 *   quoted            → proposal sent to the customer              (PROPOSAL_SENT)
 *   payment_pending   → customer accepted the proposal; payment due
 *   paid              → payment verified by the server
 *   in_progress       → fulfillment underway
 *   completed         → fulfilled (terminal)
 *   declined          → studio rejected the request (terminal; REJECTED)
 *   customer_declined → customer declined the proposal (terminal)
 */
export const REQUEST_STATUSES = [
  'pending',
  'reviewing',
  'accepted',
  'quoted',
  'payment_pending',
  'paid',
  'in_progress',
  'completed',
  'declined',
  'customer_declined',
];

/**
 * Valid forward transitions, validated server-side on every write.
 *
 *  · terminal states (declined · customer_declined · completed) accept nothing;
 *  · payment_pending → paid is written ONLY by the payment architecture
 *    (signature verification / webhook), never by a manual status call;
 *  · quoted → payment_pending is written ONLY by the customer accepting the
 *    proposal through the proposal endpoint.
 *
 * The legacy edges (pending → quoted, accepted → quoted without a proposal)
 * are preserved: a studio that quoted a customer outside the builder keeps
 * working, and the pre-workflow smoke suites stay green.
 */
export const REQUEST_TRANSITIONS = {
  pending: ['reviewing', 'accepted', 'quoted', 'declined'],
  reviewing: ['pending', 'accepted', 'quoted', 'declined'],
  accepted: ['quoted', 'in_progress', 'completed', 'declined'],
  quoted: ['accepted', 'payment_pending', 'customer_declined', 'declined'],
  payment_pending: ['paid'],
  paid: ['in_progress', 'completed'],
  in_progress: ['completed'],
  completed: [],
  declined: [],
  customer_declined: [],
};

/** Statuses only the platform writes — rejected on the manual status route. */
export const SYSTEM_ONLY_REQUEST_STATUSES = ['payment_pending', 'paid', 'customer_declined'];

/** True when `to` is a transition the server will accept from `from`. */
export function canTransitionRequest(from, to) {
  const allowed = REQUEST_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const customRequestSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      // compound { customerId, createdAt: -1 } below covers the 'mine' query;
      // no separate single-field index needed (Phase 17 dedup).
    },
    description: {
      type: String,
      required: true,
      maxlength: 2000,
    },
    occasion: {
      type: String,
      default: '',
    },
    budget: {
      type: String,
      default: '',
    },
    colors: {
      type: String,
      default: '',
    },
    desiredDate: {
      type: Date,
    },
    // Stable image REFERENCE (hosted URL). Either an absolute http(s) link the
    // customer pasted, or the URL returned by the validated upload endpoint
    // (ImageKit in production, /uploads/... in the local-storage fallback).
    // Never a raw File object.
    imageUrl: {
      type: String,
      default: '',
      maxlength: 2048,
    },
    status: {
      type: String,
      enum: REQUEST_STATUSES,
      default: 'pending',
    },
    // Internal staff observations — never shipped to customers.
    adminNotes: {
      type: String,
      default: '',
    },
    // Customer-safe reason persisted when the studio rejects a request.
    rejectionReason: {
      type: String,
      default: '',
      maxlength: 500,
    },
    // Proposal communication timestamps (the proposal itself lives in the
    // Proposal collection; these are the request-side milestones).
    proposalSentAt: { type: Date, default: null },
    proposalRespondedAt: { type: Date, default: null },
    // Product context. When a customer starts a request from a catalogue
    // product (\"commission a custom version of this\"), the server stores the
    // product's IDENTITY and derives workspaceId from it — the client never
    // supplies a workspace. A general request from /custom-gifts has neither,
    // so it stays an unassigned platform request until staff triage it.
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    // Frozen display name so the request still reads correctly for staff and
    // the customer even if the product is later renamed or unpublished.
    productName: { type: String, default: '' },
    // Phase 22.2 — tenant. Absent = unscoped; requests remain scoped to
    // their owner customer only (Phase 22.3 adds the workspace dimension).
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
  },
  { timestamps: true }
);

customRequestSchema.index({ status: 1, createdAt: -1 });
// Customer's own request list (GET /custom-requests/mine).
customRequestSchema.index({ customerId: 1, createdAt: -1 });
// Phase 22.5 — workspace-scoped request reads.
customRequestSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
// Requests that started from a specific catalogue product.
customRequestSchema.index({ productId: 1, createdAt: -1 }, { sparse: true });

const CustomRequest = mongoose.model('CustomRequest', customRequestSchema);

export default CustomRequest;
