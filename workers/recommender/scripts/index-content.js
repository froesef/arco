#!/usr/bin/env node

/**
 * Vectorize Content Indexer
 *
 * Reads content JSON files (blog, guides, experiences, bundles, tools,
 * comparisons, PDPs, recipes), chunks them by section, generates embeddings
 * via Cloudflare Workers AI, and upserts vectors into the arco-content
 * Vectorize index.
 *
 * Usage:
 *   node scripts/index-content.js
 *
 * Authentication:
 *   Reads the OAuth token from wrangler's config at
 *   ~/.wrangler/config/default.toml (or ~/Library/Preferences/.wrangler/...)
 *
 * Environment variables (optional overrides):
 *   CLOUDFLARE_API_TOKEN  — Bearer token for Cloudflare API
 *   CLOUDFLARE_ACCOUNT_ID — Account ID (defaults to wrangler.jsonc value)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Config ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '68e6632adf76183424b251e874663bde';
const INDEX_NAME = 'arco-content';
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBEDDING_DIMENSIONS = 384;
const VECTORIZE_BATCH_SIZE = 100;
const EMBEDDING_DELAY_MS = 50; // rate-limit courtesy delay between embedding calls
const MAX_TEXT_CHARS = 2000; // ~500 tokens, fits bge-small context window

const CONTENT_ROOT = resolve(import.meta.dirname, '../../../content');

// Directories to index (relative to CONTENT_ROOT)
const INDEX_DIRS = [
  'blog', 'guides', 'experiences', 'bundles', 'tools',
  'products/comparison', 'products/pdp-canonical',
];

// Single-file arrays to index (relative to CONTENT_ROOT)
const INDEX_ARRAYS = ['recipes/recipes.json'];

// ── Auth ────────────────────────────────────────────────────────────────────

function getApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  // Read from wrangler OAuth config
  const candidates = [
    join(homedir(), '.wrangler', 'config', 'default.toml'),
    join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }

  throw new Error(
    'No API token found. Set CLOUDFLARE_API_TOKEN or log in with `wrangler login`.',
  );
}

// ── File Discovery ──────────────────────────────────────────────────────────

function findJsonFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

// ── Chunking ────────────────────────────────────────────────────────────────

/**
 * Chunk structured data content (tools: maintenance, pairing, calculators).
 * Dispatches based on known array keys within data.data.
 */
