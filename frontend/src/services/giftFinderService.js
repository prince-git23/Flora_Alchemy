/**
 * Phase 3G-A — Gift Finder recommendation engine.
 *
 * DETERMINISTIC + EXPLAINABLE. There is no AI, no vector store, and no second
 * catalogue: every recommendation is scored against the live product records
 * that productService reads from the backend (MongoDB), and every reason string
 * is derived from data that actually exists on the product.
 *
 * The catalogue currently carries `category`, `price`, `palette`, `occasion`
 * and an inventory relation (absent for made-to-order items). Rather than add a
 * parallel taxonomy that admin-created products would immediately fall out of,
 * this service DERIVES a small gift taxonomy from those real fields with the
 * documented rules below. Anything the rules cannot infer simply does not match
 * that dimension — no invented attributes.
 *
 * Data-model note (reported, not implemented): if Flora Alchemy later wants
 * editors to hand-tag gifts, the natural smallest extension is an
 * `occasions: [String]` / `recipients: [String]` / `styles: [String]` set on the
 * Product model. The derivation below is written so those explicit tags can be
 * layered on top without changing the UI contract.
 */

// ---------------------------------------------------------------------------
// Option lists (shared by the Gift Finder, navigation and shop filters)
// ---------------------------------------------------------------------------

export const RECIPIENT_OPTIONS = [
  { id: 'partner', label: 'Partner', icon: '💞' },
  { id: 'best_friend', label: 'Best Friend', icon: '🫶' },
  { id: 'mom', label: 'Mom', icon: '🌷' },
  { id: 'dad', label: 'Dad', icon: '🌿' },
  { id: 'sibling', label: 'Sibling', icon: '🌸' },
  { id: 'teacher', label: 'Teacher', icon: '🍎' },
  { id: 'colleague', label: 'Colleague', icon: '💼' },
  { id: 'someone_special', label: 'Someone Special', icon: '✨' },
  { id: 'myself', label: 'Myself', icon: '🪴' },
];

export const OCCASION_OPTIONS = [
  { id: 'birthday', label: 'Birthday', icon: '🎂' },
  { id: 'anniversary', label: 'Anniversary', icon: '💍' },
  { id: 'wedding', label: 'Wedding', icon: '🤍' },
  { id: 'graduation', label: 'Graduation', icon: '🎓' },
  { id: 'thank_you', label: 'Thank You', icon: '💌' },
  { id: 'congratulations', label: 'Congratulations', icon: '🎉' },
  { id: 'festival', label: 'Festival', icon: '🪔' },
  { id: 'just_because', label: 'Just Because', icon: '🍃' },
];

export const BUDGET_OPTIONS = [
  { id: 'under_300', label: 'Under ₹300', min: 0, max: 300 },
  { id: '300_600', label: '₹300 – ₹600', min: 300, max: 600 },
  { id: '600_1000', label: '₹600 – ₹1,000', min: 600, max: 1000 },
  { id: '1000_2000', label: '₹1,000 – ₹2,000', min: 1000, max: 2000 },
  { id: '2000_plus', label: '₹2,000+', min: 2000, max: Infinity },
];

export const STYLE_OPTIONS = [
  { id: 'soft_romantic', label: 'Soft & Romantic', icon: '🌙' },
  { id: 'cute_playful', label: 'Cute & Playful', icon: '🧸' },
  { id: 'elegant', label: 'Elegant', icon: '🥂' },
  { id: 'minimal', label: 'Minimal', icon: '◻️' },
  { id: 'colorful', label: 'Colorful', icon: '🌈' },
  { id: 'sentimental', label: 'Sentimental', icon: '📜' },
];

export const PERSONALIZATION_OPTIONS = [
  { id: 'simple', label: 'Simple', description: 'Ready-to-gift as it is.' },
  { id: 'personalized', label: 'Personalized', description: 'A handwritten note or wax-sealed card.' },
  { id: 'fully_custom', label: 'Fully Custom', description: 'Built from scratch in the Custom Gift Studio.' },
];

// PHASE 3 — the wizard asks in the order a gift is actually thought about:
// who it is for, what the moment is, how it should feel, what it may cost,
// and how personal it should be. The labels are positional: index i labels
// STEPS[i] on the Gift Finder page and must stay aligned with it.
export const STEP_LABELS = ['Recipient', 'Occasion', 'Feeling', 'Budget', 'Personal'];

// Convenience lookups
const OPTION_INDEX = {};
[
  ['recipient', RECIPIENT_OPTIONS],
  ['occasion', OCCASION_OPTIONS],
  ['budget', BUDGET_OPTIONS],
  ['style', STYLE_OPTIONS],
  ['personalization', PERSONALIZATION_OPTIONS],
].forEach(([group, list]) => {
  OPTION_INDEX[group] = list.reduce((acc, o) => ({ ...acc, [o.id]: o }), {});
});

export function optionLabel(group, id) {
  return (OPTION_INDEX[group] && OPTION_INDEX[group][id] && OPTION_INDEX[group][id].label) || '';
}

export function budgetRange(id) {
  return OPTION_INDEX.budget[id] || null;
}

