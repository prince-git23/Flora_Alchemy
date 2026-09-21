import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Sparkles,
  Check,
  ShoppingBag,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  Gift,
  Flower2,
  Palette,
  Ribbon,
  MessageSquareHeart,
  PackageCheck,
  RotateCcw,
  Star
} from 'lucide-react';
import { useStore } from '../context/StoreContext.jsx';
import { gsap } from 'gsap';

const STEPS = [
  { id: 'occasion', title: 'Choose Occasion', icon: Gift },
  { id: 'base', title: 'Choose Your Base', icon: PackageCheck },
  { id: 'flowers', title: 'Choose Your Flowers', icon: Flower2 },
  { id: 'colors', title: 'Choose Your Colors', icon: Palette },
  { id: 'wrapping', title: 'Choose Wrapping', icon: Ribbon },
  { id: 'message', title: 'Add a Personal Message', icon: MessageSquareHeart },
  { id: 'review', title: 'Review & Add to Bag', icon: ShoppingBag }
];

const OCCASIONS = [
  { id: 'birthday', name: 'Birthday', emoji: '🎂' },
  { id: 'anniversary', name: 'Anniversary', emoji: '💍' },
  { id: 'wedding', name: 'Wedding', emoji: '💐' },
  { id: 'thanks', name: 'Thank You', emoji: '🤍' },
  { id: 'sympathy', name: 'Sympathy', emoji: '🕊️' },
  { id: 'festival', name: 'Festival', emoji: '🪔' },
  { id: 'just-because', name: 'Just Because', emoji: '🌼' }
];

const BASES = [
  {
    id: 'keepsake-posy',
    title: 'Handcrafted Everlasting Posy',
    price: 1850,
    image: '/assets/images/flora-asset-03.jpg',
    desc: 'Hand-wrapped in deckled mulberry bark washi and raw silk.'
  },
  {
    id: 'heirloom-box',
    title: 'Solid Pine Sliding Hamper Box',
    price: 3450,
    image: '/assets/images/flora-asset-11.jpg',
    desc: 'Finished pine keepsake casket with brass shears & card.'
  },
  {
    id: 'ceramic-pot',
    title: 'Artisan Speckled Ceramic Vessel',
    price: 1250,
    image: '/assets/images/flora-asset-09.jpg',
    desc: 'Hand-thrown stoneware pottery with moss bedding.'
  }
];

const FLOWER_STEMS = [
  { id: 'rose', name: 'Velvet Dusty Rose', cost: 0 },
  { id: 'lavender', name: 'French Lavender Sprigs', cost: 0 },
  { id: 'chamomile', name: 'Sunny Chamomile Buds', cost: 0 },
  { id: 'peony', name: 'Blush Peony Bloom (+₹300)', cost: 300 },
  { id: 'eucalyptus', name: 'Sage Eucalyptus Leaves', cost: 0 }
];

const COLOR_PALETTES = [
  { id: 'mauve', name: 'Dusty Rose & Lavender', c1: '#c98e87', c2: '#9a7b9b' },
  { id: 'sage', name: 'Sage Leaf & Forest Olive', c1: '#82927c', c2: '#495b42' },
  { id: 'terracotta', name: 'Terracotta & Burnished Ochre', c1: '#ba6d5b', c2: '#dfb39d' },
  { id: 'cream', name: 'Parchment Cream & Gold Leaf', c1: '#e8dec8', c2: '#cca856' }
];

const RIBBONS = [
  { id: 'frayed-silk', name: 'Frayed Edge Plant-Dyed Silk', desc: 'Unhemmed organic drape' },
  { id: 'velvet-cord', name: 'French Olive Velvet Cord', desc: 'Plush texture' },
  { id: 'deckled-twine', name: 'Natural Cotton Jute Twine', desc: 'Minimalist rustic knot' }
];

const WAX_SEALS = [
  { id: 'terracotta', name: 'Terracotta Clay', hex: '#964735' },
  { id: 'sage', name: 'Dried Sage', hex: '#5B6D54' },
  { id: 'gold', name: 'Burnished Antique Gold', hex: '#B89746' }
];

