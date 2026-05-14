# System Prompt Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the recommender prompt so the system message is 100% static (cacheable by Bedrock) and all per-request context lives in the user message.

**Architecture:** Split `buildRecommenderSystemPrompt()` into a zero-parameter static function. Move all dynamic content (RAG, behavior, persona, session, feature detection, intent) into `buildRecommenderUserMessage()`. Add Bedrock `cachePoint` marker in the provider.

**Tech Stack:** Vanilla JS (ES6+), Cloudflare Workers, AWS Bedrock Converse Stream API

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `workers/recommender/src/recommender-prompt.js` | Major refactor | Static system prompt + dynamic user message builder |
| `workers/recommender/src/pipeline/steps/build-recommender-prompt.js` | Update call sites | Pass all dynamic context to user message builder |
| `workers/recommender/src/providers/bedrock.js` | Add cachePoint | Insert cache control marker for Bedrock Converse API |

---

### Task 1: Refactor `buildRecommenderSystemPrompt` to be static

**Files:**
- Modify: `workers/recommender/src/recommender-prompt.js:127-365`

The current function takes `(contextData, priceFilter)` and embeds RAG results, persona, use-case, and filtered catalog. The new version takes no parameters and includes the full catalog + all page structure templates.

- [ ] **Step 1: Remove parameters and dynamic sections from `buildRecommenderSystemPrompt`**

Replace the function signature and body. Remove all RAG-dependent sections (products, guides, experiences, reviews, FAQs, features, comparisons, toolContent, persona, useCase) and the price filter logic. Include the full unfiltered catalog. Add an instruction telling the LLM to select the page structure template based on the intent provided in the user message.

