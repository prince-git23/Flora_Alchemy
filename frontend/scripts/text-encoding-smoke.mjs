/**
 * UI TEXT ENCODING SMOKE — no mojibake may reach the source again.
 *
 * The storefront once shipped literal "â€”", "Â·" and "â‚¹" instead of —, · and ₹,
 * so the empty state rendered gibberish around the price UI. The bytes in the
 * source were simply wrong (UTF-8 read as Windows-1252 and re-saved), which is
 * why the browser displayed them faithfully — nothing was mis-decoded at
 * runtime, so no runtime fix could ever clean it up.
 *
 * The detector is mechanical, not a keyword list: a run of Windows-1252
 * characters that decodes as valid UTF-8 into something DIFFERENT is by
 * definition double-encoded text. That catches sequences a hand-written list
 * would miss (e.g. the emoji "ðŸ¥€" for 🥀).
 *
 *   node scripts/text-encoding-smoke.mjs
 */
import fs from 'fs';
import path from 'path';

const ROOTS = ['src', 'index.html'];
const SKIP = /(^|[\\/])(node_modules|dist|build|coverage)([\\/]|$)/;

// Windows-1252 byte → character (what a cp1252 reader made of the UTF-8 bytes).
const CP1252 = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
};
const TO_BYTE = new Map();
for (let b = 0x20; b <= 0x7e; b++) TO_BYTE.set(String.fromCharCode(b), b);
for (let b = 0x80; b <= 0xff; b++) {
  const ch = CP1252[b] !== undefined ? CP1252[b] : String.fromCharCode(b);
  if (!TO_BYTE.has(ch)) TO_BYTE.set(ch, b);
}
const isHigh = (c) => c.charCodeAt(0) >= 0x80 && TO_BYTE.has(c);

/** Recover mojibake runs on one line: cp1252 chars whose bytes form valid UTF-8. */
export function findMojibake(line) {
  const found = [];
  let i = 0;
  while (i < line.length) {
    if (!isHigh(line[i])) { i++; continue; }
    let run = '';
    while (i < line.length && TO_BYTE.has(line[i])) { run += line[i]; i++; }
    if ([...run].filter(isHigh).length < 2) continue; // not a UTF-8 sequence
    const bytes = Buffer.from([...run].map((ch) => TO_BYTE.get(ch)));
    const decoded = bytes.toString('utf8');
    if (!decoded.includes('\uFFFD') && decoded !== run) found.push({ run, decoded });
  }
  return found;
}

let passed = 0;
const failures = [];
const ok = (name) => { passed += 1; console.log(`  \u2714 ${name}`); };
const bad = (name, detail) => { failures.push(name); console.log(`  \u2718 ${name}\n      ${detail}`); };

const files = [];
const walk = (p) => {
  if (SKIP.test(p)) return;
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
  if (/\.(jsx?|mjs|cjs|json|css|html)$/.test(p)) files.push(p);
};
for (const r of ROOTS) walk(r);

console.log('\n\u2014 SOURCE ENCODING \u2014');

const hits = [];
for (const f of files) {
  const raw = fs.readFileSync(f);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) hits.push({ f, line: 0, why: 'UTF-8 BOM' });
  const text = raw.toString('utf8');
  if (text.includes('\uFFFD')) hits.push({ f, line: 0, why: 'invalid UTF-8 bytes' });
  text.split(/\r?\n/).forEach((line, n) => {
    for (const m of findMojibake(line)) {
      hits.push({ f, line: n + 1, why: `${JSON.stringify(m.run)} should be ${JSON.stringify(m.decoded)}` });
    }
  });
}

if (hits.length === 0) {
  ok(`no mojibake in ${files.length} source files`);
} else {
  for (const h of hits.slice(0, 12)) bad(`${h.f}:${h.line}`, h.why);
  if (hits.length > 12) bad(`${hits.length - 12} further occurrences`, 'see above');
}

console.log('\n\u2014 CURRENCY \u2014');

const shop = fs.readFileSync('src/pages/ShopPage.jsx', 'utf8');
if (shop.includes('\u20B9')) ok('ShopPage renders the Indian Rupee sign (U+20B9)');
else bad('ShopPage rupee sign', 'expected \u20B9 in the price UI');
if (!shop.includes('\u00E2\u201A\u00B9')) ok('ShopPage contains no mojibake rupee');
else bad('ShopPage mojibake rupee', 'found the double-encoded rupee');

const emptyState = /No gifts match these filters/.test(shop);
if (emptyState) ok('the honest empty-catalogue copy is present');
else bad('empty-catalogue copy', 'expected "No gifts match these filters"');

console.log(`\nENCODING RESULT: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`  failed: ${failures.join(' | ')}`);
  process.exit(1);
}
