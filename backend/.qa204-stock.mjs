// TEMP QA helper (delete before commit) — sets stock on the ISOLATED database.
// Refuses to run against the real database. Usage: node .qa204-stock.mjs <slug> <stock>
import 'dotenv/config';
import mongoose from 'mongoose';
import Inventory from './models/Inventory.js';

const base = process.env.MONGO_URI;
const target = process.env.QA_URI;
if (!target || target === base) {
  console.error('REFUSING: QA_URI must be set and differ from MONGO_URI');
  process.exit(1);
}
const [slug, stockRaw] = process.argv.slice(2);
if (!slug) {
  console.error('usage: node .qa204-stock.mjs <productSlug> <stock>');
  process.exit(1);
}
const stock = Number(stockRaw);
await mongoose.connect(target);
const inv = await Inventory.findOne({ productSlug: slug });
if (!inv) {
  console.error('no inventory for', slug);
  process.exit(1);
}
inv.currentStock = stock;
inv.availableStock = Math.max(0, stock - (inv.reservedStock || 0));
await inv.save();
console.log(`db=${new URL(target).pathname.slice(1)} ${slug} currentStock=${inv.currentStock} available=${inv.availableStock}`);
await mongoose.disconnect();
