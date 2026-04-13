/**
 * RAG Content Step — unified content search via Vectorize.
 * Generates one embedding from an enriched query (incorporating session context),
 * queries CONTENT_INDEX, splits by metadata type.
 * Writes ctx.rag.guides, ctx.rag.experiences, ctx.rag.comparisons, ctx.rag.toolContent.
 * Also performs direct comparison lookup when intent is comparison.
 */

import { searchContent, findComparison, extractProductIds } from '../../context.js';

/**
 * Build an enriched query that incorporates session context for better
 * semantic search results, especially for follow-up queries.
 */
function buildEnrichedQuery(ctx) {
  const parts = [ctx.request.query];

  // Add follow-up context if it differs from the main query
  if (ctx.request.followUp?.query && ctx.request.followUp.query !== ctx.request.query) {
    parts.push(ctx.request.followUp.query);
  }

  // Add recent session queries for conversational continuity
  const recent = (ctx.request.previousQueries || []).slice(-2);
  if (recent.length) {
    parts.push(recent.join('. '));
  }

  // Add matched product names to ground the search in the product catalog
  const productNames = (ctx.rag.products || []).slice(0, 3)
    .map((p) => p.name)
    .filter(Boolean);
  if (productNames.length) {
    parts.push(productNames.join(', '));
  }

  return parts.join(' — ').slice(0, 500);
}

// eslint-disable-next-line import/prefer-default-export
export async function ragContent(ctx, config, env) {
  const start = Date.now();
  const enrichedQuery = buildEnrichedQuery(ctx);

  const {
    guides, experiences, comparisons, recipes, tools, timings,
  } = await searchContent(enrichedQuery, env, config);

  ctx.rag.guides = guides;
  ctx.rag.experiences = experiences;
  ctx.rag.comparisons = comparisons;
  ctx.rag.toolContent = tools;

  // Merge Vectorize recipe results with any existing bundled recipes
  if (recipes.length) {
    ctx.rag.recipes = [...(ctx.rag.recipes || []), ...recipes];
  }

  // Direct comparison lookup: if intent is comparison, try to find a pre-authored one
  if (ctx.intent?.type === 'comparison') {
    const productIds = extractProductIds(ctx.request.query);
    if (productIds.length >= 2) {
      const preAuthored = findComparison(productIds[0], productIds[1]);
      if (preAuthored) {
        ctx.rag.comparisons = [
          {
            slug: preAuthored.slug || preAuthored.id,
            title: preAuthored.title,
            verdict: preAuthored.verdict,
            recommendations: preAuthored.recommendation_by_persona,
            intro: preAuthored.comparison_intro,
            _source: 'pre-authored',
          },
          ...ctx.rag.comparisons.filter(
            (c) => c.slug !== (preAuthored.slug || preAuthored.id),
          ),
        ];
      }
    }
  }

  ctx.timings.guidesMs = timings.guidesMs;
  ctx.timings.experiencesMs = timings.experiencesMs;
  ctx.timings.contentDetail = timings;
  ctx.timings.content = Date.now() - start;
}
