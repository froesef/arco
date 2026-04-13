/**
 * Hero Image Catalog
 *
 * A rich, annotated map of all available hero images for the Arco site.
 * Each entry includes alt text, topic keywords, and optional product associations
 * so the recommender can select contextually appropriate heroes.
 *
 * Product entries use actual product image paths from products.json.
 * Non-product entries use the default hero image until dedicated lifestyle/story
 * images are generated and uploaded to DA.
 */

/* eslint-disable import/extensions, import/no-relative-packages */
import productsData from '../../../content/products/products.json';
/* eslint-enable import/extensions, import/no-relative-packages */

const ARCO_BASE = 'https://main--arco--froesef.aem.live';

// Default hero image — used for non-product entries
const DEFAULT_HERO = '/media_1f7e12f4bd38e8ecf4fdc73dc84ebd9a5fd516521.jpg';

// Build a product ID → image path lookup from the products data
const productImageMap = new Map(
  (productsData.data || [])
    .filter((p) => p.images?.[0] || p.image)
    .map((p) => [p.id, p.images?.[0] || p.image]),
);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HeroImageEntry
 * @property {string} path - AEM media path (e.g. '/media_1f7e12f...jpg')
 * @property {string} alt - Descriptive alt text for accessibility
 * @property {string[]} topics - Topic keywords for scoring
 * @property {string[]} [productIds] - Associated Arco product IDs
 */

