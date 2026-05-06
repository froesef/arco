/**
 * Deterministic per-variant checks. Run alongside the LLM judge during eval.
 *
 * Returns { passed: boolean, violations: Violation[], counts }.
 *
 * Violations are categorised so the admin UI can group them. Severity is one of:
 *   'blocker' — failures that should cap the composite score (broken tokens,
 *               unbalanced HTML, expected-behavior misses)
 *   'warn'    — soft signals (gold mustMentionAny missed, low product count
 *               when query asked for products)
 *
 * The judge measures editorial quality. These checks measure structural
 * correctness — the things a deterministic parser can verify perfectly that
 * an LLM judge often glosses over.
 */

const TOKEN_FAIL_RE = /<!--\s*(unknown|unpublished)\s+([a-z][a-z- ]*?):\s*([^>]*?)\s*-->/gi;

const TAGS_TO_BALANCE = ['div', 'p', 'a', 'picture', 'ul', 'ol', 'li', 'table', 'tr', 'td'];

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function detectBrokenTokens(html) {
  const violations = [];
  const seen = new Set();
  TOKEN_FAIL_RE.lastIndex = 0;
  let match = TOKEN_FAIL_RE.exec(html);
  while (match) {
    const [, kind, type, ref] = match;
    const key = `${kind}|${type}|${ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({
        category: 'broken-token',
        severity: 'blocker',
        message: `${kind} ${type.trim()}: ${ref.trim()}`,
      });
    }
    match = TOKEN_FAIL_RE.exec(html);
  }
  return violations;
}

function checkTagBalance(html) {
  const violations = [];
  TAGS_TO_BALANCE.forEach((tag) => {
    const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    const opens = (html.match(openRe) || []).length;
    const closes = (html.match(closeRe) || []).length;
    if (opens !== closes) {
      violations.push({
        category: 'unbalanced-html',
        severity: 'blocker',
        message: `<${tag}> opens=${opens} closes=${closes}`,
      });
    }
  });
  return violations;
}

function checkBlockCount(blocks) {
  const violations = [];
  const n = blocks.length;
  if (n < 3) {
    violations.push({
      category: 'block-count',
      severity: 'blocker',
      message: `only ${n} block(s) — page is too thin (min 3)`,
    });
  } else if (n > 25) {
    violations.push({
      category: 'block-count',
      severity: 'warn',
      message: `${n} blocks — unusually long page (soft cap 25)`,
    });
  }
  return violations;
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function checkGoldMentions(plainText, gold) {
  const violations = [];
  const must = Array.isArray(gold?.mustMentionAny) ? gold.mustMentionAny : [];
  if (must.length) {
    const matched = must.some((needle) => plainText.includes(String(needle).toLowerCase()));
    if (!matched) {
      violations.push({
        category: 'gold-must-mention',
        severity: 'warn',
        message: `none of: ${must.join(' | ')}`,
      });
    }
  }
  const mustNot = Array.isArray(gold?.mustNotMention) ? gold.mustNotMention : [];
  mustNot.forEach((needle) => {
    if (plainText.includes(String(needle).toLowerCase())) {
      violations.push({
        category: 'gold-must-not-mention',
        severity: 'blocker',
        message: `forbidden phrase present: "${needle}"`,
      });
    }
  });
  return violations;
}

function checkProductCount(html, gold) {
  const violations = [];
  const count = countMatches(html, /<a [^>]*href="\/products\//gi);
  const min = typeof gold?.minProductCount === 'number' ? gold.minProductCount : null;
  if (min != null && count < min) {
    violations.push({
      category: 'gold-min-products',
      severity: 'warn',
      message: `expected ≥${min} product card(s), found ${count}`,
    });
  }
  return { violations, count };
}

function checkRecipeCount(html, gold) {
  const violations = [];
  const count = countMatches(html, /<a [^>]*href="\/recipes\//gi);
  const min = typeof gold?.minRecipeCount === 'number' ? gold.minRecipeCount : null;
  if (min != null && count < min) {
    violations.push({
      category: 'gold-min-recipes',
      severity: 'warn',
      message: `expected ≥${min} recipe link(s), found ${count}`,
    });
  }
  return { violations, count };
}

const DECLINE_PHRASES = [
  'specialty coffee',
  'coffee assistant',
  'not in my purpose',
  'outside my expertise',
  "i'm a coffee",
  'i am a coffee',
  'help with coffee',
  'focused on coffee',
  'doesn’t fit',
  'does not fit',
];

function checkExpectedBehavior(html, plainText, queryDef, productCount) {
  const violations = [];
  const expected = queryDef?.expectedBehavior;
  if (expected !== 'decline') return violations;
  const declined = DECLINE_PHRASES.some((p) => plainText.includes(p));
  if (!declined) {
    violations.push({
      category: 'expected-decline',
      severity: 'blocker',
      message: 'query is off-topic but page did not decline (no decline phrasing detected)',
    });
  }
  if (productCount > 2) {
    violations.push({
      category: 'expected-decline',
      severity: 'blocker',
      message: `off-topic query surfaced ${productCount} products — should be ≤2`,
    });
  }
  return violations;
}

/**
 * Run all assertions on a variant's blocks.
 *
 * @param {Array<{html: string, blockType?: string}>} blocks
 * @param {object} queryDef — the suite query definition (with optional `gold`)
 * @returns {{passed: boolean, violations: Array, counts: object}}
 */
function runAssertions(blocks, queryDef) {
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  const html = safeBlocks.map((b) => b.html || '').join('\n');
  const plainText = stripTags(html);
  const gold = queryDef?.gold || null;

  const violations = [];
  violations.push(...detectBrokenTokens(html));
  violations.push(...checkTagBalance(html));
  violations.push(...checkBlockCount(safeBlocks));

  const productResult = checkProductCount(html, gold);
  const recipeResult = checkRecipeCount(html, gold);
  violations.push(...productResult.violations);
  violations.push(...recipeResult.violations);

  if (gold) violations.push(...checkGoldMentions(plainText, gold));
  violations.push(...checkExpectedBehavior(html, plainText, queryDef, productResult.count));

  const blockerCount = violations.filter((v) => v.severity === 'blocker').length;
  return {
    passed: blockerCount === 0,
    violations,
    counts: {
      blockCount: safeBlocks.length,
      productCount: productResult.count,
      recipeCount: recipeResult.count,
      blockerCount,
      warnCount: violations.length - blockerCount,
    },
  };
}

export { runAssertions };
export default runAssertions;
