// TEMP QA helper (delete before commit) — sets product price + inventory on the
// ISOLATED database only. Usage: node .qa204-price.mjs <slug> <price> <stock>
import 'dotenv/config';
import mongoose from 'mongoose';
import Product from './models/Product.js';
import Inventory from './models/Inventory.js';

const base = process.env.MONGO_URI;
const target = process.env.QA_URI;
if (!target || target === base) {
  console.error('REFUSING: QA_URI must be set and differ from MONGO_URI');
  process.exit(1);
}
const [slug, priceRaw, stockRaw] = process.argv.slice(2);
await mongoose.connect(target);
const p = await Product.findOne({ slug });
if (!p) { console.error('no product', slug); process.exit(1); }
if (priceRaw !== undefined) p.price = Number(priceRaw);
await p.save();
let invLine = '';
if (stockRaw !== undefined) {
  const inv = await Inventory.findOne({ productSlug: slug });
  if (inv) {
    inv.currentStock = Number(stockRaw);
    inv.availableStock = Math.max(0, Number(stockRaw) - (inv.reservedStock || 0));
    await inv.save();
    invLine = ` stock=${inv.currentStock}`;
  }
}
console.log(`db=${new URL(target).pathname.slice(1)} ${slug} price=${p.price}${invLine}`);
await mongoose.disconnect();
