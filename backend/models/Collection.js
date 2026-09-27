import mongoose from 'mongoose';

const collectionSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    occasion: { type: String, default: '' },
    productSlugs: [{ type: String }],
    visibility: {
      type: String,
      enum: ['Visible', 'Hidden'],
      default: 'Visible',
    },
    // Phase 22.2 — tenant. Absent = unscoped; client-supplied workspaceId is
    // scrubbed in server.js. Slug remains globally unique until Phase 22.5.
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true, sparse: true },
    isFixture: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        ret.id = ret.slug;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Phase 22.5 — per-workspace collection identity.
collectionSchema.index({ workspaceId: 1, slug: 1 }, { unique: true });

const Collection = mongoose.model('Collection', collectionSchema);
export default Collection;
