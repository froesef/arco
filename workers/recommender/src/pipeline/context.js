/**
 * Pipeline Context Factory — creates the shared mutable context
 * that flows through all pipeline steps.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Loadtest-Token, X-Skip-Cerebras, X-Skip-Pipeline',
};

/**
 * Create a new pipeline context from a parsed request body and request object.
 */
export function createContext(body, request) {
  const {
    query, context: reqContext, followUp, speculative,
  } = body;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const previousQueries = reqContext?.previousQueries || [];
  const browsingHistory = reqContext?.browsingHistory || [];
  const inferredProfile = reqContext?.inferredProfile || null;
  const behaviorProfile = reqContext?.behaviorProfile || null;
  const shownContent = reqContext?.shownContent || null;

  return {
    // Immutable request data
    request: {
      query,
      previousQueries,
      browsingHistory,
      inferredProfile,
      behaviorProfile,
      followUp,
      shownContent,
      ip,
      speculative,
      headers: request.headers,
    },

    // Flow metadata
    flowId: null,
    flowName: null,

    // Control flags
    earlyResponse: null,

    // Pre-processing results
    intent: null,

    // RAG results (each step writes its key)
    rag: {
      guides: [],
      experiences: [],
      products: [],
      features: [],
      faqs: [],
      reviews: [],
      recipes: [],
      comparisons: [],
      toolContent: [],
      persona: null,
      useCase: null,
      behaviorAnalysis: null,
    },

    // Generation
    prompt: { system: '', user: '' },
    llm: {
      fullText: '',
      sections: [],
      rawJsonSections: [],
      suggestions: [],
      usage: null,
    },

    // Streaming
    writer: null,
    encoder: null,

    // Diagnostics
    timings: { start: Date.now() },
    ndjsonLines: [],
  };
}
