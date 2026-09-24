// TEMP QA helper (delete before commit) — counts QA orders in the ISOLATED db.
import 'dotenv/config';
import mongoose from 'mongoose';
import Order from './models/Order.js';

const base = process.env.MONGO_URI;
const target = process.env.QA_URI;
if (!target || target === base) {
  console.error('REFUSING: QA_URI must be set and differ from MONGO_URI');
  process.exit(1);
}
await mongoose.connect(target);
const all = await Order.find({}).lean();
const qa = all.filter((o) => (o.shippingAddress?.address || '').includes('QA Street'));
console.log('db:', new URL(target).pathname.slice(1));
console.log('total orders in db:', all.length);
console.log('QA orders (address contains "QA Street"):', qa.length);
for (const o of qa) {
  console.log(`  ${o.orderId} | total=${o.total} | ${o.paymentMethod}/${o.paymentStatus} | ${o.orderStatus} | ${o.createdAt?.toISOString?.()}`);
}
await mongoose.disconnect();
