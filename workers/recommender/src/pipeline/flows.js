/**
 * Flow Definitions — Arco recommender pipeline configuration.
 */

const RECOMMENDER_FLOW = {
  id: 'recommender',
  name: 'Coffee Equipment Recommender',
  description: 'Espresso machine and grinder recommendation with behavior analysis and comparison tables.',
  steps: [
    { step: 'rate-limit', gate: true },
    { step: 'analyze-behavior' },
    { step: 'intent-classify' },
    { parallel: [{ step: 'persona-match' }, { step: 'use-case-match' }] },
    { step: 'rag-products', config: { maxResults: 8 } },
    {
      parallel: [
        {
          step: 'rag-content',
          config: {
            maxGuides: 5, maxExperiences: 3, maxComparisons: 2, maxRecipes: 3, maxTools: 3,
          },
        },
        { step: 'rag-features', config: { maxResults: 6 } },
        { step: 'rag-reviews', config: { maxResults: 6 } },
        { step: 'rag-faqs', config: { maxResults: 4 } },
      ],
    },
    { step: 'build-recommender-prompt' },
    {
      step: 'llm-generate',
      config: { model: 'gpt-oss-120b', maxTokens: 5120, temperature: 0.6 },
    },
  ],
};

export const STATIC_FLOWS = {
  default: RECOMMENDER_FLOW,
  recommender: RECOMMENDER_FLOW,
};

/**
 * Resolve a flow by ID.
 */
export function resolveFlow(flowId) {
  return STATIC_FLOWS[flowId || 'default'] || STATIC_FLOWS.default;
}