// ---------------------------------------------------------------------------
// Derivation rules — every rule reads a real product field
// ---------------------------------------------------------------------------

const BASE_OCCASIONS = ['birthday', 'just_because'];

// Product.occasion (free text on the Product model) → gift-finder occasion ids.
const EXPLICIT_OCCASION_MAP = {
  festive: ['festival'],
  anniversary: ['anniversary'],
  everyday: ['just_because'],
  birthday: ['birthday'],
  wedding: ['wedding'],
  graduation: ['graduation'],
  'thank you': ['thank_you'],
};

// Keyword rules over the product's own name/description/palette text.
const OCCASION_KEYWORD_RULES = [
  { test: /rakhi|festive|diwali|marigold|saffron|festival|celebration/i, occasions: ['festival', 'just_because'] },
  { test: /rose|peony|lavender|romance|romantic/i, occasions: ['anniversary', 'just_because', 'birthday'] },
  { test: /card|sticker|wax seal|stationery|foil|bookmark/i, occasions: ['thank_you', 'congratulations', 'graduation', 'birthday'] },
  { test: /hamper|keepsake|gift box|wooden/i, occasions: ['wedding', 'anniversary', 'congratulations', 'festival'] },
  { test: /desk|mascot|charm|shear|garden|sunflower|pot/i, occasions: ['graduation', 'thank_you', 'just_because'] },
];

// Category key → recipients this kind of gift suits.
const RECIPIENT_BY_CATEGORY = {
  bouquets: ['partner', 'mom', 'best_friend', 'someone_special', 'myself', 'sibling'],
  cards: ['best_friend', 'teacher', 'colleague', 'sibling', 'mom'],
  charms: ['colleague', 'teacher', 'best_friend', 'dad', 'sibling', 'myself'],
  hampers: ['partner', 'mom', 'dad', 'someone_special', 'best_friend'],
  custom: ['partner', 'mom', 'dad', 'someone_special'],
  other: ['best_friend', 'someone_special'],
};

// Palette / material keywords → style ids.
const STYLE_KEYWORD_RULES = [
  { test: /rose|peony|lavender|blush|romantic|velvet/i, styles: ['soft_romantic', 'sentimental'] },
  { test: /sunflower|marigold|saffron|wildflower|colorful|colourful/i, styles: ['colorful', 'cute_playful'] },
  { test: /gold|brass|heritage|foil/i, styles: ['elegant', 'sentimental'] },
  { test: /ceramic|cream|walnut|minimal/i, styles: ['minimal', 'elegant'] },
];

