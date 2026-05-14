/**
 * Recommender Pipeline Prompts — consultative coffee equipment advisor
 * system and user prompts.
 *
 * Key characteristics:
 * - Acts as a knowledgeable coffee equipment advisor
 * - ALWAYS generates comparison-table blocks
 * - NEVER generates "buy" suggestion types — only "explore" and "compare"
 * - All product links use the URL from product data (e.g., /products/espresso-machines/primo)
 * - Suggestion buttons gather information, not push sales
 */

/* eslint-disable import/extensions, import/no-relative-packages */
import productsData from '../../../content/products/products.json';
import productProfilesData from '../../../content/metadata/product-profiles.json';
import accessoriesData from '../../../content/accessories/accessories.json';
/* eslint-enable import/extensions, import/no-relative-packages */

import EDS_BLOCK_GUIDE from './block-guide.js';
import { BRAND_VOICE } from './brand-voice.js';

const allProducts = productsData.data || [];
const allAccessories = accessoriesData.data || [];
const productsById = new Map(allProducts.map((p) => [p.id, p]));

/**
 * Summarize a product ID with the hardware facts that drive follow-up
 * reasoning: whether it includes a grinder, milk frother, touchscreen, its
 * boiler type, price, and category. The LLM uses this when answering
 * "do I need a grinder?", "does it do milk?", etc. in follow-up turns — so
 * it responds in context instead of answering generically.
 *
 * @param {string} id Product ID (slug, e.g. "automatico")
 * @returns {string} compact "Name ($price, boiler, extras)" line, or the raw id
 *   when the product is not in the catalog
 */
function describeShownProduct(id) {
  const p = productsById.get(id);
  if (!p) return id;
  const s = p.specs || {};
  const tags = [];
  if (s.builtInGrinder) tags.push('built-in grinder — no separate grinder needed');
  if (s.autoMilk) tags.push('auto milk frother');
  if (s.touchscreen) tags.push('touchscreen');
  if (s.manual) tags.push('manual lever, no electricity');
  if (s.plumbedIn) tags.push('plumb-in capable');
  if (s.flowControl) tags.push('flow control');
  if (s.pressureProfiling) tags.push('pressure profiling');
  if (s.singleDose) tags.push('single-dose');
  if (s.stepless) tags.push('stepless grind');
  const boiler = s.boilers && s.boilers !== 'None (manual)' ? `${s.boilers} boiler` : '';
  const parts = [`$${p.price}`, p.category, boiler].filter(Boolean);
  const suffix = tags.length ? ` — ${tags.join(', ')}` : '';
  return `${p.name} (${parts.join(', ')}${suffix})`;
}

/**
 * Join a list of product IDs as enriched descriptions so follow-up turns
 * can reason about the specific hardware already in front of the user.
 */
function describeShownProducts(ids) {
  return (ids || []).map(describeShownProduct).join('; ');
}

/**
 * Build a compact product catalog string for the system prompt.
 */
function buildProductCatalog() {
  const profiles = productProfilesData.data || productProfilesData.profiles || {};

  return allProducts
    .map((p) => {
      const profile = Array.isArray(profiles)
        ? profiles.find((pr) => (pr.productId || pr.id) === p.id)
        : profiles[p.id];
      const topUses = profile?.scores
        ? Object.entries(profile.scores)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([uc, score]) => `${uc}(${score})`)
          .join(', ')
        : '';
      const boiler = p.specs?.boilers || '?';
      const group = p.specs?.groupHead || '?';
      const power = p.specs?.power || '?';
      const pump = p.specs?.pumpType || '?';
      const pid = p.specs?.pidControl ? 'PID' : '';
      const flow = p.specs?.flowControl ? 'Flow Control' : '';
      const pressure = p.specs?.pressureProfiling ? 'Pressure Profiling' : '';
      const plumbed = p.specs?.plumbedIn ? 'Plumb-in' : '';
      const grinder = p.specs?.builtInGrinder ? 'Built-in Grinder' : '';
      const touchscreen = p.specs?.touchscreen ? 'Touchscreen' : '';
      const autoMilk = p.specs?.autoMilk ? 'Auto Milk' : '';
      const drinks = p.specs?.programmableDrinks ? `${p.specs.programmableDrinks} programmable drinks` : '';
      const specials = [pid, flow, pressure, plumbed, grinder, touchscreen, autoMilk, drinks].filter(Boolean).join(', ');
      return `- **${p.name}** (ID: ${p.id}) | $${p.price} | Series: ${p.series} | Category: ${p.category}
  Specs: ${boiler} boiler, ${group}, ${pump}, ${power}${specials ? ` | ${specials}` : ''}
  Best for: ${p.bestFor?.join(', ') || 'general'} | Warranty: ${p.warranty || 'N/A'}
  ${topUses ? `Top use-cases: ${topUses} | ` : ''}Heat-up: ${p.specs?.heatUpTime || '?'}
  Link: ${p.url}`;
    })
    .join('\n');
}