```javascript
/**
 * Builds the static recommender system prompt — identical for every request.
 * Contains brand voice, rules, block guide, all page structure templates,
 * and the full product + accessories catalog (never filtered).
 */
export function buildRecommenderSystemPrompt() {
  return `You are an Arco coffee equipment advisor — knowledgeable, precise, and warm. Your role is to help customers find the perfect espresso machine and grinder through a consultative conversation. You educate, compare, and let the product speak for itself. You NEVER push a sale.

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
}
```

Key changes from the original:
- Function takes no parameters
- `buildProductCatalog()` is called with no `priceFilter` argument (always full catalog)
- All RAG sections (products, guides, experiences, reviews, FAQs, features, comparisons, toolContent, persona, useCase) are removed
- Added instruction "Select the matching scenario based on the intent type and context provided in the user message"
- Changed references from "data sections below" to "data sections below or in the user message" in rule 6
- Changed "Related Articles/Experiences" references from "in context data" to "in user message"

- [ ] **Step 2: Update `buildProductCatalog` to take no parameters**

Remove the `priceFilter` parameter and the filter logic:

```javascript
/**
 * Build a compact product catalog string for the system prompt.
 * Always includes the full catalog — price filtering is communicated
 * to the LLM via the user message so the system prompt stays static/cacheable.
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
```

- [ ] **Step 3: Verify lint passes on the modified file**

Run: `cd /Users/ffroese/git/arco/.claude/worktrees/system-prompt-tuning && npm run lint -- workers/recommender/src/recommender-prompt.js`
Expected: 0 errors (warnings OK)

- [ ] **Step 4: Commit the static system prompt refactor**

```bash
git add workers/recommender/src/recommender-prompt.js
git commit -m "refactor(prompt): make system prompt fully static for cache efficiency

Remove all dynamic parameters (RAG context, price filter, persona, use-case)
from buildRecommenderSystemPrompt(). Include full unfiltered catalog and all
page structure templates. Dynamic content moves to user message in next commit.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Move all dynamic content into `buildRecommenderUserMessage`

**Files:**
- Modify: `workers/recommender/src/recommender-prompt.js:492-612`

The user message builder already handles query, behavior analysis, follow-up context, shown content, and feature detection. Now it must also include: RAG-retrieved products, guides, experiences, reviews, FAQs, features, comparisons, toolContent, persona, use-case, and intent type.

- [ ] **Step 1: Expand the function signature to accept RAG context and intent**

```javascript
/**
 * Builds the recommender user message with all per-request dynamic context.
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
```

The new `contextData` parameter carries:
```javascript
{
  products, guides, experiences, features, faqs, reviews, recipes,
  comparisons, toolContent, persona, useCase,
}
```

- [ ] **Step 2: Add RAG context sections to the user message**

After the existing feature-match block (around line 603 in the original), before the final "Remember:" paragraph, insert the RAG context. Add this code after the `featureMatch` block and before the final `msg += '\n\nRemember: ...'` line:

```javascript
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
```

- [ ] **Step 3: Add price tier instruction to the user message**

The behavior analysis section (lines 551-563 in the original) already adds price info. Add an explicit instruction after the existing `msg += '\n\nUse this profile to personalize...'` line to tell the LLM how to filter:

```javascript
    if (ba.catalogPriceRange) {
      msg += `\n\n**Price guidance:** Focus your primary recommendation and comparison-table on products within the $${ba.catalogPriceRange.min}–$${ba.catalogPriceRange.max} range. You may include one stretch option outside this range if it's a compelling upgrade, but do not lead with it.`;
    }
```

- [ ] **Step 4: Verify lint passes**

Run: `cd /Users/ffroese/git/arco/.claude/worktrees/system-prompt-tuning && npm run lint -- workers/recommender/src/recommender-prompt.js`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add workers/recommender/src/recommender-prompt.js
git commit -m "feat(prompt): move all dynamic context into user message

RAG results, persona, use-case, intent classification, and price guidance
now live in the user message. System prompt is fully static and cacheable.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Update the pipeline step to pass dynamic context to user message

**Files:**
- Modify: `workers/recommender/src/pipeline/steps/build-recommender-prompt.js`

The step currently passes `contextData` and `priceFilter` to the system prompt builder and only passes query/behavior/followUp/shownContent/intent to the user message builder. Now the system prompt takes no args and the user message gets the full context.

- [ ] **Step 1: Update the pipeline step**

Replace the full file contents:

```javascript
/**
 * Build Recommender Prompt Step — assembles system and user prompts
 * for the Arco coffee equipment recommender.
 * Reads ctx.rag.*, ctx.request.*, ctx.intent. Writes ctx.prompt.system, ctx.prompt.user.
 */

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../../recommender-prompt.js';

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function buildRecommenderPrompt(ctx, config = {}, env = {}) {
  const start = Date.now();

  ctx.prompt.system = buildRecommenderSystemPrompt();

  const contextData = {
    products: ctx.rag.products,
    guides: ctx.rag.guides,
    experiences: ctx.rag.experiences,
    features: ctx.rag.features,
    faqs: ctx.rag.faqs,
    reviews: ctx.rag.reviews,
    recipes: ctx.rag.recipes,
    comparisons: ctx.rag.comparisons,
    toolContent: ctx.rag.toolContent,
    persona: ctx.rag.persona,
    useCase: ctx.rag.useCase,
  };

  ctx.prompt.user = buildRecommenderUserMessage(
    ctx.request.query,
    ctx.rag.behaviorAnalysis,
    ctx.request.previousQueries,
    ctx.request.followUp,
    ctx.request.shownContent,
    ctx.intent,
    contextData,
  );

  ctx.timings.prompt = Date.now() - start;
}
```

Key change: `buildRecommenderSystemPrompt()` now takes no arguments. `contextData` is passed as the 7th argument to `buildRecommenderUserMessage`.

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/ffroese/git/arco/.claude/worktrees/system-prompt-tuning && npm run lint -- workers/recommender/src/pipeline/steps/build-recommender-prompt.js`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/src/pipeline/steps/build-recommender-prompt.js
git commit -m "refactor(pipeline): pass dynamic context to user message builder