function chunkStructuredData(data, slug, title, baseMeta, chunks) {
  const d = data.data;
  let chunkIdx = 0;

  // Maintenance: descaling guides — data.guides[]
  if (Array.isArray(d.guides)) {
    baseMeta.type = 'maintenance';
    for (const guide of d.guides) {
      const steps = Array.isArray(guide.steps) ? guide.steps.join('. ') : '';
      const text = `${title} — ${guide.label || guide.machine}: ${steps}. Frequency: ${guide.frequency_note || ''}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: guide.label || guide.machine },
      });
      chunkIdx += 1;
    }
  }

  // Diagnostic: symptoms — data.symptoms[]
  if (Array.isArray(d.symptoms)) {
    baseMeta.type = 'diagnostic';
    for (const sym of d.symptoms) {
      const causes = Array.isArray(sym.possible_causes)
        ? sym.possible_causes.map((c) => `${c.cause}: ${c.fix}`).join('. ')
        : '';
      const text = `${title} — ${sym.symptom}: ${causes}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: sym.symptom },
      });
      chunkIdx += 1;
    }
  }

  // Care calendar: schedules — data.schedules[]
  if (Array.isArray(d.schedules)) {
    baseMeta.type = 'maintenance';
    for (const sched of d.schedules) {
      const tasks = sched.tasks || {};
      const taskLines = Object.entries(tasks)
        .flatMap(([freq, items]) => (Array.isArray(items) ? items.map((t) => `${freq}: ${t.task}`) : []));
      const text = `${title} — ${sched.label || sched.machine} care schedule: ${taskLines.join('. ')}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: sched.label || sched.machine },
      });
      chunkIdx += 1;
    }
  }

  // Consumables — data.consumables[]
  if (Array.isArray(d.consumables)) {
    baseMeta.type = 'maintenance';
    for (const c of d.consumables) {
      const signs = Array.isArray(c.signs_of_wear) ? c.signs_of_wear.join(', ') : '';
      const text = `${title} — ${c.name}: ${c.description || ''}. Signs of wear: ${signs}. ${c.replacement_notes || ''}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: c.name },
      });
      chunkIdx += 1;
    }
  }

  // Pairing: grinder-machine compatibility — data.pairings[]
  if (Array.isArray(d.pairings)) {
    baseMeta.type = 'pairing';
    for (const p of d.pairings) {
      const text = `${title} — ${p.grinder || p.origin || ''} with ${p.machine || ''}: ${p.rationale || ''}. Rating: ${p.rating || ''}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: `${p.grinder || p.origin || ''} + ${p.machine || ''}` },
      });
      chunkIdx += 1;
    }
  }

  // Upgrade paths — data.edges[]
  if (Array.isArray(d.edges)) {
    baseMeta.type = 'pairing';
    for (const e of d.edges) {
      const gains = Array.isArray(e.what_you_gain) ? e.what_you_gain.join(', ') : '';
      const text = `${title} — Upgrade from ${e.from} to ${e.to}: ${e.rationale || ''}. You gain: ${gains}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: `${e.from} → ${e.to}` },
      });
      chunkIdx += 1;
    }
  }

  // Bean origins — data.origins[]
  if (Array.isArray(d.origins)) {
    baseMeta.type = 'pairing';
    for (const o of d.origins) {
      const text = `${title} — ${o.label}: ${o.flavour_profile || o.flavor_profile || ''}. Typical roast: ${o.typical_roast || ''}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: o.label },
      });
      chunkIdx += 1;
    }
  }

  // Filters — data.filters[]
  if (Array.isArray(d.filters)) {
    baseMeta.type = 'pairing';
    for (const f of d.filters) {
      const text = `${title} — ${f.name}: ${f.description || ''}. Type: ${f.type || ''}, capacity: ${f.capacity_litres || '?'}L`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: f.name },
      });
      chunkIdx += 1;
    }
  }

  // Accessories with portafilter compatibility — data.accessories[]
  if (Array.isArray(d.accessories)) {
    baseMeta.type = 'pairing';
    for (const a of d.accessories) {
      const sizes = Array.isArray(a.compatible_sizes) ? a.compatible_sizes.join(', ') : '';
      const text = `${title} — ${a.name}: ${a.notes || ''}. Compatible sizes: ${sizes}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: a.name },
      });
      chunkIdx += 1;
    }
  }

  // Warranty — data.warranty_terms (object, not array)
  if (d.warranty_terms && typeof d.warranty_terms === 'object') {
    baseMeta.type = 'maintenance';
    const parts = Object.entries(d.warranty_terms).map(([cat, terms]) => {
      const dur = terms.duration_years || '?';
      const cov = terms.coverage || '';
      return `${cat}: ${dur} years, ${cov}`;
    });
    const exclusions = Array.isArray(d.what_is_not_covered) ? d.what_is_not_covered.join(', ') : '';
    const text = `${title}: ${parts.join('. ')}. Not covered: ${exclusions}`.slice(0, MAX_TEXT_CHARS);
    chunks.push({
      id: `${slug}--0`,
      text,
      metadata: { ...baseMeta, sectionHeading: 'warranty' },
    });
  }
}

/**
 * Chunk comparison content (products/comparison/).
 */
function chunkComparison(data, slug, title, baseMeta, chunks) {
  baseMeta.type = 'comparison';

  // Chunk 1: Overview + verdict
  const intro = data.comparison_intro || '';
  const verdict = typeof data.verdict === 'string' ? data.verdict
    : (data.verdict?.text || data.verdict?.summary || '');
  const text1 = `${title}: ${intro}. Verdict: ${verdict}`.slice(0, MAX_TEXT_CHARS);
  chunks.push({
    id: `${slug}--overview`,
    text: text1,
    metadata: { ...baseMeta, sectionHeading: 'overview' },
  });

  // Chunk 2: Persona recommendations
  if (data.recommendation_by_persona) {
    const recs = Object.entries(data.recommendation_by_persona)
      .map(([persona, rec]) => `${persona}: ${rec.rationale || ''}`)
      .join('. ');
    const text2 = `${title} — Persona recommendations: ${recs}`.slice(0, MAX_TEXT_CHARS);
    chunks.push({
      id: `${slug}--personas`,
      text: text2,
      metadata: { ...baseMeta, sectionHeading: 'persona-recommendations' },
    });
  }
}