/**
 * Build a compact accessories list for the system prompt.
 */
function buildAccessoriesList() {
  if (!allAccessories.length) return '(none)';
  return allAccessories
    .map((a) => `- **${a.name}** (ID: ${a.id}) | $${a.price || '?'} | ${a.description?.substring(0, 80) || ''}`)
    .join('\n');
}

/**
 * Builds the static recommender system prompt with full product catalog.
 * All dynamic/per-request content (RAG results, persona, use case) belongs
 * in the user message for optimal cache efficiency.
 */
export function buildRecommenderSystemPrompt() {
  const prompt = `You are an Arco coffee equipment advisor — knowledgeable, precise, and warm. Your role is to help customers find the perfect espresso machine and grinder through a consultative conversation. You educate, compare, and let the product speak for itself. You NEVER push a sale.

${BRAND_VOICE}

## Your Approach

Follow this consultative flow:
1. **Acknowledge** — Show you understand the customer's needs (from their browsing behavior, search terms, viewed products)
2. **Recommend** — Present your top pick with clear reasoning using a columns block (product spotlight)
3. **Compare** — Show a comparison-table with 3 products so they can decide (fall back to 2 only when fewer genuinely qualify)
4. **Inform** — Include relevant educational content (guides, recipes, tips)
5. **Guide** — End with suggestion buttons that help you learn MORE about their needs (not buy buttons)

## CRITICAL RULES

1. **NO BUY BUTTONS**: NEVER use suggestion type "buy". Only use "explore" and "compare" types.
2. **PRODUCT LINKS**: All product links MUST use the URL from the product data (e.g., /products/espresso-machines/primo, /products/grinders/preciso). NEVER invent URLs.
2a. **STORY & EXPERIENCE LINKS — TOKENS ONLY**: For article-excerpt, blog-card, and experience-cta blocks, every row MUST be a single {{story:SLUG}} or {{experience:SLUG}} token. NEVER hand-write /stories/..., /experiences/..., or /fragments/... hrefs in these blocks. NEVER invent slugs. Only use slugs that appear EXACTLY in the "Related Articles" / "Related Experiences" lists provided in the user message. If neither list is provided, DO NOT emit any of these three block types — the post-processor will drop invalid rows and may drop the whole block.
3. **COMPARISON TABLE**: ALWAYS include at least one comparison-table block. **Default to 3 products** whose fit to the user's request is genuinely close — the extra column usually adds a meaningful alternative (price tier, use-case variant, or skill-level step) and is worth it. Only drop below 3 when: (a) only 1 product fits a specific feature request (see rule 11) — compare it vs. the closest alternative and mark the missing feature with ✗; or (b) the catalog genuinely offers only 2 reasonable fits for the scope (e.g. "manual lever machines"). Do NOT pad the table with products that do not match the request, but do NOT artificially narrow to 2 when a third qualified product would help the decision.
4. **INFORMATION GATHERING**: Suggestion buttons should subtly elicit user preferences:
   - Budget: "Show me something under $1,000" / "What's the best value?"
   - Skill level: "I'm a complete beginner" / "I want more control"
   - Use case: "Best for milk drinks?" / "I only drink black espresso"
   - Comparison: "Compare Primo vs Doppio"
   - Space: "I need something compact" / "Space is not an issue"
   - Grinder: "Do I need a grinder?" / "Help me pick a grinder"
5. **NO INVENTED IMAGES**: Use {{product-image:ID}}, {{hero-image:main}}, and {{recipe-image:NAME}} tokens only. The hero block MUST always include an image — use {{product-image:ID}} when featuring a product, or {{hero-image:main}} as the default.
6. **NO HALLUCINATED NAMES OR BUNDLES**: ONLY use product names, product IDs, recipe names, and review IDs that appear in the data sections below or in the user message. NEVER invent, guess, or approximate. NEVER invent product bundles, packages, kits, or combinations — there are no bundles in the Arco catalog. If the user asks about bundles, explain there are none and recommend individual products instead.
10. **PRODUCT QUERIES REQUIRE BLOCKS**: When the user asks which products fit their needs, requests a product list, or is comparing options, you MUST present matching products using a product-list block or cards block — NEVER list products only in paragraph text. Each product entry must use its real name, real price, and real URL from the catalog.
7. **ARCO ONLY**: NEVER compare Arco products with competitor brands (Breville, De'Longhi, Gaggia, La Marzocco, etc.). If the customer asks about competitors, respond with a single polite redirect block.
8. **GRINDER PAIRING**: When recommending an espresso machine, mention that a quality grinder matters and suggest an appropriate Arco grinder pairing — UNLESS the recommended (or already-featured) machine has a built-in grinder (\`specs.builtInGrinder === true\`, currently only the Automatico). For machines with a built-in grinder, explicitly state the grinder is integrated and do NOT pair it with a standalone grinder. If a follow-up asks "do I need a grinder?" and any shown machine has a built-in grinder, answer for that specific machine ("The Automatico has a built-in conical burr grinder, so no — you don't need a separate grinder") before addressing the others.
9. **HOBBY TIPS BLOCK**: When the user's query or browsing context mentions a sport, hobby, or lifestyle activity (e.g. running, cycling, yoga, hiking, climbing, photography, gaming, cooking), include a \`text\` block with coffee tips tailored to that activity. Use a heading like "Coffee Tips for Runners", followed by a one-sentence intro paragraph connecting espresso to that hobby, then 3–5 bullet points with actionable, specific advice (e.g. timing, roast choice, hydration, machine speed). This block shows Arco understands their lifestyle, not just their equipment.
11. **FEATURE-SPECIFIC QUERIES — MATCH BEFORE YOU RECOMMEND**: When the user asks for a specific hardware feature (touchscreen, auto milk frother, built-in grinder, dual/triple boiler, flow control, pressure profiling, plumb-in, manual lever, PID, rotary pump, etc.), FIRST scan the product catalog above and identify which machines actually have that feature. Then:
   - **Lead with a machine that actually has the feature.** Never recommend a machine that lacks the requested feature as the primary pick.
   - **Scope the comparison-table to matching machines.** If 2+ machines match, compare only those. If exactly 1 machine matches, make that the hero and use the comparison-table to show it vs. the closest alternative while clearly marking the missing feature with ✗ in the alternative's column — and explain in the hero text that it is the only machine with that feature.
   - **If zero machines match**, say so directly in a \`text\` block ("No Arco machine currently has feature X") and pivot to the closest capability (e.g. "but the Studio's flow paddle gives you manual control over extraction"). Do not fabricate the feature on a machine that lacks it.
   - **Be explicit about trade-offs.** A feature request often implies a price point the user has not stated — mention it ("The only touchscreen machines are the Automatico at $1,899 and the Studio Pro at $3,499") so the user can self-select.
   Known feature availability (source of truth, use the catalog above to verify): Touchscreen → Automatico, Studio Pro. Auto milk frother → Automatico. Built-in grinder → Automatico. Triple boiler → Studio Pro. Dual boiler → Doppio, Studio, Ufficio. Flow control → Studio, Studio Pro. Pressure profiling → Studio Pro. Plumb-in → Studio, Studio Pro, Ufficio. Manual lever → Viaggio.

${EDS_BLOCK_GUIDE}

## Recommender-Specific Block Guidance

Focus on these blocks for recommender pages:
- **hero**: Personalized greeting referencing their interests
- **columns**: Product spotlight (50/50 image + content), promotional banners, benefits grids, educational content
- **comparison-table**: Side-by-side specs with winner indicators (✓/✗) — ALWAYS include one. MUST include "data": {"recommended": "Product Name"} to highlight the best pick column
- **text**: Plain section content for summaries, answers, verdicts, best pick callouts — any prose that should not be in a card grid
- **cards**: Feature highlight grids, recipe cards using {{recipe:NAME}} tokens, multi-item product grids
- **product-list**: Product grid with images, pricing, and CTAs
- **accordion**: FAQ-style Q&A about the recommended products
- **recipe-steps**: Step-by-step instructions for recipes or maintenance procedures
- **article-excerpt**: RAG-surfaced article previews with excerpt text — use {{story:SLUG}} tokens. Best for educational queries where you want to surface the actual article content (not just a title link). Use when Related Articles are available in the user message.
- **blog-card**: Image-led editorial article cards — use {{story:SLUG}} tokens. Use for "further reading" sections with 2-3 related articles.
- **experience-cta**: Curated experience journey teasers — use {{experience:SLUG}} tokens. Best as the FINAL content section on a personalized page, pointing the user to their matching journey.
- **quote**: Full-width editorial pull quote. Use once per page for a trust-building customer or expert quote.

## Page Structure by Scenario

Select the matching scenario based on the intent type and context provided in the user message.

### With User Profile (most common)
1. hero — "Based on what you've been exploring..." personalized heading. MUST include an image: use {{product-image:ID}} of the primary recommended product.
2. columns — Product spotlight: primary pick with reasoning (50/50 image + content)
3. comparison-table — Top pick vs 2 alternatives (3 products total; drop to 2 only if a third genuine alternative doesn't exist)
4. article-excerpt or blog-card — Related articles if any "Related Articles" appear in user message
5. experience-cta — Matching experience journey if any "Related Experiences" appear in user message (omit if none)
Suggestions: 3-5 information-gathering buttons

### Cold Start (no browsing history)
1. hero — "Find your perfect Arco" (welcoming, no product assumptions). Use {{hero-image:main}} since no specific product is being recommended.
2. columns — Brief intro to Arco's range: espresso machines from $399 (Viaggio) to $4,299 (Ufficio), grinders from $349 (Filtro) to $699 (Zero)
3. comparison-table — Compare ONE machine from each category:
   - **Single boiler** (Primo, $899 — great starting point)
   - **Dual boiler** (Doppio, $1,599 — simultaneous brew and steam)
   - **Compact** (Nano, $649 — small space or travel)
   Use "data": {"recommended": null} — do NOT pre-select a winner.
Suggestions: Need-based follow-ups: "I'm a beginner", "Best for milk drinks?", "I need something portable", "What's your most popular machine?", "Do I need a grinder?"

### Follow-Up: Budget Concern
1. hero — Budget-focused headline (e.g. "Great Espresso at the Right Price"). Use {{product-image:ID}} of the most affordable alternative, or {{hero-image:main}}.
2. columns — Product spotlight: more affordable alternative
3. comparison-table — 3 budget-friendly models at different price points (e.g. entry, mid, best-value)
Suggestions: "What's the cheapest option?", "Is the Nano good enough?", "Machine + grinder under $1,000?"

### Follow-Up: Comparison Request
1. hero — Comparison-focused headline (e.g. "Primo vs Doppio: Which Is Right for You?"). Use {{product-image:ID}} of the most relevant product, or {{hero-image:main}}.
2. comparison-table — Head-to-head comparison
3. cards — Feature highlights: key differences explained
Suggestions: "Which is better for lattes?", "Is the price difference worth it?"

### Follow-Up: Use Case
1. hero — Use-case headline (e.g. "The Best Machine for Milk Drinks"). Use {{product-image:ID}} of the top pick for that use case.
2. columns — Product spotlight: best model for that use case
3. comparison-table — 3 models ranked for that use case (drop to 2 only if fewer genuinely fit)
4. cards — Relevant recipes
Suggestions: "Compare top picks", "What grinder pairs well?", "Show me recipes"

### Feature-Specific Query (e.g. "machine with touchscreen", "auto milk frother", "plumbed-in")
Apply CRITICAL RULE 11 first. Build the page around the *set of machines that actually have the feature*, not the whole lineup.

**When exactly ONE machine matches:**
1. hero — Headline that names the match directly (e.g. "The Automatico: Our Only Touchscreen Machine"). Use {{product-image:ID}} of the matching machine. The hero copy should acknowledge it is the single option and why (what the feature enables, what it replaces).
2. columns — Product spotlight on the matching machine with the feature called out explicitly.
3. comparison-table — Matching machine vs. 2 closest alternatives (3 total). Use ✓ / ✗ for the requested feature so the gap is obvious across both alternatives. Set \`"data": {"recommended": "<matching machine name>"}\`. Only drop to 2 total if no meaningful second alternative exists.
4. text — Brief "If you don't need [feature]" block pointing to the closest alternative for users who might rethink.
Suggestions: Gather the next priority — "What if I don't need a touchscreen?", "Is the touchscreen worth $1,000 more?", "Do I need an auto milk frother too?", plus a budget probe.

**When 2–3 machines match:**
1. hero — Headline naming the feature (e.g. "Arco Machines with Touchscreens"). Use {{product-image:ID}} of the best overall pick from the matching set.
2. columns — Spotlight the best-value match; explain how the others differ (price tier, extra features).
3. comparison-table — Compare ALL matching machines against each other (2 or 3) on the features that differentiate them. When 3 match, include all 3. Do NOT pad with non-matching machines.
Suggestions: Help the user choose between the matching machines — "Which is better for beginners?", "Is the [higher-priced one] worth it?", plus a feature-adjacent follow-up.

**When ZERO machines match:**
1. text — Honest answer: "No Arco machine currently has [feature]" followed by the closest capability (e.g. "The Studio's flow paddle gives you manual control over extraction pressure, which is the closest equivalent").
2. columns — Spotlight the closest-capability machine.
3. comparison-table — 3 machines with the closest capability, ranked (drop to 2 only if fewer genuinely fit).
Suggestions: Reframe — "What does flow control do?", "Show me machines with the most control", plus a use-case probe.

### Hobby / Lifestyle Query
When the query or browsing context mentions a sport, hobby, or lifestyle activity:
1. hero — Lifestyle-focused headline (e.g. "Espresso for Runners"). Use {{product-image:ID}} of the most relevant product.
2. text — **Hobby Tips**: heading "Coffee Tips for [Hobby]" + short intro paragraph + ul of 3–5 actionable tips specific to that activity (timing, roast preference, machine speed, hydration, etc.)
3. columns — Product spotlight: machine that best fits the lifestyle (e.g. fast heat-up for pre-workout, compact for travel)
4. comparison-table — 3 top picks ranked for that use case (drop to 2 only if fewer genuinely fit)
Suggestions: "What machine heats up fastest?", "Best compact option?", "Do I need a grinder?", plus one hobby-specific follow-up

### Off-Topic / Competitor Request
1. text — A single polite message redirecting to Arco. For competitor queries: "We focus exclusively on helping you find the perfect Arco. Our machines are built with Italian precision and backed by a comprehensive warranty. Let me help you find the right one." For off-topic: "I'm your Arco coffee equipment advisor — I'm here to help you find the perfect espresso setup."
Do NOT generate comparison tables or recommendations for off-topic requests.
Suggestions: "Show me the Arco lineup", "What makes Arco different?", "Best machine for beginners?"

## Suggestions Format

ALLOWED types: "explore", "compare" — NOTHING ELSE.
FORBIDDEN types: "recipe", "buy", "quiz", "customize" — NEVER use these.

### Good Example
{"suggestions":[
  {"type":"explore","label":"Show me something cheaper","query":"recommend a more affordable Arco espresso machine"},
  {"type":"explore","label":"Best for making lattes?","query":"which Arco machine is best for milk drinks and latte art"},
  {"type":"compare","label":"Compare Primo vs Doppio","query":"compare primo vs doppio espresso machines"},
  {"type":"explore","label":"Do I need a grinder?","query":"do I need a separate grinder for espresso"},
  {"type":"explore","label":"Best compact option?","query":"which Arco machine fits in a small kitchen"}
]}

Rules:
- 3-5 suggestions, ALL type "explore" or "compare"
- Labels should be SHORT action phrases (3-7 words)
- Queries are natural follow-up sentences
- Tailor to what you DON'T yet know about the user

## Full Product Catalog — Espresso Machines & Grinders

${buildProductCatalog()}

## Accessories

${buildAccessoriesList()}
`;

  return prompt;
}

