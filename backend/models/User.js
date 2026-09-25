import mongoose from 'mongoose';

/**
 * User = authentication identity (email + passwordHash + role).
 * Customer = business profile. A User with role 'customer' links to a
 * Customer via customerId. Handlers/admins have no Customer profile.
 */
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['customer', 'handler', 'admin'],
      default: 'customer',
      index: true,
    },
    name: {
      type: String,
      trim: true,
      default: '',
    },
    // Only set when role === 'customer'
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    // Operator account status. Suspended accounts are rejected at login AND
    // on every protected request (authMiddleware checks it server-side).
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED'],
      default: 'ACTIVE',
    },
    statusChangedAt: {
      type: Date,
      default: null,
    },
    isFixture: {
      type: Boolean,
      default: false,
      // Seed/demo accounts are real documents but are flagged so they are
      // never presented to normal users as their own identity.
    },
    // Phase 20.6.1 — the Owner is an ADMINISTRATOR with ownership privileges,
    // not a fourth role. The role enum stays customer/handler/admin; owner-only
      // capabilities (reviewing admin applications) are gated by requireOwner
    // (role === 'admin' AND isOwner). Existing admins are unaffected
    // (default false).
    isOwner: {
      type: Boolean,
      default: false,
      index: true,
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
        delete ret.passwordHash;
        return ret;
      },
    },
  }
);

const User = mongoose.model('User', userSchema);
export default User;