/** @type {HeroImageEntry[]} */
export const HERO_IMAGE_CATALOG = [

  // ── General / Brand ────────────────────────────────────────────────────

  {
    path: '/hero-main.jpeg',
    alt: 'Arco espresso machine brewing a fresh shot into a ceramic cup on a sunlit marble kitchen counter',
    topics: ['espresso', 'home', 'welcome', 'discovery', 'general', 'brewing', 'kitchen'],
  },
  {
    path: '/about-arco.jpeg',
    alt: 'Arco brand collage — espresso machine with copper pour-over, disassembled copper components, and a craftsman hand-assembling a machine in an Italian workshop',
    topics: ['brand', 'about', 'craftsmanship', 'design', 'italian', 'heritage', 'quality', 'story'],
  },
  {
    path: '/about-workshop.jpeg',
    alt: 'Close-up of a craftsman in a leather apron hand-assembling a brass boiler with copper tubing and precision tools on a workshop bench',
    topics: ['craftsmanship', 'engineering', 'quality', 'boiler', 'build', 'heritage', 'repair', 'maintenance', 'support'],
  },
  {
    path: '/sustainability.jpeg',
    alt: 'Open coffee table book showing Arco espresso machines alongside a misty sunrise over lush green coffee plantation hills',
    topics: ['sustainability', 'origin', 'coffee-farm', 'environment', 'story', 'brand', 'beans', 'sourcing'],
  },

  // ── Experience / Lifestyle ─────────────────────────────────────────────

  {
    path: '/exp-craft-at-home.jpeg',
    alt: 'Home barista station with Arco espresso machine and grinder on a marble counter, hands pouring latte art into a ceramic cup in a cozy kitchen',
    topics: ['home-barista', 'craft', 'latte-art', 'milk-drinks', 'setup', 'kitchen', 'espresso', 'grinder'],
    productIds: ['doppio'],
  },
  {
    path: '/exp-espresso-anywhere.jpeg',
    alt: 'Arco Viaggio portable espresso maker and hand grinder on a weathered wooden table at dawn, misty mountain lake and pine forest in the background',
    topics: ['travel', 'portable', 'outdoor', 'adventure', 'camping', 'nature', 'morning'],
    productIds: ['viaggio'],
  },
  {
    path: '/exp-morning-minimalist.jpeg',
    alt: 'Minimalist espresso setup — Arco machine with a freshly pulled shot in a double-wall glass on a clean marble counter against a warm neutral wall',
    topics: ['minimalist', 'morning', 'simple', 'clean', 'espresso', 'routine', 'beginner'],
  },
  {
    path: '/exp-non-barista.jpeg',
    alt: 'Hand pressing the one-touch button on an Arco Automatico coffee machine as fresh coffee brews into a glass carafe on a bright kitchen counter',
    topics: ['automatic', 'easy', 'one-touch', 'beginner', 'non-barista', 'simple', 'convenience'],
    productIds: ['automatico'],
  },
  {
    path: '/exp-upgrade-path.jpeg',
    alt: 'Two Arco espresso machines side by side — compact entry-level on the left, larger prosumer dual-boiler on the right — illustrating the upgrade journey',
    topics: ['upgrade', 'comparison', 'side-by-side', 'journey', 'progression', 'choosing'],
  },

  // ── Story / Editorial ──────────────────────────────────────────────────

  {
    path: '/story-bean-to-cup.jpeg',
    alt: 'The coffee journey from cherry to cup — fresh red cherries, green beans, roasted beans, ground coffee, and a finished espresso with an Arco machine in the background',
    topics: ['beans', 'origin', 'roasting', 'process', 'coffee-journey', 'education', 'freshness', 'single-origin', 'blends'],
  },
  {
    path: '/story-cleaning-machine.jpeg',
    alt: 'Hands in gloves cleaning an Arco espresso machine group head with a brush, water rinsing through the portafilter during a backflush cycle',
    topics: ['cleaning', 'maintenance', 'care', 'backflush', 'support', 'longevity', 'descaling', 'troubleshooting'],
  },
  {
    path: '/story-dialing-in.jpeg',
    alt: 'Overhead flat lay of espresso tools — portafilter, precision scale, grinder, notebook with brewing notes, timer, and cup on a marble surface',
    topics: ['dialing-in', 'technique', 'precision', 'recipe', 'extraction', 'tools', 'accessories', 'learning', 'beginner'],
  },
  {
    path: '/story-flat-vs-conical.jpeg',
    alt: 'Close-up of a flat burr and a conical burr side by side on a marble surface, showing the copper-tipped cutting geometry of each design',
    topics: ['grinder', 'burr', 'flat-burr', 'conical-burr', 'comparison', 'grind', 'technical', 'education'],
  },
  {
    path: '/story-milk-steaming.jpeg',
    alt: 'Close-up of an Arco copper-tipped steam wand creating a silky milk vortex in a stainless steel pitcher, steam rising',
    topics: ['milk', 'steaming', 'microfoam', 'latte', 'cappuccino', 'flat-white', 'cortado', 'latte-art', 'milk-drinks', 'technique'],
  },
  {
    path: '/story-morning-routines.jpeg',
    alt: 'Person pulling an espresso shot on an Arco machine in a warm sunlit kitchen with a Tuscan landscape visible through the window',
    topics: ['morning', 'routine', 'lifestyle', 'home', 'espresso', 'ritual', 'daily', 'kitchen'],
  },
  {
    path: '/story-pressure-profiling.jpeg',
    alt: 'Close-up of an Arco espresso machine pressure gauge reading 9 bars with a copper bezel, espresso streaming into a cup below',
    topics: ['pressure', 'profiling', 'extraction', 'technical', 'espresso', 'advanced', 'flow-control', 'bars', 'specs'],
  },
  {
    path: '/story-single-origin-vs-blends.jpeg',
    alt: 'Two piles of coffee beans — light single-origin and dark roast blend — on a marble counter beside a ceramic pour-over dripper and gooseneck kettle',
    topics: ['beans', 'single-origin', 'blends', 'roast', 'pour-over', 'filter', 'coffee', 'education', 'flavor'],
  },
  {
    path: '/story-travel-espresso.jpeg',
    alt: 'Arco Viaggio portable espresso maker and hand grinder on a wooden table with golden mountain scenery at sunset',
    topics: ['travel', 'portable', 'outdoor', 'viaggio', 'camping', 'hiking', 'adventure'],
    productIds: ['viaggio'],
  },
  {
    path: '/story-water-chemistry.jpeg',
    alt: 'Hand pouring filtered water from a glass jug into an Arco compact espresso machine reservoir on a clean kitchen counter',
    topics: ['water', 'chemistry', 'filtration', 'quality', 'maintenance', 'setup', 'beginner', 'preparation'],
  },

  // ── Product: Espresso Machines ─────────────────────────────────────────

  {
    path: '/product-primo.jpeg',
    alt: 'Two Arco Primo espresso machines in matte black with copper and walnut accents, showcasing the single-boiler design with pressure gauge',
    topics: ['primo', 'espresso', 'single-boiler', 'beginner', 'entry-level', 'home', 'first-machine', 'budget'],
    productIds: ['primo'],
  },
  {
    path: '/product-doppio.jpeg',
    alt: 'Arco Doppio dual-boiler espresso machine in brushed silver with E61 group head, dual pressure gauges and copper accents beside an espresso cup',
    topics: ['doppio', 'dual-boiler', 'e61', 'prosumer', 'upgrade', 'espresso', 'simultaneous-brewing'],
    productIds: ['doppio'],
  },
  {
    path: '/product-nano.jpeg',
    alt: 'Compact Arco Nano espresso machine in matte black with copper dials on a marble board beside a small espresso cup and coffee books',
    topics: ['nano', 'compact', 'small', 'space-saving', 'beginner', 'budget', 'apartment', 'lightweight'],
    productIds: ['nano'],
  },
  {
    path: '/product-studio.jpeg',
    alt: 'Arco Studio prosumer espresso machine with walnut side panels, digital display, and flow-control paddle on a kitchen counter',
    topics: ['studio', 'prosumer', 'flow-control', 'advanced', 'saturated-group', 'serious', 'home-barista'],
    productIds: ['studio'],
  },
  {
    path: '/product-studio-pro.jpeg',
    alt: 'Arco Studio Pro espresso machine in matte black with walnut accents, dual group heads with touchscreen display in a rustic-modern cafe setting',
    topics: ['studio-pro', 'professional', 'commercial', 'touchscreen', 'triple-boiler', 'pressure-profiling', 'high-end'],
    productIds: ['studio-pro'],
  },
  {
    path: '/product-ufficio.jpeg',
    alt: 'Arco Ufficio commercial dual-group espresso machine in matte black with copper accents in a bright office kitchen',
    topics: ['ufficio', 'office', 'commercial', 'dual-group', 'high-volume', 'workplace', 'team'],
    productIds: ['ufficio'],
  },
  {
    path: '/product-viaggio.jpeg',
    alt: 'Arco Viaggio portable lever espresso maker in brushed aluminum next to a passport, leather wallet, and espresso cup on a sunlit counter',
    topics: ['viaggio', 'travel', 'portable', 'manual', 'lever', 'compact', 'lightweight', 'adventure'],
    productIds: ['viaggio'],
  },
  {
    path: '/product-automatico.jpeg',
    alt: 'Arco Automatico bean-to-cup machine in matte black with built-in grinder, touchscreen, copper dials, and automatic milk frother',
    topics: ['automatico', 'automatic', 'bean-to-cup', 'one-touch', 'easy', 'beginner', 'convenience', 'milk-drinks'],
    productIds: ['automatico'],
  },

  // ── Product: Grinders ──────────────────────────────────────────────────

  {
    path: '/product-zero.jpeg',
    alt: 'Arco Zero single-dose grinder in matte black with copper adjustment dial and bellows system, coffee beans in a small bowl beside it',
    topics: ['zero', 'grinder', 'single-dose', 'zero-retention', 'bellows', 'flat-burr', 'precision', 'espresso-grinder'],
    productIds: ['zero'],
  },
  {
    path: '/product-macinino.jpeg',
    alt: 'Arco Macinino flat-burr grinder in matte black with walnut hopper and copper accents, next to a pour-over dripper and brewed filter coffee',
    topics: ['macinino', 'grinder', 'flat-burr', '64mm', 'espresso-grinder', 'stepless', 'clarity'],
    productIds: ['macinino'],
  },
  {
    path: '/product-macinino-pro.jpeg',
    alt: 'Arco Macinino Pro commercial grinder in matte black with large hopper, copper adjustment knob, and digital display dispensing into a stainless steel dosing cup',
    topics: ['macinino-pro', 'grinder', 'commercial', 'professional', 'high-volume', 'office'],
    productIds: ['macinino'],
  },
  {
    path: '/product-preciso.jpeg',
    alt: 'Arco Preciso conical-burr grinder in matte black with copper top and adjustment collar, espresso machine visible in the background',
    topics: ['preciso', 'grinder', 'conical-burr', 'versatile', 'espresso', 'pour-over', 'all-rounder'],
    productIds: ['preciso'],
  },
  {
    path: '/product-filtro.jpeg',
    alt: 'Arco Filtro compact filter grinder in matte black with copper accent ring on a marble kitchen island, pour-over dripper in the background',
    topics: ['filtro', 'grinder', 'filter', 'pour-over', 'drip', 'french-press', 'compact', 'beginner'],
    productIds: ['filtro'],
  },
  {
    path: '/product-viaggio-grinder.jpeg',
    alt: 'Arco Viaggio hand grinder in brushed stainless steel with copper crank handle beside scattered coffee beans on a marble counter',
    topics: ['viaggio-grinder', 'hand-grinder', 'manual', 'travel', 'portable', 'compact'],
  },

  // ── Product: Accessories ───────────────────────────────────────────────

  {
    path: '/product-milk-pitcher.jpeg',
    alt: 'Arco stainless steel milk pitcher with copper ring handle next to a latte with tulip art, espresso machine in the background',
    topics: ['milk-pitcher', 'latte-art', 'milk-drinks', 'steaming', 'cappuccino', 'latte', 'accessory'],
  },
];