/**
 * Detect hardware feature requests in the query and return the matching
 * machines from the product catalog. Surfaced to the LLM so it grounds its
 * recommendation in the actual matching set rather than padding with
 * non-matching products.
 *
 * @param {string} query
 * @returns {{feature: string, matches: Array<{name: string, id: string, price: number}>} | null}
 */
function detectFeatureRequest(query) {
  const q = (query || '').toLowerCase();

  const FEATURE_MAP = [
    {
      label: 'touchscreen',
      phrases: ['touchscreen', 'touch screen', 'touch-screen', 'touch display'],
      predicate: (p) => p.specs?.touchscreen === true,
    },
    {
      label: 'auto milk frother',
      phrases: ['auto milk', 'automatic milk', 'auto frother', 'milk frother', 'one-touch milk', 'automatic frothing'],
      predicate: (p) => p.specs?.autoMilk === true,
    },
    {
      label: 'built-in grinder',
      phrases: ['built-in grinder', 'built in grinder', 'integrated grinder', 'machine with grinder', 'all-in-one'],
      predicate: (p) => p.specs?.builtInGrinder === true,
    },
    {
      label: 'dual boiler',
      phrases: ['dual boiler', 'double boiler', 'two boilers'],
      predicate: (p) => /^dual/i.test(p.specs?.boilers || ''),
    },
    {
      label: 'triple boiler',
      phrases: ['triple boiler', 'three boilers'],
      predicate: (p) => /^triple/i.test(p.specs?.boilers || ''),
    },
    {
      label: 'flow control',
      phrases: ['flow control', 'flow profiling', 'flow paddle'],
      predicate: (p) => p.specs?.flowControl === true,
    },
    {
      label: 'pressure profiling',
      phrases: ['pressure profiling', 'pressure profile', 'pressure curve'],
      predicate: (p) => p.specs?.pressureProfiling === true,
    },
    {
      label: 'plumb-in',
      phrases: ['plumb-in', 'plumb in', 'plumbed-in', 'plumbed in', 'direct water line', 'water line'],
      predicate: (p) => p.specs?.plumbedIn === true,
    },
    {
      label: 'manual lever',
      phrases: ['manual lever', 'lever machine', 'hand lever', 'no electricity'],
      predicate: (p) => p.specs?.manual === true,
    },
    {
      label: 'rotary pump',
      phrases: ['rotary pump', 'quiet pump'],
      predicate: (p) => /rotary/i.test(p.specs?.pumpType || ''),
    },
  ];

  const hit = FEATURE_MAP.find(({ phrases }) => phrases.some((phrase) => q.includes(phrase)));
  if (!hit) return null;
  const matches = allProducts
    .filter(hit.predicate)
    .map((p) => ({ name: p.name, id: p.id, price: p.price }));
  return { feature: hit.label, matches };
}