/**
 * Chunk PDP canonical content (products/pdp-canonical/).
 */
function chunkPDP(data, slug, title, baseMeta, chunks) {
  baseMeta.type = 'product';
  const name = data.name || title;
  const desc = data.description_long || data.description_short || '';
  const useCase = [data.use_case_headline || '', data.use_case_body || '']
    .filter(Boolean).join('. ');
  const text = `${name}: ${desc}. ${useCase}`.slice(0, MAX_TEXT_CHARS);
  chunks.push({
    id: `${slug}--0`,
    text,
    metadata: { ...baseMeta, sectionHeading: 'product-description', productId: data.id || slug },
  });
}

/**
 * Chunk a recipe item from the recipes array.
 */
function chunkRecipe(recipe) {
  const slug = recipe.id || recipe.slug;
  if (!slug) return null;

  const technique = Array.isArray(recipe.technique) ? recipe.technique.join('. ') : '';
  const tips = Array.isArray(recipe.tips) ? recipe.tips.join('. ') : '';
  const text = `Recipe: ${recipe.name}. ${recipe.description || ''}. Technique: ${technique}. Tips: ${tips}`.slice(0, MAX_TEXT_CHARS);

  return {
    id: `recipe-${slug}--0`,
    text,
    metadata: {
      slug,
      title: recipe.name || '',
      category: recipe.category || 'recipe',
      difficulty: recipe.difficulty || '',
      personaTags: '',
      type: 'recipe',
      sectionHeading: recipe.name || '',
    },
  };
}

/**
 * Extract indexable text chunks from a content JSON file.
 * Returns array of { id, text, metadata }.
 */
function chunkContent(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn(`  Skipping invalid JSON: ${filePath}`);
    return [];
  }

  const slug = data.slug || data.id;
  if (!slug) return [];

  const title = data.title || data.name || '';
  const category = data.category || filePath.split('/content/')[1]?.split('/')[0] || 'unknown';
  const difficulty = data.difficulty || '';
  const personaTags = data.persona_tags || (data.persona_tag ? [data.persona_tag] : []);

  const baseMeta = {
    slug,
    title,
    category,
    difficulty,
    personaTags: personaTags.join(','),
  };

  const chunks = [];

  // Type 1: body[] array of sections (guides, blogs, tools, bundles)
  if (Array.isArray(data.body) && data.body.length > 0) {
    baseMeta.type = 'guide';
    data.body.forEach((section, idx) => {
      const heading = section.heading || `Section ${idx + 1}`;
      const content = section.content || '';
      if (!content) return;

      const text = `${title} — ${heading}: ${content}`.slice(0, MAX_TEXT_CHARS);
      chunks.push({
        id: `${slug}--${idx}`,
        text,
        metadata: { ...baseMeta, sectionHeading: heading },
      });
    });
  }

  // Type 2: editorial_body string (experiences, bundles)
  if (typeof data.editorial_body === 'string' && data.editorial_body.length > 0) {
    baseMeta.type = 'experience';
    const paragraphs = data.editorial_body.split('\n\n').filter(Boolean);
    let currentChunk = '';
    let chunkIdx = 0;

    for (const para of paragraphs) {
      if (currentChunk.length + para.length > MAX_TEXT_CHARS && currentChunk.length > 0) {
        chunks.push({
          id: `${slug}--${chunkIdx}`,
          text: `${title}: ${currentChunk}`,
          metadata: { ...baseMeta, sectionHeading: `Part ${chunkIdx + 1}` },
        });
        chunkIdx += 1;
        currentChunk = '';
      }
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
    if (currentChunk) {
      chunks.push({
        id: `${slug}--${chunkIdx}`,
        text: `${title}: ${currentChunk}`.slice(0, MAX_TEXT_CHARS),
        metadata: { ...baseMeta, sectionHeading: `Part ${chunkIdx + 1}` },
      });
    }
  }

  // Type 3: intro or description fallback (if no body or editorial_body)
  if (chunks.length === 0 && (data.intro || data.description)) {
    const fallbackText = data.intro || data.description;
    const formula = data.formula ? ` Formula: ${data.formula}` : '';
    baseMeta.type = data.formula ? 'calculator' : category;
    chunks.push({
      id: `${slug}--0`,
      text: `${title}: ${fallbackText}${formula}`.slice(0, MAX_TEXT_CHARS),
      metadata: { ...baseMeta, sectionHeading: 'intro' },
    });
  }

  // Type 4: structured data content (tools: maintenance, pairing, diagnostics)
  if (chunks.length === 0 && data.data && typeof data.data === 'object') {
    chunkStructuredData(data, slug, title, baseMeta, chunks);
  }

  // Type 5: comparison content (products/comparison/)
  if (chunks.length === 0 && data.comparison_intro) {
    chunkComparison(data, slug, title, baseMeta, chunks);
  }

  // Type 6: PDP canonical content (products/pdp-canonical/)
  if (chunks.length === 0 && data.description_long) {
    chunkPDP(data, slug, title, baseMeta, chunks);
  }

  return chunks;
}