// ---------------------------------------------------------------------------
// Intent fallback topics
// ---------------------------------------------------------------------------

const INTENT_FALLBACK_TOPICS = {
  beginner: ['beginner', 'welcome', 'easy', 'first-machine', 'discovery'],
  discovery: ['discovery', 'general', 'espresso', 'welcome'],
  comparison: ['comparison', 'side-by-side', 'upgrade', 'choosing'],
  'product-detail': ['espresso', 'home-barista'],
  'use-case': ['espresso', 'home'],
  specs: ['technical', 'pressure', 'extraction', 'specs'],
  reviews: ['espresso', 'home-barista'],
  price: ['budget', 'entry-level', 'choosing'],
  recommendation: ['espresso', 'home-barista', 'discovery'],
  support: ['maintenance', 'cleaning', 'support', 'troubleshooting'],
  gift: ['espresso', 'home', 'beginner'],
  medical: ['general', 'espresso'],
  accessibility: ['easy', 'automatic', 'simple'],
  technique: ['technique', 'extraction', 'dialing-in', 'precision'],
  upgrade: ['upgrade', 'comparison', 'progression', 'advanced'],
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Tokenise a query string and use-case list into a normalised keyword set.
 */
function tokenize(query, useCases) {
  const tokens = new Set();
  if (query) {
    query.toLowerCase().split(/[\s,;.!?]+/).forEach((word) => {
      const trimmed = word.replace(/[^a-z0-9-]/g, '');
      if (trimmed.length > 2) tokens.add(trimmed);
    });
  }
  if (useCases) {
    useCases.forEach((uc) => {
      tokens.add(uc.toLowerCase().trim());
      uc.toLowerCase().split(/[\s-]+/).forEach((word) => {
        if (word.length > 2) tokens.add(word);
      });
    });
  }
  return tokens;
}

/**
 * Score a hero image against the given query context.
 * Higher score = better match.
 */
function scoreImage(image, queryTokens, productIds) {
  let score = 0;

  // Exact product match is the strongest signal
  if (image.productIds) {
    productIds.forEach((pid) => {
      if (image.productIds.includes(pid)) score += 10;
    });
  }

  // Topic overlap with query tokens
  image.topics.forEach((topic) => {
    if (queryTokens.has(topic)) {
      score += 2;
    }
    // Partial match — topic inside a token or vice versa
    queryTokens.forEach((token) => {
      if (token !== topic && (token.includes(topic) || topic.includes(token))) {
        score += 1;
      }
    });
  });

  return score;
}

/**
 * Select the best hero image for a given query context.
 *
 * @param {Object} options
 * @param {string} [options.query] - The user's search query
 * @param {string[]} [options.useCases] - Extracted use cases
 * @param {string} [options.intentType] - Classified intent type
 * @param {string[]} [options.productIds] - Relevant product IDs from RAG
 * @returns {{ url: string, alt: string }} Full image URL and alt text
 */
export function selectHeroImage({
  query, useCases, intentType, productIds = [],
} = {}) {
  const queryTokens = tokenize(query, useCases);

  // Also add intent type as a query token for topic matching
  if (intentType) queryTokens.add(intentType);

  // Score every image
  let scored = HERO_IMAGE_CATALOG.map((image) => ({
    image,
    score: scoreImage(image, queryTokens, productIds),
  }));

  // If no strong match (best score <= 1), inject intent fallback topics
  const bestScore = Math.max(...scored.map((s) => s.score));
  if (bestScore <= 1 && intentType) {
    const fallbackTopics = INTENT_FALLBACK_TOPICS[intentType] || ['general', 'espresso'];
    fallbackTopics.forEach((topic) => queryTokens.add(topic));
    scored = HERO_IMAGE_CATALOG.map((image) => ({
      image,
      score: scoreImage(image, queryTokens, productIds),
    }));
  }

  // Sort descending by score, random jitter to break ties
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return Math.random() - 0.5;
  });

  // Pick from the top tier (all images sharing the highest score)
  const topScore = scored[0].score;
  const topTier = scored.filter((s) => s.score === topScore);
  const selected = topTier[Math.floor(Math.random() * topTier.length)].image;

  // Resolve image path: use real product image if available, else default hero
  let imagePath = DEFAULT_HERO;
  if (selected.productIds?.length) {
    const productImage = productImageMap.get(selected.productIds[0]);
    if (productImage) imagePath = productImage;
  }

  return {
    url: `${ARCO_BASE}${imagePath.startsWith('/') ? '' : '/'}${imagePath}`,
    alt: selected.alt,
  };
}