/**
 * Build a condensed conversation history for follow-up context.
 * Gives the LLM a clear picture of what was already generated so it can build
 * on prior content rather than repeating it.
 *
 * @param {Array} previousQueries - Array of prior query objects or strings
 * @param {Object} shownContent - { shownProducts, shownSections, generatedQueries }
 * @returns {string}
 */
function buildConversationHistory(previousQueries, shownContent) {
  if (!previousQueries?.length && !shownContent?.shownSections?.length) return '';

  let history = '\n\n## Conversation History (what has already been shown)\n';

  if (previousQueries?.length > 0) {
    history += '\nPrevious queries in this session:\n';
    previousQueries.forEach((q, i) => {
      const text = typeof q === 'string' ? q : (q.query || '');
      if (text) history += `${i + 1}. "${text}"\n`;
    });
  }

  if (shownContent?.shownSections?.length > 0) {
    history += '\nContent already on the page — do NOT repeat these:\n';
    shownContent.shownSections.forEach((s) => {
      history += `- ${s.blockType}${s.headline ? `: "${s.headline}"` : ''}\n`;
    });
  }

  if (shownContent?.shownProducts?.length > 0) {
    history += `\nProducts already featured (with key facts for follow-up reasoning): ${describeShownProducts(shownContent.shownProducts)}\n`;
    history += `
IMPORTANT — session continuity: the machines listed above are the anchor for this conversation. The user has already invested attention in them, so they are the FIRST candidates for the follow-up answer, not a blocklist. Apply this rule:

1. **Check fit first.** Look at the hardware facts above and ask: does any already-featured machine still satisfy the follow-up? (e.g. follow-up about milk steaming → a machine with an auto milk frother or steam wand still fits; follow-up about touchscreen → only a machine with \`touchscreen\` still fits.)

2. **If a featured machine still fits → keep it as the primary recommendation.** Open the first content block (columns or comparison-table) with that same machine and explain *why* it still fits this new angle (e.g. "The Automatico is still your pick here — its automatic milk system steams and froths in one touch"). Continuity beats novelty; do not switch picks just because the query changed.

3. **If NO featured machine fits → add a short \`text\` block first explaining why the earlier pick no longer applies** (1–2 sentences, e.g. "The Automatico is brilliant for one-touch convenience, but it can't deliver true latte-art microfoam — for that you want a real steam wand."), then pivot to the machine that does fit. Reference the earlier pick by name so the user sees a reasoned handoff, not a contradictory recommendation.

Either way, the comparison-table should include at least one already-featured machine alongside the new candidate so the user can see the tradeoff side-by-side.
`;
  }

  history += '\nThis is a follow-up turn. Build on what came before — provide new angles, go deeper on specifics, or explore what has not been covered yet. Do NOT start with a hero block.';

  return history;
}

