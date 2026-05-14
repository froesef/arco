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
