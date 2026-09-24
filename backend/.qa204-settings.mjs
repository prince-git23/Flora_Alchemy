// TEMP QA helper (delete before commit) — enables Pay on Delivery in the
// ISOLATED QA database only, so a full checkout can be completed without
// driving the cross-origin Razorpay iframe. Never run against production.
import 'dotenv/config';
import mongoose from 'mongoose';
import Settings from './models/Settings.js';

const base = process.env.MONGO_URI;
const target = process.env.QA_URI;
if (!target || !base) {
  console.error('QA_URI missing');
  process.exit(1);
}
if (target === base) {
  console.error('REFUSING: QA_URI equals MONGO_URI (would mutate the real database)');
  process.exit(1);
}
console.log('target db:', new URL(target).pathname.slice(1));

await mongoose.connect(target, { dbName: undefined });
const s = await Settings.findOne({ key: 'default' });
if (!s) {
  console.error('no settings doc');
  process.exit(1);
}
s.commerceConfiguration = s.commerceConfiguration || {};
s.commerceConfiguration.paymentMethods = {
  ...(s.commerceConfiguration.paymentMethods || {}),
  upi: true,
  cards: true,
  netbanking: true,
  wallets: true,
  cod: true,
};
s.markModified('commerceConfiguration');
await s.save();
console.log('payments now:', JSON.stringify(s.commerceConfiguration.paymentMethods));
await mongoose.disconnect();