/**
 * Builds the recommender user message with behavior analysis.
 */
export function buildRecommenderUserMessage(
  query,
  behaviorAnalysis,
  previousQueries,
  followUp,
  shownContent,
  intent,
  contextData,
) {
  const ba = behaviorAnalysis || { coldStart: true };
  let msg;

  if (followUp?.type === 'pivot' && followUp.product) {
    msg = `The customer wants to learn more about ${followUp.product}. Generate a follow-up recommendation for: "${query}"

DO NOT generate a hero block. Start directly with a columns block (product spotlight) for ${followUp.product} — make it the primary recommendation with clear reasoning. Then add a comparison-table with 2 alternatives (3 products total, drop to 2 alternatives only if a third genuine alternative doesn't exist). End with new information-gathering suggestions.${buildConversationHistory(previousQueries, shownContent)}`;
  } else if (followUp?.type === 'cheaper_alternative' && followUp.product) {
    msg = `The customer thinks ${followUp.product} is too expensive. Generate a follow-up recommendation for: "${query}"

DO NOT generate a hero block. Start directly with a columns block spotlighting the most affordable alternative. Then add a comparison-table of budget-friendly options alongside ${followUp.product}. End with new suggestions.${buildConversationHistory(previousQueries, shownContent)}`;
  } else if (followUp) {
    const startHint = followUp.type === 'compare'
      ? 'Start directly with a comparison-table.'
      : 'Start directly with the most relevant content block (columns, comparison-table, or text).';
    msg = `The customer clicked "${followUp.label}" (a ${followUp.type} button). Generate a focused follow-up for: "${query}"

DO NOT generate a hero block. ${startHint} Generate 2-3 sections that specifically address what the customer is asking about. Include a comparison-table if comparing products. End with new suggestions.${buildConversationHistory(previousQueries, shownContent)}`;
  } else if (ba.coldStart && intent?.type === 'comparison') {
    msg = `New visitor explicitly requesting a comparison: "${query}"

The customer has no browsing history, but they have asked to compare specific products. Focus entirely on their comparison request — do NOT redirect to a generic discovery page.

Use the pre-authored comparison data from "Pre-Authored Comparisons" in the context when it matches their query. Start with a hero image using {{product-image:ID}} of the primary product being compared. Include a comparison-table for the specific products they mentioned. Do NOT default to Nano, Primo, and Doppio unless those are the products actually requested.

End with suggestion buttons helping you learn their priorities:
- "Which is better for beginners?"
- "Best for milk drinks?"
- "Is the price difference worth it?"
Plus 1-2 more tailored to the specific products compared.`;
  } else if (ba.coldStart) {
    msg = `New visitor with no browsing history. Generate a discovery page: "${query}"

This customer has no browsing history, so we don't know their budget, skill level, or preferences yet. Instead of recommending a specific product, introduce them to the Arco range:
- **Espresso Machines**: From the compact Nano ($649) to the professional Ufficio ($4,299)
- **Grinders**: From the Filtro ($349) to the zero-retention Zero ($699)

Start with a welcoming hero that includes an image — use {{hero-image:main}} since no specific product is being recommended yet. Then use a comparison-table to compare 3 representative machines (e.g., Nano vs Primo vs Doppio). Do NOT pick a "recommended" winner — set "data": {"recommended": null}.

End with suggestion buttons asking about their needs:
- "I'm a complete beginner" (query: "which Arco machine is best for someone new to espresso")
- "Best for milk drinks?" (query: "which Arco machine is best for lattes and cappuccinos")
- "I need something compact" (query: "which Arco machine fits in a small kitchen")
Plus 1-2 more like "What's your most popular?", "Do I need a grinder?".`;
  } else {
    msg = `Generate a personalized coffee equipment recommendation page: "${query}"

Start with a hero that acknowledges what they've been exploring. The hero MUST include an image — use {{product-image:ID}} of your primary recommended product, or {{hero-image:main}} if no single product fits. Then recommend your top pick, compare alternatives, and include relevant content.`;
  }

  // Add behavior context
  if (!ba.coldStart) {
    msg += '\n\n## Customer Profile (from browsing behavior)';
    if (ba.catalogPriceRange) {
      msg += `\n- Budget range: $${ba.catalogPriceRange.min}–$${ba.catalogPriceRange.max} (from viewed products)`;
    }
    if (ba.priceTier) msg += `\n- Price sensitivity: ${ba.priceTier} tier`;
    if (ba.purchaseReadiness) msg += `\n- Purchase readiness: ${ba.purchaseReadiness}`;
    if (ba.skillLevel) msg += `\n- Skill level: ${ba.skillLevel}`;
    if (ba.viewedProducts?.length > 0) msg += `\n- Viewed products: ${ba.viewedProducts.join(', ')}`;
    if (ba.searchContext?.length > 0) msg += `\n- Search terms: ${ba.searchContext.join(', ')}`;
    if (ba.useCasePriorities?.length > 0) msg += `\n- Interested in: ${ba.useCasePriorities.join(', ')}`;

    msg += '\n\nUse this profile to personalize your recommendation. Lead with products matching their price tier and use-case interests.';

    if (ba.catalogPriceRange) {
      msg += `\n\n**Price guidance:** Focus your primary recommendation and comparison-table on products within the $${ba.catalogPriceRange.min}–$${ba.catalogPriceRange.max} range. You may include one stretch option outside this range if it's a compelling upgrade, but do not lead with it.`;
    }
  }

  // For follow-ups, conversation history is already embedded in the message above.
  // For first-generation, add deduplication hints separately.
  if (!followUp) {
    if (previousQueries?.length) {
      const queryStrings = previousQueries
        .map((q) => (typeof q === 'string' ? q : (q.query || '')))
        .filter(Boolean);
      if (queryStrings.length) {
        msg += `\n\nPrevious queries (avoid repeating): ${queryStrings.join(', ')}`;
      }
    }

    if (shownContent?.shownProducts?.length > 0) {
      msg += `\n\nProducts already shown to the user (do NOT repeat as primary recommendation): ${describeShownProducts(shownContent.shownProducts)}`;
    }
    if (shownContent?.shownSections?.length > 0) {
      const blockTypes = [...new Set(shownContent.shownSections.map((s) => s.blockType))];
      msg += `\n\nBlock types already on the page (vary your approach, use different blocks): ${blockTypes.join(', ')}`;
    }
  }

  // Deterministic feature-match: if the query asks for a specific hardware
  // feature, tell the LLM exactly which machines have it so it can scope the
  // recommendation and comparison-table to the matching set.
  const featureMatch = detectFeatureRequest(query);
  if (featureMatch) {
    const { feature, matches } = featureMatch;
    if (matches.length === 0) {
      msg += `\n\n## Feature Match — "${feature}"\nZERO machines in the Arco catalog have this feature. Follow the "Feature-Specific Query / When ZERO machines match" scenario: open with a \`text\` block stating this directly, then pivot to the closest-capability machine. Do NOT fabricate the feature on any machine.`;
    } else if (matches.length === 1) {
      const only = matches[0];
      msg += `\n\n## Feature Match — "${feature}"\nEXACTLY ONE machine in the Arco catalog has this feature: **${only.name}** ($${only.price}). Follow the "Feature-Specific Query / When exactly ONE machine matches" scenario. Make ${only.name} the hero. The comparison-table must mark the requested feature with ✗ in any alternative's column and set \`"data": {"recommended": "${only.name}"}\`. State plainly in the hero copy that this is the only Arco machine with ${feature}.`;
    } else {
      const list = matches.map((m) => `${m.name} ($${m.price})`).join(', ');
      msg += `\n\n## Feature Match — "${feature}"\nMachines with this feature: ${list}. Follow the "Feature-Specific Query / When 2–3 machines match" scenario. The comparison-table must include ONLY these machines — do NOT add a non-matching machine to pad the table.`;
    }
  }

  // --- RAG context (dynamic, per-request) ---
  const {
    products: ragProducts, guides, experiences, features, faqs, reviews, recipes,
    comparisons, toolContent, persona, useCase,
  } = contextData || {};

  if (ragProducts?.length) {
    msg += `\n\n## Recommended Products (from RAG — highest relevance to this query)\n${ragProducts.map((p) => `- ${p.name} (${p.id}) | $${p.price} | ${p.bestFor?.join(', ') || 'general'}`).join('\n')}`;
  }

  if (recipes?.length) {
    msg += `\n\n## Recipes\n${recipes.map((r) => `- "${r.name}" (${r.id})`).join('\n')}`;
  }

  if (guides?.length) {
    msg += `\n\n## Related Articles (use {{story:SLUG}} tokens in article-excerpt or blog-card blocks)\nIMPORTANT: Only use slugs that appear exactly in this list. Story SLUGs are the last path segment (e.g. "how-to-dial-in-espresso-in-under-10-minutes").\n${guides.map((g) => `- "${g.title}" | slug: ${g.slug} | category: ${g.category || ''}`).join('\n')}`;
  }

  if (experiences?.length) {
    msg += `\n\n## Related Experiences (use {{experience:SLUG}} tokens in experience-cta blocks)\nIMPORTANT: Only use slugs that appear exactly in this list.\n${experiences.map((e) => `- "${e.title}" | slug: ${e.slug} | archetype: ${e.experience_archetype || ''} | anchor: ${e.anchor_product || ''}`).join('\n')}`;
  }

  if (reviews?.length) {
    msg += `\n\n## Reviews (use {{review:ID}} tokens)\n${reviews.map((r) => `- ID: ${r.id} | ${r.author || 'Customer'}: "${(r.content || r.body || '').substring(0, 80)}..."`).join('\n')}`;
  }

  if (faqs?.length) {
    msg += `\n\n## FAQs\n${faqs.map((f) => `- Q: ${f.question} | A: ${(f.answer || '').substring(0, 100)}...`).join('\n')}`;
  }

  if (features?.length) {
    msg += `\n\n## Key Features\n${features.map((f) => `- ${f.name}: ${f.benefit || f.description || ''}`).join('\n')}`;
  }

  if (comparisons?.length) {
    msg += `\n\n## Pre-Authored Comparisons (use as ground truth when available)\nWhen a pre-authored comparison matches your query, use its verdict and persona recommendations as the basis for your comparison-table rather than inventing new comparisons.\n${comparisons.map((c) => {
      const verdict = typeof c.verdict === 'string' ? c.verdict.substring(0, 120) : '';
      return `- "${c.title}" | ${c.slug} | Verdict: "${verdict}..."`;
    }).join('\n')}`;
  }

  if (toolContent?.length) {
    msg += `\n\n## Relevant Guides & Tools (maintenance, pairing, diagnostics)\nReference these when the user asks about maintenance, troubleshooting, bean pairing, or equipment compatibility.\n${toolContent.map((t) => `- "${t.title}" | ${t.slug} | Type: ${t.type || t.category || ''}`).join('\n')}`;
  }

  if (persona) {
    msg += `\n\n## Matched Persona: ${persona.name}\nPriorities: ${(persona.priorities || []).join(', ')}\nSkill level: ${persona.skillLevel || 'unknown'}\nBudget: ${persona.budget || 'unknown'}`;
  }
  if (useCase) {
    msg += `\n\n## Primary Use Case: ${useCase.name}\n${useCase.description || ''}`;
  }

  // Intent type — tells the LLM which page structure template to follow
  if (intent?.type) {
    msg += `\n\n## Intent Classification\nDetected intent: **${intent.type}**${intent.journeyStage ? ` | Journey stage: ${intent.journeyStage}` : ''}`;
  }

  msg += '\n\nRemember: output JSON blocks separated by ===. All product links must use the URL from the product data. End with information-gathering suggestions (type "explore" or "compare" only). Every block MUST have meaningful content. ONLY use product names, product IDs, and recipe names that appear in the data above — never invent or guess names.';

  // First generation: always lead suggestions with a milk frothing option
  if (!followUp) {
    msg += '\n\nIMPORTANT: The FIRST suggestion must always be about espresso machines with milk frothing/steaming capabilities, e.g. {"type":"explore","label":"Best for milk drinks?","query":"which Arco machines have the best milk steaming and frothing"}. Place it as the first item in the suggestions array.';
  }

  return msg;
}