// ── Cloudflare API ──────────────────────────────────────────────────────────

async function generateEmbedding(text, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const embedding = json.result?.data?.[0];
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding shape: ${embedding?.length}`);
  }
  return embedding;
}

async function upsertVectors(vectors, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`;

  // Vectorize expects NDJSON format
  const ndjson = vectors.map((v) => JSON.stringify({
    id: v.id,
    values: v.values,
    metadata: v.metadata,
  })).join('\n');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: ndjson,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vectorize upsert error ${res.status}: ${body}`);
  }

  return res.json();
}

function sleep(ms) {
  return new Promise((resolve_) => { setTimeout(resolve_, ms); });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const token = getApiToken();
  console.log(`Using account: ${ACCOUNT_ID}`);
  console.log(`Index: ${INDEX_NAME} (${EMBEDDING_DIMENSIONS}d, ${EMBEDDING_MODEL})`);
  console.log(`Content root: ${CONTENT_ROOT}\n`);

  // 1. Discover and chunk all content
  const allChunks = [];
  for (const dir of INDEX_DIRS) {
    const dirPath = join(CONTENT_ROOT, dir);
    const files = findJsonFiles(dirPath);
    console.log(`[${dir}] Found ${files.length} JSON files`);

    for (const file of files) {
      const chunks = chunkContent(file);
      allChunks.push(...chunks);
    }
  }

  // 1b. Index single-file arrays (e.g., recipes.json)
  for (const arrayFile of INDEX_ARRAYS) {
    const filePath = join(CONTENT_ROOT, arrayFile);
    if (!existsSync(filePath)) {
      console.log(`[${arrayFile}] File not found, skipping`);
      continue;
    }
    const raw = readFileSync(filePath, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[${arrayFile}] Invalid JSON, skipping`);
      continue;
    }
    const items = parsed.data || (Array.isArray(parsed) ? parsed : []);
    let count = 0;
    for (const item of items) {
      const chunk = chunkRecipe(item);
      if (chunk) {
        allChunks.push(chunk);
        count += 1;
      }
    }
    console.log(`[${arrayFile}] Indexed ${count} items`);
  }

  console.log(`\nTotal chunks to index: ${allChunks.length}\n`);

  if (allChunks.length === 0) {
    console.log('No chunks found. Check that content directories exist and contain valid JSON.');
    process.exit(1);
  }

  // 2. Generate embeddings
  console.log('Generating embeddings...');
  const vectors = [];
  let embedded = 0;

  for (const chunk of allChunks) {
    try {
      const embedding = await generateEmbedding(chunk.text, token);
      vectors.push({
        id: chunk.id,
        values: embedding,
        metadata: chunk.metadata,
      });
      embedded += 1;
      if (embedded % 25 === 0) {
        console.log(`  Embedded ${embedded}/${allChunks.length}`);
      }
      await sleep(EMBEDDING_DELAY_MS);
    } catch (err) {
      console.error(`  Failed to embed ${chunk.id}: ${err.message}`);
    }
  }

  console.log(`\nEmbedded ${embedded}/${allChunks.length} chunks\n`);

  // 3. Upsert in batches
  console.log('Upserting vectors...');
  let upserted = 0;

  for (let i = 0; i < vectors.length; i += VECTORIZE_BATCH_SIZE) {
    const batch = vectors.slice(i, i + VECTORIZE_BATCH_SIZE);
    try {
      await upsertVectors(batch, token);
      upserted += batch.length;
      console.log(`  Upserted ${upserted}/${vectors.length}`);
    } catch (err) {
      console.error(`  Batch upsert failed at offset ${i}: ${err.message}`);
    }
  }

  console.log(`\nDone! Indexed ${upserted} vectors into ${INDEX_NAME}.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
