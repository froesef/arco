import {
  buildBlock,
  loadHeader,
  loadFooter,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateBlock,
  loadBlock,
  decorateTemplateAndTheme,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
} from './aem.js';
import { SessionContextManager } from './session-context.js';
import { getAPIEndpoint } from './api-config.js';

/**
 * Builds hero block and prepends to main in a new section.
 * @param {Element} main The container element
 */
function buildHeroBlock(main) {
  const h1 = main.querySelector('h1');
  const picture = main.querySelector('picture');
  // eslint-disable-next-line no-bitwise
  if (h1 && picture && (h1.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_PRECEDING)) {
    // Check if h1 or picture is already inside a hero block
    if (h1.closest('.hero') || picture.closest('.hero')) {
      return; // Don't create a duplicate hero block
    }
    const section = document.createElement('div');
    section.append(buildBlock('hero', { elems: [picture, h1] }));
    main.prepend(section);
  }
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

/**
 * Builds a personalization-banner block and prepends to main if persona cookie exists.
 * @param {Element} main The container element
 */
// eslint-disable-next-line no-unused-vars
function buildPersonalizationBanner(main) {
  const hasPersona = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  if (!hasPersona) return;
  // Only add on homepage or pages without an existing banner
  if (main.querySelector('.personalization-banner')) return;
  const section = document.createElement('div');
  section.append(buildBlock('personalization-banner', { elems: [] }));
  main.prepend(section);
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    // auto load `*/fragments/*` references
    const fragments = [...main.querySelectorAll('a[href*="/fragments/"]')].filter((f) => !f.closest('.fragment'));
    if (fragments.length > 0) {
      // eslint-disable-next-line import/no-cycle
      import('../blocks/fragment/fragment.js').then(({ loadFragment }) => {
        fragments.forEach(async (fragment) => {
          try {
            const { pathname } = new URL(fragment.href);
            const frag = await loadFragment(pathname);
            fragment.parentElement.replaceWith(...frag.children);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Fragment loading failed', error);
          }
        });
      });
    }

    buildHeroBlock(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

// Map LLM-generated block types to existing frontend blocks.
// 'false' means strip the block wrapper entirely (render as default content).
const BLOCK_ALIASES = {
  'use-case-cards': 'cards',
  'feature-highlights': 'cards',
  text: false,
  'how-to-steps': 'recipe-steps',
};

// Canonical product URL map: short id → full path
const PRODUCT_URLS = {
  primo: '/products/espresso-machines/primo',
  doppio: '/products/espresso-machines/doppio',
  nano: '/products/espresso-machines/nano',
  studio: '/products/espresso-machines/studio',
  'studio-pro': '/products/espresso-machines/studio-pro',
  ufficio: '/products/espresso-machines/ufficio',
  viaggio: '/products/espresso-machines/viaggio',
  automatico: '/products/espresso-machines/automatico',
  filtro: '/products/grinders/filtro',
  preciso: '/products/grinders/preciso',
  macinino: '/products/grinders/macinino',
  zero: '/products/grinders/zero',
  'tamper-set': '/products/accessories/tamper-set',
  'distribution-tool': '/products/accessories/distribution-tool',
  'precision-scale': '/products/accessories/precision-scale',
  'milk-pitcher': '/products/accessories/milk-pitcher',
  'knock-box': '/products/accessories/knock-box',
  'cleaning-kit': '/products/accessories/cleaning-kit',
  'descaling-solution': '/products/accessories/descaling-solution',
  'group-head-brush': '/products/accessories/group-head-brush',
  'espresso-cups': '/products/accessories/espresso-cups',
  'double-wall-glasses': '/products/accessories/double-wall-glasses',
  'bean-vault': '/products/accessories/bean-vault',
  'dosing-cup': '/products/accessories/dosing-cup',
};

/**
 * Fix short product URLs (/products/primo) to canonical form (/products/espresso-machines/primo).
 * @param {Element} container The container to scan for links
 */
function fixProductLinks(container) {
  container.querySelectorAll('a[href^="/products/"]').forEach((a) => {
    const parts = new URL(a.href, window.location.origin).pathname.split('/').filter(Boolean);
    // Only fix short URLs: /products/{id} (2 segments), not /products/{category}/{id} (3 segments)
    if (parts.length === 2) {
      const id = parts[1];
      if (PRODUCT_URLS[id]) a.href = PRODUCT_URLS[id];
    }
  });
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  // hopefully forward compatible button decoration
  decorateButtons(main);
  decorateIcons(main);
  fixProductLinks(main);
  buildAutoBlocks(main);
  decorateSections(main);

  // Remap aliased block names (e.g. LLM-generated blocks served from DA cache)
  Object.entries(BLOCK_ALIASES).forEach(([alias, target]) => {
    main.querySelectorAll(`.${alias}`).forEach((el) => {
      if (target === false) {
        el.replaceWith(...el.children);
      } else {
        el.classList.replace(alias, target);
      }
    });
  });

  decorateBlocks(main);
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  decorateTemplateAndTheme();
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    document.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  loadHeader(doc.querySelector('header'));

  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadFooter(doc.querySelector('footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  // eslint-disable-next-line import/no-cycle
  window.setTimeout(() => import('./delayed.js'), 3000);
  // load anything that can be postponed to the latest here
}

const PREFETCH_KEY = 'arco-quiz-prefetch';
const PREFETCH_MAX_AGE_MS = 60000;
const FORYOU_PREFETCH_KEY = 'arco-foryou-prefetch';

/**
 * Check if this is an Arco Recommender request (has ?q= or ?query= param)
 */
function isArcoRecommenderRequest() {
  const params = new URLSearchParams(window.location.search);
  return params.has('q') || params.has('query');
}

/**
 * Generate a URL-safe slug from a query
 */
/**
 * Render a streamed section block into the DOM.
 * @param {Object} data NDJSON section line: { type, html, sectionStyle, blockType }
 * @param {Element} content The #generation-content container
 */
async function renderStreamedSection(data, content) {
  const section = document.createElement('div');
  section.className = 'section';
  if (data.sectionStyle && data.sectionStyle !== 'default') {
    section.classList.add(data.sectionStyle);
  }
  section.dataset.sectionStatus = 'initialized';
  section.innerHTML = data.html;

  // Process section-metadata block (style -> class, then remove from DOM)
  const sectionMeta = section.querySelector('div.section-metadata');
  if (sectionMeta) {
    [...sectionMeta.querySelectorAll(':scope > div')].forEach((row) => {
      const cols = [...row.children];
      if (cols.length >= 2) {
        const key = cols[0].textContent.trim().toLowerCase();
        const val = cols[1].textContent.trim();
        if (key === 'style') {
          val.split(',').filter(Boolean).forEach((s) => {
            section.classList.add(s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'));
          });
        } else {
          const camel = key.replace(/[^a-z0-9]+/g, '-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          section.dataset[camel] = val;
        }
      }
    });
    sectionMeta.remove();
  }

  // Wrap block in wrapper div (EDS pattern)
  const blockEl = section.querySelector('[class]');
  if (blockEl) {
    const origName = blockEl.classList[0];
    const alias = origName in BLOCK_ALIASES ? BLOCK_ALIASES[origName] : origName;
    if (alias === false) {
      blockEl.replaceWith(...blockEl.children);
    } else {
      const blockName = alias;
      if (blockName !== origName) blockEl.classList.replace(origName, blockName);
      const wrapper = document.createElement('div');
      wrapper.className = `${blockName}-wrapper`;
      blockEl.parentNode.insertBefore(wrapper, blockEl);
      wrapper.appendChild(blockEl);
      decorateBlock(blockEl);
      section.classList.add(`${blockName}-container`);
    }
  }

  decorateButtons(section);
  decorateIcons(section);

  // Insert before follow-up section so it always stays at the bottom
  const followUpSection = content.querySelector('.follow-up-container');
  if (followUpSection) {
    content.insertBefore(section, followUpSection);
  } else {
    content.appendChild(section);
  }

  // Load the block (CSS + JS)
  const block = section.querySelector('.block');
  if (block) {
    await loadBlock(block);
  }

  section.dataset.sectionStatus = 'loaded';
  section.style.display = null;
}

/**
 * Render pre-collected blocks from a quiz prefetch into the DOM.
 * @param {Object} prefetchData Parsed prefetch data from sessionStorage
 * @param {string} query The query string
 */
async function renderPrefetchedBlocks(prefetchData, query) {
  const main = document.querySelector('main');
  if (!main) return;

  main.innerHTML = '<div id="generation-content"></div>';
  const content = main.querySelector('#generation-content');

  // eslint-disable-next-line no-restricted-syntax
  for (const blockData of prefetchData.blocks) {
    // eslint-disable-next-line no-await-in-loop
    await renderStreamedSection(blockData, content);
  }

  // Update document title
  const h1 = content.querySelector('h1');
  if (h1) document.title = `${h1.textContent} | Arco`;

  // Save query to session context
  SessionContextManager.addQuery({
    query,
    timestamp: Date.now(),
    intent: 'general',
  });
}

/**
 * Create a mini loading indicator for inline content appending.
 * @returns {Element} The loading indicator element
 */
function createMiniLoader() {
  const loader = document.createElement('div');
  loader.className = 'section follow-up-loading';
  loader.innerHTML = '<div class="follow-up-loading-dot"></div>'
    + '<div class="follow-up-loading-dot"></div>'
    + '<div class="follow-up-loading-dot"></div>';
  return loader;
}

/**
 * Create a conversation breadcrumb element.
 * @param {string} queryText The query text to display
 * @returns {Element} The breadcrumb element
 */
function createBreadcrumb(queryText) {
  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'section follow-up-breadcrumb';
  const text = document.createElement('span');
  text.className = 'breadcrumb-text';
  text.textContent = `You: \u201C${queryText}\u201D`;
  breadcrumb.appendChild(text);
  return breadcrumb;
}

/**
 * Extract product IDs from a rendered section's links.
 * @param {Element} section The rendered section element
 */
function trackSectionContent(section) {
  // Track product links
  section.querySelectorAll('a[href*="/products/"]').forEach((link) => {
    const match = link.href.match(/\/products\/[^/]+\/([^/?#]+)/);
    if (match) SessionContextManager.addShownProduct(match[1]);
  });

  // Track section type
  const block = section.querySelector('.block');
  const blockType = block ? block.classList[0] : 'default-content';
  const headline = section.querySelector('h1, h2, h3');
  SessionContextManager.addShownSection({
    blockType,
    headline: headline ? headline.textContent.substring(0, 80) : '',
  });
}

/**
 * Render a follow-up suggestions section into a container.
 * @param {Array} items Suggestion items from NDJSON
 * @param {Element} container The target container
 */
async function renderFollowUpSection(items, container) {
  // Remove any existing follow-up section in this container
  const existing = container.querySelector('.follow-up-container');
  if (existing) existing.remove();

  const followUpSection = document.createElement('div');
  followUpSection.className = 'section follow-up-container';
  const followUpBlock = buildBlock('follow-up', []);
  followUpBlock.dataset.suggestions = JSON.stringify(items);
  followUpSection.appendChild(followUpBlock);
  container.appendChild(followUpSection);
  decorateBlock(followUpBlock);
  await loadBlock(followUpBlock);
}

/**
 * Stream content from the recommender and append sections to a container.
 * Used for both initial page load and keep-exploring follow-ups.
 *
 * @param {string} query The query to send
 * @param {Element} container The #generation-content container
 * @param {Object} [options] Optional parameters
 * @param {Object} [options.followUp] Follow-up context { type, label }
 * @param {Function} [options.onFirstSection] Callback when first section arrives
 * @param {Function} [options.onError] Callback on error
 * @returns {Promise<void>}
 */
async function streamAndAppendContent(query, container, options = {}) {
  const startTime = Date.now();
  let blockCount = 0;

  const sessionContext = SessionContextManager.buildContextParam();

  const baseUrl = getAPIEndpoint('recommender');
  const body = { query, context: sessionContext };
  if (options.followUp) body.followUp = options.followUp;

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    // eslint-disable-next-line no-restricted-syntax
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // eslint-disable-line no-continue

      let data;
      try {
        data = JSON.parse(trimmed);
      } catch {
        continue; // eslint-disable-line no-continue
      }

      if (data.type === 'heartbeat') {
        continue; // eslint-disable-line no-continue
      }

      if (data.type === 'section') {
        if (blockCount === 0 && options.onFirstSection) options.onFirstSection();
        blockCount += 1;
        // eslint-disable-next-line no-await-in-loop
        await renderStreamedSection(data, container);

        // Track shown content for deduplication
        const lastSection = container.querySelector('.section:last-of-type');
        if (lastSection) trackSectionContent(lastSection);
      }

      if (data.type === 'suggestions') {
        // eslint-disable-next-line no-await-in-loop
        await renderFollowUpSection(data.items || [], container);
      }

      if (data.type === 'done') {
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(`[Recommender] Complete in ${totalTime}s`, data.timings || {});

        // Track used products from backend
        if (data.usedProducts) {
          data.usedProducts.forEach((id) => SessionContextManager.addShownProduct(id));
        }
      }

      if (data.type === 'error') {
        // eslint-disable-next-line no-console
        console.error('[Recommender] Server error:', data.message);
        if (options.onError) options.onError(data.message);
      }
    }
  }

  // Save query to session context
  SessionContextManager.addQuery({ query, timestamp: Date.now(), intent: 'general' });
  SessionContextManager.addGeneratedQuery(query);
}

/**
 * Replay buffered NDJSON lines from a speculative prefetch result.
 * @param {string[]} responseBuffer Buffered NDJSON lines
 * @param {Element} container Target container
 * @param {Object} options Same options as streamAndAppendContent
 */
async function replaySpeculativeResult(responseBuffer, container, options = {}) {
  let blockCount = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const line of responseBuffer) {
    const trimmed = line.trim();
    if (!trimmed) continue; // eslint-disable-line no-continue

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      continue; // eslint-disable-line no-continue
    }

    if (data.type === 'heartbeat') continue; // eslint-disable-line no-continue

    if (data.type === 'section') {
      if (blockCount === 0 && options.onFirstSection) options.onFirstSection();
      blockCount += 1;
      // eslint-disable-next-line no-await-in-loop
      await renderStreamedSection(data, container);
      const lastSection = container.querySelector('.section:last-of-type');
      if (lastSection) trackSectionContent(lastSection);
    }

    if (data.type === 'suggestions') {
      // eslint-disable-next-line no-await-in-loop
      await renderFollowUpSection(data.items || [], container);
    }

    if (data.type === 'done' && data.usedProducts) {
      data.usedProducts.forEach((id) => SessionContextManager.addShownProduct(id));
    }
  }

  SessionContextManager.addQuery({ query: options.query || '', timestamp: Date.now(), intent: 'general' });
  SessionContextManager.addGeneratedQuery(options.query || '');
}

/**
 * Lazily initialize the speculative engine and attach to chips.
 * @param {Element} container The container to find chips in
 */
function attachSpeculativeEngine(container) {
  const chips = container.querySelectorAll('.follow-up-chip[data-query]');
  if (chips.length === 0) return;

  if (window.arcoSpeculativeEngine) {
    window.arcoSpeculativeEngine.attachToChips(chips);
    return;
  }

  import('./speculative-engine.js').then(({ default: createSpeculativeEngine }) => {
    window.arcoSpeculativeEngine = createSpeculativeEngine({
      apiEndpoint: getAPIEndpoint('recommender'),
      getSessionContext: () => SessionContextManager.buildContextParam(),
    });
    window.arcoSpeculativeEngine.attachToChips(chips);
  });
}

/**
 * Set up the keep-exploring event listener for infinite browsing.
 * Listens for chip clicks and appends new content below.
 */
function initKeepExploring() {
  let isGenerating = false;

  // Attach speculative engine to initial chips
  const content = document.querySelector('#generation-content');
  if (content) attachSpeculativeEngine(content);

  window.addEventListener('arco-keep-exploring', async (e) => {
    if (isGenerating) return;
    isGenerating = true;

    const { query, followUp } = e.detail;
    const genContent = document.querySelector('#generation-content');
    if (!genContent) { isGenerating = false; return; }

    // Check speculative engine for cached result
    const specResult = window.arcoSpeculativeEngine?.getResult(query);

    // Insert breadcrumb
    const breadcrumb = createBreadcrumb(query);
    genContent.appendChild(breadcrumb);

    // Show mini loading indicator
    const loader = createMiniLoader();
    genContent.appendChild(loader);

    // Smooth scroll to breadcrumb
    breadcrumb.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      if (specResult) {
        // Wait for speculative result if in-flight, or use immediately if ready
        const ready = specResult.ready || await specResult.readyPromise;
        if (ready && specResult.responseBuffer.length > 0) {
          await replaySpeculativeResult(specResult.responseBuffer, genContent, {
            query,
            onFirstSection: () => loader.remove(),
          });
        } else {
          // Speculative fetch failed, fall back to normal stream
          await streamAndAppendContent(query, genContent, {
            followUp,
            onFirstSection: () => loader.remove(),
            onError: (msg) => {
              const p = document.createElement('p');
              p.style.color = '#c00';
              p.textContent = msg || 'Generation failed';
              loader.replaceChildren(p);
            },
          });
        }
      } else {
        await streamAndAppendContent(query, genContent, {
          followUp,
          onFirstSection: () => loader.remove(),
          onError: (msg) => {
            const p = document.createElement('p');
            p.style.color = '#c00';
            p.textContent = msg || 'Generation failed';
            loader.replaceChildren(p);
          },
        });
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[KeepExploring] Error:', error);
      const p = document.createElement('p');
      p.style.color = '#c00';
      p.textContent = 'Something went wrong. Please try again.';
      loader.replaceChildren(p);
    }

    // Remove loader only if no error message is showing
    if (loader.parentNode && !loader.querySelector('p')) loader.remove();

    // Attach speculative engine to new chips
    attachSpeculativeEngine(genContent);

    isGenerating = false;
  });
}

/**
 * Render an Arco Recommender page from ?q= or ?query= parameter.
 * Streams NDJSON from the Cloudflare Worker via fetch + ReadableStream.
 */
async function renderArcoRecommenderPage() {
  const main = document.querySelector('main');
  if (!main) return;

  const params = new URLSearchParams(window.location.search);
  const query = params.get('q') || params.get('query');

  // Check for prefetched quiz data (one-time use)
  try {
    const raw = sessionStorage.getItem(PREFETCH_KEY);
    sessionStorage.removeItem(PREFETCH_KEY);
    if (raw) {
      const prefetchData = JSON.parse(raw);
      const age = Date.now() - (prefetchData.timestamp || 0);
      if (age < PREFETCH_MAX_AGE_MS && prefetchData.blocks?.length > 0) {
        await renderPrefetchedBlocks(prefetchData, query);
        initKeepExploring();
        return;
      }
    }
  } catch { /* fall through */ }

  // Check for prefetched "For You" data
  try {
    const foryouRaw = sessionStorage.getItem(FORYOU_PREFETCH_KEY);
    if (foryouRaw) {
      const prefetchData = JSON.parse(foryouRaw);
      if (prefetchData.query === query && prefetchData.blocks?.length > 0) {
        await renderPrefetchedBlocks(prefetchData, query);
        initKeepExploring();
        return;
      }
    }
  } catch { /* fall through */ }

  // Clear main and show loading state
  main.innerHTML = `
    <div class="section generating-container arco-recommender">
      <div class="generating-spinner" aria-hidden="true"></div>
      <h1 class="generating-title">Finding recommendations&hellip;</h1>
      <span class="generating-query">&ldquo;${query}&rdquo;</span>
    </div>
    <div id="generation-content"></div>
  `;

  const loadingState = main.querySelector('.generating-container');
  const content = main.querySelector('#generation-content');

  try {
    await streamAndAppendContent(query, content, {
      onFirstSection: () => loadingState.classList.add('done'),
      onError: (msg) => {
        loadingState.innerHTML = `
          <h1>Something went wrong</h1>
          <p style="color: #c00;">${msg || 'Generation failed'}</p>
          <p><a href="/">Return to homepage</a></p>
        `;
      },
    });

    // Stream finished
    loadingState.remove();

    // Update document title
    const h1 = content.querySelector('h1');
    if (h1) document.title = `${h1.textContent} | Arco`;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Recommender] Fetch error:', error);
    loadingState.innerHTML = `
      <h1>Connection failed</h1>
      <p style="color: #c00;">Unable to connect to the server. Please try again.</p>
      <p><a href="/">Return to homepage</a></p>
    `;
  }

  // Initialize keep-exploring event listener
  initKeepExploring();
}

async function loadPage() {
  // Check if this is an Arco Recommender request (?q= or ?query=)
  if (isArcoRecommenderRequest()) {
    document.documentElement.lang = 'en';
    decorateTemplateAndTheme();
    document.body.classList.add('appear', 'arco-recommender-mode');
    loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
    loadFonts();
    loadHeader(document.querySelector('header'));
    loadFooter(document.querySelector('footer'));
    await renderArcoRecommenderPage();
    return;
  }

  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