export default function CustomGiftsPage() {
  const navigate = useNavigate();
  const { addItemToCart } = useStore();

  const [step, setStep] = useState(0);
  const [selectedOccasion, setSelectedOccasion] = useState(OCCASIONS[0]);
  const [selectedBase, setSelectedBase] = useState(BASES[0]);
  const [selectedFlowers, setSelectedFlowers] = useState(['rose', 'lavender', 'eucalyptus']);
  const [selectedPalette, setSelectedPalette] = useState(COLOR_PALETTES[0]);
  const [selectedRibbon, setSelectedRibbon] = useState(RIBBONS[0]);
  const [selectedSeal, setSelectedSeal] = useState(WAX_SEALS[0]);
  const [recipientName, setRecipientName] = useState('');
  const [cardMessage, setCardMessage] = useState('');

  const heroRef = useRef(null);
  const stepPanelRef = useRef(null);

  // GSAP hero entrance
  useEffect(() => {
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED || !heroRef.current) return;

    gsap.fromTo(heroRef.current.children,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power3.out', delay: 0.1 }
    );
  }, []);

  // GSAP step transition
  useEffect(() => {
    if (!stepPanelRef.current) return;
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (REDUCED) return;

    gsap.fromTo(stepPanelRef.current,
      { opacity: 0, x: 20 },
      { opacity: 1, x: 0, duration: 0.35, ease: 'power2.out' }
    );
  }, [step]);

  const toggleFlower = (id) => {
    if (selectedFlowers.includes(id)) {
      if (selectedFlowers.length > 1) {
        setSelectedFlowers(selectedFlowers.filter((f) => f !== id));
      }
    } else {
      setSelectedFlowers([...selectedFlowers, id]);
    }
  };

  const flowerExtraCost = selectedFlowers.reduce((acc, fId) => {
    const item = FLOWER_STEMS.find((f) => f.id === fId);
    return acc + (item ? item.cost : 0);
  }, 0);

  const totalPrice = selectedBase.price + flowerExtraCost;

  const goNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goBack = () => {
    if (step > 0) setStep(step - 1);
    else navigate('/collections');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const jumpTo = (idx) => {
    if (idx < STEPS.length - 1) setStep(idx);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAddToCart = () => {
    const customGiftConfig = {
      baseId: selectedBase.id,
      flowerIds: selectedFlowers,
      paletteId: selectedPalette.id,
      ribbonId: selectedRibbon.id,
      sealId: selectedSeal.id,
    };

    const customItem = {
      id: `custom-${Date.now()}`,
      name: `Custom ${selectedOccasion.name} Gift — ${selectedBase.title}`,
      price: totalPrice,
      images: [selectedBase.image],
      categoryLabel: 'Custom Gift Studio',
      category: 'custom'
    };

    addItemToCart(customItem, {
      customPrice: totalPrice,
      occasion: selectedOccasion.name,
      palette: selectedPalette.name,
      ribbon: selectedRibbon.name,
      giftMessage: `For: ${recipientName || 'Someone special'} — "${cardMessage || 'Thinking of you.'}" (Seal: ${selectedSeal.name})`,
      customDetails: {
        base: selectedBase.title,
        flowers: selectedFlowers.join(', '),
        seal: selectedSeal.name
      },
      customGiftConfig,
    });

    navigate('/cart');
  };

  const stepValid = () => {
    if (step === 2) return selectedFlowers.length > 0;
    return true;
  };

  return (
    <div className="w-full bg-[var(--color-surface-bg)] min-h-screen">
      {/* ═══ EDITORIAL HERO ═══ */}
      <div ref={heroRef} className="relative overflow-hidden pt-8 lg:pt-16 pb-6 lg:pb-12" style={{ perspective: '1200px' }}>
        <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-[#ffdad3]/20 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 -left-16 w-64 h-64 rounded-full bg-[#d8e7cd]/15 blur-3xl pointer-events-none" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-2xl mx-auto space-y-3">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-[#ffdad3]/50 text-[#964735] text-[11px] font-bold uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Custom Gift Studio</span>
            </div>
            <h1 className="font-serif text-[30px] sm:text-[38px] md:text-[52px] lg:text-[60px] text-[var(--color-botanical-primary)] tracking-tight font-normal leading-[1.1]">
              Build a Gift, Your Way
            </h1>
            <p className="text-[14px] sm:text-[15px] text-[var(--color-botanical-muted)] max-w-xl mx-auto leading-relaxed">
              Choose an occasion, pick your flowers, colors and wrapping — then add a personal message. Our artisans handcraft it to order.
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        {/* Step Indicator */}            <div className="max-w-3xl mx-auto mb-4 sm:mb-6 lg:mb-8 flex items-center gap-1 sm:gap-2 overflow-x-auto pb-1 scrollbar-none">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => i < step && jumpTo(i)}
              className={`flex items-center gap-1 sm:gap-1.5 shrink-0 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-full border text-[10px] sm:text-[11px] font-semibold transition-all duration-200 ${
                i === step
                  ? 'bg-[#180f0a] text-white border-[#180f0a] shadow-sm'
                  : i < step
                    ? 'bg-[var(--color-surface-lowest)] text-[#5b6d54] border-[#cfe0c7] cursor-pointer hover:border-[#5b6d54]'
                    : 'bg-[var(--color-surface-low)] text-[#a89c95] border-[var(--color-botanical-border)] cursor-default'
              }`}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${i <= step ? 'bg-[var(--color-surface-lowest)]/20' : 'bg-[var(--color-surface-lowest)]/60'}`}>
                {i < step ? <Check className="w-2.5 h-2.5" /> : i + 1}
              </span>
              <span className="hidden sm:inline">{s.title}</span>
              <span className="sm:hidden">{s.icon && <s.icon className="w-3 h-3" />}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Active Step Panel */}
          <div className="lg:col-span-7">
            <div ref={stepPanelRef} className="bg-[var(--color-surface-lowest)] rounded-2xl sm:rounded-3xl border border-[var(--color-botanical-border)] p-3 sm:p-6 lg:p-8 shadow-sm">
              {/* STEP 0: Occasion */}
              {step === 0 && (
                <div className="space-y-5">
                  <StepHeading n={1} title="Who is it for — and what's the occasion?" />
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {OCCASIONS.map((occ) => (
                      <button
                        key={occ.id}
                        type="button"
                        onClick={() => setSelectedOccasion(occ)}
                        className={`p-4 rounded-2xl border text-center transition-all duration-200 ${
                          selectedOccasion.id === occ.id
                            ? 'bg-[#faf4ee] border-[#180f0a] ring-1 ring-[#180f0a] shadow-sm'
                            : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                        }`}
                      >
                        <span className="text-[22px] block mb-1.5">{occ.emoji}</span>
                        <span className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">{occ.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 1: Base */}
              {step === 1 && (
                <div className="space-y-5">
                  <StepHeading n={2} title="Choose your base" subtitle="The keepsake that holds your flowers." />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {BASES.map((base) => (
                      <div
                        key={base.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedBase(base)}
                        onKeyDown={(e) => e.key === 'Enter' && setSelectedBase(base)}
                        className={`cursor-pointer rounded-2xl p-3 border transition-all duration-200 flex flex-col justify-between ${
                          selectedBase.id === base.id
                            ? 'bg-[var(--color-surface-lowest)] border-[#180f0a] shadow-sm ring-1 ring-[#180f0a]'
                            : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                        }`}
                      >
                        <div className="aspect-square w-full rounded-xl overflow-hidden mb-2 bg-[var(--color-surface-lowest)]">
                          <img
                            loading="lazy"
                            decoding="async" src={base.image} alt={base.title} className="w-full h-full object-cover" />
                        </div>
                        <div className="space-y-1">
                          <p className="font-serif text-[15px] font-medium text-[var(--color-botanical-primary)] leading-tight">
                            {base.title}
                          </p>
                          <p className="text-[11px] text-[var(--color-botanical-subtle)] leading-snug">{base.desc}</p>
                          <p className="text-[14px] font-bold text-[#964735]">
                            ₹{base.price.toLocaleString('en-IN')}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 2: Flowers */}
              {step === 2 && (
                <div className="space-y-5">
                  <StepHeading n={3} title="Choose your flowers" subtitle="Pick at least one — mix and match freely." />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {FLOWER_STEMS.map((stem) => {
                      const isChecked = selectedFlowers.includes(stem.id);
                      return (
                        <button
                          key={stem.id}
                          type="button"
                          onClick={() => toggleFlower(stem.id)}
                          className={`p-3 rounded-2xl border text-left flex items-center justify-between transition-all duration-200 ${
                            isChecked
                              ? 'bg-[var(--color-surface-lowest)] border-[#180f0a] shadow-xs'
                              : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                          }`}
                        >
                          <span className="text-[13px] font-medium text-[var(--color-botanical-text)]">{stem.name}</span>
                          <span
                            className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] transition-all duration-200 ${
                              isChecked ? 'bg-[#964735] text-white scale-110' : 'border border-[var(--color-botanical-border)]'
                            }`}
                          >
                            {isChecked && <Check className="w-3 h-3" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* STEP 3: Colors */}
              {step === 3 && (
                <div className="space-y-5">
                  <StepHeading n={4} title="Choose your colors" subtitle="A harmonizing palette for the whole gift." />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {COLOR_PALETTES.map((pal) => (
                      <button
                        key={pal.id}
                        type="button"
                        onClick={() => setSelectedPalette(pal)}
                        className={`p-3 rounded-2xl border text-left flex items-center gap-3 transition-all duration-200 ${
                          selectedPalette.id === pal.id
                            ? 'bg-[var(--color-surface-lowest)] border-[#180f0a] shadow-xs'
                            : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                        }`}
                      >
                        <div className="flex -space-x-1.5 shrink-0">
                          <span style={{ backgroundColor: pal.c1 }} className="w-5 h-5 rounded-full border border-white" />
                          <span style={{ backgroundColor: pal.c2 }} className="w-5 h-5 rounded-full border border-white" />
                        </div>
                        <span className="text-[13px] font-medium text-[var(--color-botanical-text)]">{pal.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP 4: Wrapping */}
              {step === 4 && (
                <div className="space-y-5">
                  <StepHeading n={5} title="Choose your wrapping" subtitle="Ribbon, tie and wax seal finish." />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {RIBBONS.map((rib) => (
                      <button
                        key={rib.id}
                        type="button"
                        onClick={() => setSelectedRibbon(rib)}
                        className={`p-3 rounded-2xl border text-left flex flex-col justify-between transition-all duration-200 ${
                          selectedRibbon.id === rib.id
                            ? 'bg-[var(--color-surface-lowest)] border-[#180f0a] shadow-xs'
                            : 'bg-[var(--color-surface-low)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)] hover:border-[#80756f]'
                        }`}
                      >
                        <span className="text-[13px] font-semibold text-[var(--color-botanical-primary)]">{rib.name}</span>
                        <span className="text-[11px] text-[var(--color-botanical-subtle)] mt-1">{rib.desc}</span>
                      </button>
                    ))}
                  </div>
                  <div className="pt-2">
                    <span className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-2">Wax Seal</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      {WAX_SEALS.map((ws) => (
                        <button
                          key={ws.id}
                          type="button"
                          onClick={() => setSelectedSeal(ws)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-semibold transition-all duration-200 ${
                            selectedSeal.id === ws.id
                              ? 'bg-[#180f0a] text-white border-[#180f0a]'
                              : 'bg-[var(--color-surface-low)] text-[var(--color-botanical-muted)] border-[var(--color-botanical-border)] hover:bg-[var(--color-surface-lowest)]'
                          }`}
                        >
                          <span style={{ backgroundColor: ws.hex }} className="w-2.5 h-2.5 rounded-full inline-block" />
                          <span>{ws.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 5: Message */}
              {step === 5 && (
                <div className="space-y-5">
                  <StepHeading n={6} title="Add a personal message" subtitle="Handwritten on a botanical card inside your gift." />
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="recipient-name" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                        Recipient Name
                      </label>
                      <input
                        id="recipient-name"
                        type="text"
                        value={recipientName}
                        onChange={(e) => setRecipientName(e.target.value)}
                        placeholder="Who is this gift for?"
                        className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-surface-low)] text-[14px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] transition-shadow"
                      />
                    </div>
                    <div>
                      <label htmlFor="card-message" className="block text-[11px] uppercase font-bold text-[var(--color-botanical-muted)] mb-1.5">
                        Card Message
                      </label>
                      <textarea
                        id="card-message"
                        rows={4}
                        value={cardMessage}
                        onChange={(e) => setCardMessage(e.target.value)}
                        placeholder="Write something kind…"
                        className="w-full p-3 rounded-xl bg-[var(--color-surface-low)] text-[13px] text-[var(--color-botanical-text)] border border-[var(--color-botanical-border)] focus:outline-none focus:ring-1 focus:ring-[#180f0a] resize-none transition-shadow"
                      />
                    </div>
                    <div
                      style={{ backgroundColor: selectedSeal.hex }}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-white text-[11px] font-medium"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-surface-lowest)]/70" />
                      Sealed with {selectedSeal.name}
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 6: Review */}
              {step === 6 && (
                <div className="space-y-5">
                  <StepHeading n={7} title="Review your gift" subtitle="Everything below is exactly what will be crafted." />
                  <div className="space-y-3">
                    <ReviewRow label="Occasion" value={`${selectedOccasion.emoji} ${selectedOccasion.name}`} onEdit={() => jumpTo(0)} />
                    <ReviewRow label="Base" value={selectedBase.title} onEdit={() => jumpTo(1)} />
                    <ReviewRow label="Flowers" value={selectedFlowers.map((f) => FLOWER_STEMS.find((s) => s.id === f)?.name).join(', ')} onEdit={() => jumpTo(2)} />
                    <ReviewRow label="Colors" value={selectedPalette.name} onEdit={() => jumpTo(3)} />
                    <ReviewRow label="Wrapping" value={`${selectedRibbon.name} · ${selectedSeal.name} seal`} onEdit={() => jumpTo(4)} />
                    <ReviewRow
                      label="Message"
                      value={recipientName ? `For ${recipientName} — "${cardMessage || 'Thinking of you.'}"` : `"${cardMessage || 'Thinking of you.'}"`}
                      onEdit={() => jumpTo(5)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 pt-3">
                    {['Handcrafted', 'Personalized', 'Gift-ready'].map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#d8e7cd]/50 text-[10px] font-bold text-[#5b6d54] uppercase tracking-wider">
                        <Star className="w-2.5 h-2.5" /> {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Nav Buttons */}
              <div className="flex items-center justify-between gap-3 pt-5 mt-5 border-t border-[var(--color-botanical-border)]">
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-muted)] text-[13px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors touch-target"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {step === 0 ? 'Back to Collections' : 'Back'}
                </button>

                {step < STEPS.length - 1 ? (
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!stepValid()}
                    className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-full bg-[#180f0a] text-white text-[13px] font-semibold hover:bg-[#964735] transition-colors disabled:opacity-40 disabled:cursor-not-allowed touch-target"
                  >
                    Continue
                    <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleAddToCart}
                    className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-[#964735] text-white text-[13px] font-semibold hover:bg-[#180f0a] transition-colors shadow-md touch-target"
                  >
                    <ShoppingBag className="w-4 h-4" />
                    Add to Bag · ₹{totalPrice.toLocaleString('en-IN')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Sticky Live Summary — below step panel on mobile, sticky on desktop */}
          <div className="lg:col-span-5 lg:sticky lg:top-24 space-y-4 sm:space-y-6 order-first lg:order-last">
            <div className="bg-[var(--color-surface-lowest)] rounded-2xl sm:rounded-3xl p-4 sm:p-6 border border-[var(--color-botanical-border)] shadow-lg space-y-4 sm:space-y-5">
              <div className="flex items-center justify-between border-b border-[var(--color-botanical-border)] pb-3 sm:pb-4">
                <div>
                  <span className="text-[10px] uppercase font-bold tracking-widest text-[#964735]">
                    Your Gift
                  </span>
                  <h3 className="font-serif text-[18px] sm:text-[22px] text-[var(--color-botanical-primary)]">
                    {selectedOccasion.name} Keepsake
                  </h3>
                </div>
                <span className="text-[20px] sm:text-[24px] font-bold text-[var(--color-botanical-primary)]">
                  ₹{totalPrice.toLocaleString('en-IN')}
                </span>
              </div>

              {/* Live Preview Visual */}
              <div className="relative rounded-xl sm:rounded-2xl bg-gradient-to-br from-[#faf7f2] to-[#f0ede9] border border-[var(--color-botanical-border)] overflow-hidden aspect-[16/10] sm:aspect-[4/3]">
                <img
                  loading="lazy"
                  decoding="async" src={selectedBase.image} alt={selectedBase.title} className="w-full h-full object-cover opacity-90 transition-transform duration-500" />
                <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/50 to-transparent">
                  <div className="flex items-center gap-2">
                    <div className="flex -space-x-1">
                      <span style={{ backgroundColor: selectedPalette.c1 }} className="w-4 h-4 rounded-full border-2 border-white" />
                      <span style={{ backgroundColor: selectedPalette.c2 }} className="w-4 h-4 rounded-full border-2 border-white" />
                    </div>
                    <span className="text-white text-[10px] font-medium drop-shadow">{selectedPalette.name}</span>
                  </div>
                </div>
                <div
                  style={{ backgroundColor: selectedSeal.hex }}
                  className="absolute top-3 right-3 w-8 h-8 rounded-full text-white text-[10px] font-serif flex items-center justify-center font-bold shadow-lg transition-colors duration-300"
                >
                  FA
                </div>
                <div className="absolute top-3 left-3 flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--color-surface-lowest)]/90 backdrop-blur-sm">
                  <Flower2 className="w-3 h-3 text-[#964735]" />
                  <span className="text-[10px] font-bold text-[var(--color-botanical-primary)]">{selectedFlowers.length} stems</span>
                </div>
              </div>

              <div className="space-y-2 text-[12px] sm:text-[13px] text-[var(--color-botanical-muted)]">
                <SummaryRow label="Occasion" value={selectedOccasion.name} onEdit={() => jumpTo(0)} />
                <SummaryRow label="Base" value={selectedBase.title} onEdit={() => jumpTo(1)} />
                <SummaryRow label="Flowers" value={`${selectedFlowers.length} selected`} onEdit={() => jumpTo(2)} />
                <SummaryRow label="Colors" value={selectedPalette.name} onEdit={() => jumpTo(3)} />
                <SummaryRow label="Wrapping" value={`${selectedRibbon.name} · ${selectedSeal.name}`} onEdit={() => jumpTo(4)} />
              </div>

              {step < STEPS.length - 1 && (
                <button
                  type="button"
                  onClick={() => jumpTo(STEPS.length - 1)}
                  className="w-full py-2.5 sm:py-3 rounded-full bg-[#180f0a] hover:bg-[#964735] text-white text-[12px] sm:text-[13px] font-semibold flex items-center justify-center gap-2 shadow-md transition-all duration-200 touch-target"
                >
                  <PackageCheck className="w-4 h-4" />
                  Review Gift · ₹{totalPrice.toLocaleString('en-IN')}
                </button>
              )}

              {step > 0 && (
                <button
                  type="button"
                  onClick={() => { setStep(0); setSelectedOccasion(OCCASIONS[0]); setSelectedBase(BASES[0]); setSelectedFlowers(['rose', 'lavender', 'eucalyptus']); setSelectedPalette(COLOR_PALETTES[0]); setSelectedRibbon(RIBBONS[0]); setSelectedSeal(WAX_SEALS[0]); setRecipientName(''); setCardMessage(''); }}
                  className="w-full py-2 rounded-full border border-[var(--color-botanical-border)] text-[var(--color-botanical-subtle)] text-[11px] sm:text-[12px] font-semibold hover:bg-[var(--color-surface-low)] transition-colors flex items-center justify-center gap-1.5"
                >
                  <RotateCcw className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                  Start Over
                </button>
              )}

              <div className="flex items-center justify-center gap-2 text-[12px] text-[var(--color-botanical-subtle)]">
                <ShieldCheck className="w-4 h-4 text-[#5b6d54]" />
                <span>Crafted in 2–3 business days · Pan-India delivery</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepHeading({ n, title, subtitle }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-8 h-8 rounded-full bg-[#180f0a] text-white flex items-center justify-center font-serif text-[15px] shrink-0 mt-0.5">
        {n}
      </span>
      <div>
        <h2 className="font-serif text-[24px] text-[var(--color-botanical-primary)] leading-tight">{title}</h2>
        {subtitle && <p className="text-[13px] text-[var(--color-botanical-subtle)] mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function ReviewRow({ label, value, onEdit }) {
  return (
    <div className="flex items-start sm:items-center justify-between gap-2 sm:gap-3 bg-[var(--color-surface-low)] rounded-xl px-3 sm:px-4 py-2.5 sm:py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase font-bold text-[var(--color-botanical-subtle)]">{label}</p>
        <p className="text-[12px] sm:text-[13px] font-medium text-[var(--color-botanical-primary)] line-clamp-2 break-words">{value}</p>
      </div>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 text-[11px] font-semibold text-[#964735] hover:underline pt-3"
        >
          Change
        </button>
      )}
    </div>
  );
}

function SummaryRow({ label, value, onEdit }) {
  return (
    <div className="flex justify-between items-start gap-2">
      <div className="min-w-0 flex-1">
        <span className="text-[var(--color-botanical-subtle)] text-[10px] sm:text-[11px] block">{label}</span>
        <span className="font-semibold text-[var(--color-botanical-primary)] text-[11px] sm:text-[12px] block line-clamp-1 break-words">{value}</span>
      </div>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 text-[9px] sm:text-[10px] font-bold uppercase tracking-wide text-[#964735] hover:underline pt-1"
        >
          Change
        </button>
      )}
    </div>
  );
}