System prompt is now called with no args (fully static). All RAG context
flows through the user message parameter.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Add Bedrock prompt caching (`cachePoint`)

**Files:**
- Modify: `workers/recommender/src/providers/bedrock.js:90-100`

Bedrock's Converse API supports a `cachePoint` block in the `system` array that tells the service to cache everything before that marker. The marker goes after the last system content block.

- [ ] **Step 1: Add cachePoint to the system message array**

In `bedrock.js`, modify the section that builds `systemParts` and constructs the request body (lines 90-100):

```javascript
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const turnMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
  }));

  const body = {
    messages: turnMessages,
    inferenceConfig: { maxTokens, temperature },
  };
  if (systemParts.length) {
    // Append cachePoint after system content — Bedrock caches the prefix
    // up to this marker, reducing cost (90% discount) and latency on repeat calls.
    body.system = [...systemParts, { cachePoint: { type: 'default' } }];
  }
```

The only change is line `body.system = [...systemParts, { cachePoint: { type: 'default' } }];` — previously it was `body.system = systemParts;`.

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/ffroese/git/arco/.claude/worktrees/system-prompt-tuning && npm run lint -- workers/recommender/src/providers/bedrock.js`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add workers/recommender/src/providers/bedrock.js
git commit -m "feat(bedrock): enable prompt caching via cachePoint marker

Appends a cachePoint block after system content in every Bedrock Converse
request. Bedrock caches the static system prompt prefix, reducing input
token cost by 90% and improving TTFT on subsequent requests.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Smoke test with the local dev environment

**Files:**
- No file changes — validation only

- [ ] **Step 1: Deploy branch worker and run a test query**

```bash
cd /Users/ffroese/git/arco/.claude/worktrees/system-prompt-tuning/workers/recommender
npm run deploy:branch
```

Then test with curl:

```bash
curl -N -H 'Content-Type: application/json' \
  -d '{"query":"best espresso machine for beginners","sessionId":"test-cache","pageId":"test-1","runId":"test-run-1","pageUrl":"http://localhost:3000/?q=test"}' \
  https://system-prompt-tuning-arco-recommender.franklin-prod.workers.dev/api/generate
```

Expected: streaming NDJSON response with sections and suggestions, no errors.

- [ ] **Step 2: Run a second request to verify caching (check TTFT improvement)**

```bash
curl -N -H 'Content-Type: application/json' \
  -d '{"query":"machine with touchscreen","sessionId":"test-cache","pageId":"test-2","runId":"test-run-2","pageUrl":"http://localhost:3000/?q=test2"}' \
  https://system-prompt-tuning-arco-recommender.franklin-prod.workers.dev/api/generate
```

Expected: TTFT should be noticeably lower on this second call (same system prompt prefix cached). Check the response `debug.timings` for `llmStart` → first delta timing.

- [ ] **Step 3: Run the coffee-dev eval suite (3 queries)**

Use the admin API to run a minimal eval and verify quality hasn't regressed:

```bash
curl -u admin:$ADMIN_TOKEN -H 'Content-Type: application/json' \
  -d '{"suiteId":"coffee-dev","models":[{"provider":"bedrock","model":"us.anthropic.claude-sonnet-4-20250514"}],"judgeModel":"us.anthropic.claude-sonnet-4-20250514","queryConcurrency":1,"skipJudge":false}' \
  https://system-prompt-tuning-arco-recommender.franklin-prod.workers.dev/api/admin/evaluations/start
```

Expected: Returns `{ evalRunId, queryCount: 3, ... }`. Poll progress until complete. All 3 queries should generate valid pages with no blockers.

- [ ] **Step 4: Verify no lint issues across all modified files**

```bash
cd /Users/ffroese/git/arco/.claude/worktrees/system-prompt-tuning
npm run lint -- workers/recommender/src/recommender-prompt.js workers/recommender/src/pipeline/steps/build-recommender-prompt.js workers/recommender/src/providers/bedrock.js
```

Expected: 0 errors