function productText(product) {
  return [product.name, product.shortDescription, product.description, product.palette, product.paletteName, product.occasion]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function uniq(list) {
  return [...new Set(list)];
}

function categoryKey(product) {
  return product.category || 'other';
}

function categoryLabel(product) {
  return product.categoryLabel || product.category || '';
}

/**
 * Derive the gift taxonomy for a single live product. Pure function — given the
 * same product it always returns the same attributes, so results are
 * explainable and reproducible.
 */
export function deriveGiftAttributes(product) {
  const text = productText(product);
  const cat = categoryKey(product);

  // Occasions: explicit field first, then keyword rules, always with the
  // broadly-true base occasions so nothing is arbitrarily orphaned.
  const explicit = EXPLICIT_OCCASION_MAP[String(product.occasion || '').toLowerCase()] || [];
  const keywordOccasions = OCCASION_KEYWORD_RULES
    .filter((rule) => rule.test.test(text))
    .flatMap((rule) => rule.occasions);
  const occasions = uniq([...explicit, ...keywordOccasions, ...BASE_OCCASIONS]);

  // Recipients: category family (a real catalogue field).
  const recipients = RECIPIENT_BY_CATEGORY[cat] || RECIPIENT_BY_CATEGORY.other;

  // Styles: palette / material keywords; a sensible elegant-neutral fallback
  // so every gift has a style rather than silently matching nothing.
  const keywordStyles = STYLE_KEYWORD_RULES.filter((rule) => rule.test.test(text)).flatMap((rule) => rule.styles);
  const styles = keywordStyles.length ? uniq(keywordStyles) : ['elegant', 'minimal'];

  // Personalization: the public `stockTracked` flag is authoritative — a
  // non-stock-tracked product is made to order, so it is fully customisable.
  // Cards & hampers are catalogue stock that nonetheless support
  // personalization. (Storefront sessions cannot read /api/inventory, so
  // per-item stock levels are deliberately not used here.)
  let personalization = 'simple';
  if (product.stockTracked === false) {
    personalization = 'fully_custom';
  } else if (cat === 'hampers' || cat === 'custom' || cat === 'cards') {
    personalization = 'personalized';
  }

  return { occasions, recipients, styles, personalization };
}

// ---------------------------------------------------------------------------
// Matching helpers (also used by the shop's occasion/recipient filters)
// ---------------------------------------------------------------------------

export function productMatchesOccasion(product, occasionId) {
  if (!occasionId) return true;
  return deriveGiftAttributes(product).occasions.includes(occasionId);
}

export function productMatchesRecipient(product, recipientId) {
  if (!recipientId) return true;
  return deriveGiftAttributes(product).recipients.includes(recipientId);
}

export function productMatchesStyle(product, styleId) {
  if (!styleId) return true;
  return deriveGiftAttributes(product).styles.includes(styleId);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function priceOf(product) {
  return Number(product.price) || 0;
}

function inBudget(product, budgetId) {
  const range = budgetRange(budgetId);
  if (!range) return true;
  const price = priceOf(product);
  return price >= range.min && price <= range.max;
}

/**
 * Score one product against the customer's answers.
 *
 * Returns `{ score, matches, inBudget, attributes }`.
 *
 * PHASE 3 — `matches` replaced the older prose `reasons`. Each entry is a
 * SHORT, FACTUAL label naming a dimension the product genuinely satisfies
 * (`Anniversary`, `For a Partner`, `₹600 – ₹1,000`, `Made to order`), emitted
 * only when the derivation above actually matched. The UI renders them as a
 * single "Matches:" line under the card. No sentence is invented, and a
 * product that matches on nothing contributes no label at all.
 *
 * Scoring is unchanged from the original ranking: budget is worth 4 and a miss
 * costs 6, occasion and recipient 3, style 2, and personalization 2 (plus 3
 * more for an exact "fully custom" hit) or 1 when the piece is merely
 * personalizable. Only the label strings differ.
 */
export function scoreProduct(product, answers = {}) {
  const attrs = deriveGiftAttributes(product);
  const matches = [];
  let score = 0;

  // No budget selected → treated as in budget (used by the "closest matches"
  // view, which scores relevance without re-penalising price).
  const budgetOk = !answers.budget || inBudget(product, answers.budget);
  if (answers.budget) {
    if (budgetOk) {
      score += 4;
      matches.push(optionLabel('budget', answers.budget));
    } else {
      score -= 6;
    }
  }

  if (answers.occasion && attrs.occasions.includes(answers.occasion)) {
    score += 3;
    matches.push(optionLabel('occasion', answers.occasion));
  }

  if (answers.recipient && attrs.recipients.includes(answers.recipient)) {
    score += 3;
    matches.push(`For a ${optionLabel('recipient', answers.recipient)}`);
  }

  if (answers.style && attrs.styles.includes(answers.style)) {
    score += 2;
    matches.push(optionLabel('style', answers.style));
  }

  if (answers.personalization) {
    if (attrs.personalization === answers.personalization) {
      score += 2;
    }
    if (answers.personalization === 'fully_custom' && attrs.personalization === 'fully_custom') {
      score += 3;
      matches.push('Made to order');
    } else if (attrs.personalization === 'personalized') {
      score += 1;
      matches.push('Personalization available');
    }
  }

  return { score, matches, inBudget: budgetOk, attributes: attrs };
}

/**
 * Rank the live catalogue for the given answers.
 *
 * Returns:
 *   { results: [{ product, score, matches }], relaxed, hadBudgetMatch }
 *
 * - When no catalogue item fits the chosen budget, `results` is empty and
 *   `hadBudgetMatch` is false so the page can offer an honest "expand budget"
 *   action instead of silently showing unrelated products.
 * - `relaxBudget: true` shows the closest gifts above budget (the page explains
 *   this explicitly).
 */
export function recommendGifts(answers = {}, products = [], { limit = 6, relaxBudget = false } = {}) {
  const visible = products.filter((p) => p.visibility !== 'Hidden');

  // Strict scoring (budget counts as a strong positive, out-of-budget as a
  // penalty) is used to decide whether an in-budget match exists at all.
  const strict = visible.map((product) => ({ product, ...scoreProduct(product, answers) }));
  const hadBudgetMatch = answers.budget ? strict.some((s) => s.inBudget) : strict.length > 0;

  if (!relaxBudget) {
    if (answers.budget && !hadBudgetMatch) {
      return { results: [], relaxed: false, hadBudgetMatch: false };
    }
    const pool = answers.budget ? strict.filter((s) => s.inBudget) : strict;
    pool.sort((a, b) => b.score - a.score || priceOf(a.product) - priceOf(b.product));
    return {
      results: pool.filter((s) => s.score > 0).slice(0, limit),
      relaxed: false,
      hadBudgetMatch,
    };
  }

  // Relaxed: the customer chose to look outside the budget, so budget is not
  // penalised — relevance drives the order and budget proximity breaks ties.
  const range = budgetRange(answers.budget);
  const distance = (p) => {
    if (!range) return 0;
    const price = priceOf(p);
    if (price < range.min) return range.min - price;
    if (price > range.max) return price - range.max;
    return 0;
  };

  const relaxedPool = visible
    .map((product) => ({ product, ...scoreProduct(product, { ...answers, budget: '' }) }))
    .filter((s) => s.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      distance(a.product) - distance(b.product) ||
      priceOf(a.product) - priceOf(b.product)
    );

  return {
    results: relaxedPool.slice(0, limit),
    relaxed: true,
    hadBudgetMatch,
  };
}
