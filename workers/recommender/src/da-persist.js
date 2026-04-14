/**
 * DA (Document Authoring) Persistence
 *
 * Handles creating and publishing generated pages in AEM's Document Authoring system.
 * Includes IMS token service, DA client, AEM admin client, and page builder.
 */

const IMS_TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3';
const DA_FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch with a timeout. Uses AbortSignal.timeout where available,
 * falls back to manual AbortController.
 */
function fetchWithTimeout(url, options = {}, timeoutMs = DA_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Token cache (module-level for persistence across requests within a worker instance)
let cachedToken = null;

/**
 * Exchange Adobe IMS credentials for an access token.
 */
async function exchangeForAccessToken(clientId, clientSecret, serviceToken) {
  console.log('[DA Auth] Attempting S2S token exchange via IMS...');
  const formParams = new URLSearchParams();
  formParams.append('grant_type', 'authorization_code');
  formParams.append('client_id', clientId);
  formParams.append('client_secret', clientSecret);
  formParams.append('code', serviceToken);

  const response = await fetchWithTimeout(IMS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formParams.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`IMS token exchange failed: ${response.status} - ${errorText}`);
  }

  const tokenData = await response.json();
  if (!tokenData.access_token) {
    throw new Error('No access token received from IMS');
  }

  console.log('[DA Auth] S2S token exchange successful (expires in %ds)', tokenData.expires_in);
  return tokenData.access_token;
}

/**
 * Strip "Bearer " prefix if present — the callers add it themselves.
 */
function normalizeToken(token) {
  return token.replace(/^Bearer\s+/i, '');
}

/**
 * Get DA authentication token.
 * Priority: S2S credentials > legacy DA_TOKEN > error.
 * If S2S fails, falls back to DA_TOKEN before giving up.
 */
export async function getDAToken(env) {
  // Check cached token (23h max age, token expires in 24h)
  if (cachedToken) {
    const age = Date.now() - cachedToken.obtainedAt;
    if (age < 23 * 60 * 60 * 1000) {
      console.log('[DA Auth] Using cached token (%dh old)', Math.round(age / 3600000));
      return cachedToken.token;
    }
    console.log('[DA Auth] Cached token expired, refreshing');
    cachedToken = null;
  }

  // S2S credentials
  if (env.DA_CLIENT_ID && env.DA_CLIENT_SECRET && env.DA_SERVICE_TOKEN) {
    try {
      const accessToken = await exchangeForAccessToken(
        env.DA_CLIENT_ID,
        env.DA_CLIENT_SECRET,
        env.DA_SERVICE_TOKEN,
      );
      cachedToken = { token: accessToken, obtainedAt: Date.now() };
      return accessToken;
    } catch (err) {
      console.error('[DA Auth] S2S token exchange failed:', err.message);
      // Fall through to DA_TOKEN
    }
  } else {
    console.log('[DA Auth] S2S credentials not configured, skipping');
  }

  // Legacy fallback
  if (env.DA_TOKEN) {
    console.log('[DA Auth] Using DA_TOKEN fallback');
    return normalizeToken(env.DA_TOKEN);
  }

  throw new Error(
    'DA authentication failed. S2S exchange failed and no DA_TOKEN fallback configured.',
  );
}

/**
 * Clear cached token (called on 401 errors).
 */
export function clearCachedToken() {
  cachedToken = null;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Unescape HTML entities back to characters.
 */
export function unescapeHtml(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Build a DA-compliant HTML page from blocks.
 */
export function buildPageHtml(title, description, blocks) {
  const sectionsHtml = blocks.map((block) => {
    let sectionContent = typeof block === 'string' ? block : block.html;

    if (block.sectionStyle && block.sectionStyle !== 'default') {
      sectionContent += `
      <div class="section-metadata">
        <div>
          <div>style</div>
          <div>${escapeHtml(block.sectionStyle)}</div>
        </div>
      </div>`;
    }

    return `    <div>\n${sectionContent}\n    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
</head>
<body>
  <header></header>
  <main>
${sectionsHtml}
  </main>
  <footer></footer>
</body>
</html>`;
}

/**
 * Create a page in DA source.
 */
async function createPage(path, htmlContent, env) {
  const baseUrl = 'https://admin.da.live';
  const url = `${baseUrl}/source/${env.DA_ORG}/${env.DA_REPO}${path}.html`;
  console.log('[DA] Creating page: %s', url);

  const attemptCreate = async (isRetry) => {
    const token = await getDAToken(env);
    const formData = new FormData();
    formData.append('data', new Blob([htmlContent], { type: 'text/html' }), 'index.html');

    const response = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    const responseText = await response.text();

    if (response.status === 401 && !isRetry) {
      console.warn('[DA] Create page got 401, clearing token and retrying...');
      clearCachedToken();
      return null; // signal retry
    }

    if (!response.ok) {
      console.error('[DA] Create page failed: %d - %s', response.status, responseText);
      return { success: false, error: `Create page failed: ${response.status} - ${responseText}` };
    }

    console.log('[DA] Page created successfully');
    return { success: true };
  };

  try {
    const result = await attemptCreate(false);
    if (result !== null) return result;
    return await attemptCreate(true);
  } catch (error) {
    console.error('[DA] Create page error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Trigger preview for a path.
 */
async function triggerPreview(path, env) {
  const baseUrl = 'https://admin.hlx.page';
  const ref = 'main';
  const endpoint = `/preview/${env.DA_ORG}/${env.DA_REPO}/${ref}${path}`;
  console.log('[DA] Triggering preview: %s%s', baseUrl, endpoint);

  const attemptPreview = async (isRetry) => {
    const token = await getDAToken(env);
    const response = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const responseText = await response.text();

    if (response.status === 401 && !isRetry) {
      console.warn('[DA] Preview got 401, clearing token and retrying...');
      clearCachedToken();
      return null; // signal retry
    }

    if (!response.ok) {
      console.error('[DA] Preview failed: %d - %s', response.status, responseText);
      return { success: false, error: `Preview failed: ${response.status} - ${responseText}` };
    }

    console.log('[DA] Preview triggered successfully');
    return {
      success: true,
      url: `https://${ref}--${env.DA_REPO}--${env.DA_ORG}.aem.page${path}`,
    };
  };

  try {
    const result = await attemptPreview(false);
    if (result !== null) return result;
    return await attemptPreview(true);
  } catch (error) {
    console.error('[DA] Preview error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Wait for preview to be available.
 */
async function waitForPreview(path, env, maxAttempts = 10, interval = 1000) {
  const ref = 'main';
  const previewUrl = `https://${ref}--${env.DA_REPO}--${env.DA_ORG}.aem.page${path}`;

  // Use indices array to avoid for...of restriction while keeping sequential await
  const indices = Array.from({ length: maxAttempts }, (_, k) => k);
  // eslint-disable-next-line no-restricted-syntax
  for (const i of indices) {
    // eslint-disable-next-line no-unused-expressions
    i; // consumed to avoid unused-vars
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchWithTimeout(previewUrl, { method: 'HEAD' }, 5000);
      if (response.ok) return true;
    } catch {
      // Continue waiting
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, interval); });
  }

  return false;
}

/**
 * Publish to live.
 */
async function publishToLive(path, env) {
  const baseUrl = 'https://admin.hlx.page';
  const ref = 'main';
  const endpoint = `/live/${env.DA_ORG}/${env.DA_REPO}/${ref}${path}`;
  console.log('[DA] Publishing to live: %s%s', baseUrl, endpoint);

  const attemptPublish = async (isRetry) => {
    const token = await getDAToken(env);
    const response = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    const responseText = await response.text();

    if (response.status === 401 && !isRetry) {
      console.warn('[DA] Publish got 401, clearing token and retrying...');
      clearCachedToken();
      return null; // signal retry
    }

    if (!response.ok) {
      console.error('[DA] Publish failed: %d - %s', response.status, responseText);
      return { success: false, error: `Publish failed: ${response.status} - ${responseText}` };
    }

    console.log('[DA] Published successfully');
    return {
      success: true,
      url: `https://${ref}--${env.DA_REPO}--${env.DA_ORG}.aem.live${path}`,
    };
  };

  try {
    const result = await attemptPublish(false);
    if (result !== null) return result;
    return await attemptPublish(true);
  } catch (error) {
    console.error('[DA] Publish error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Purge CDN cache for a path.
 */
async function purgeCache(path, env) {
  const baseUrl = 'https://admin.hlx.page';
  const ref = 'main';
  try {
    const token = await getDAToken(env);
    await fetchWithTimeout(`${baseUrl}/cache/${env.DA_ORG}/${env.DA_REPO}/${ref}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Cache purge failure is non-critical
  }
}

/**
 * Complete persist and publish flow:
 * 1. Create page in DA source
 * 2. Trigger preview
 * 3. Wait for preview availability
 * 4. Publish to live
 * 5. Purge CDN cache
 */
export async function persistAndPublish(path, html, env) {
  console.log('[DA] Starting persist & publish pipeline for: %s (org=%s, repo=%s)', path, env.DA_ORG, env.DA_REPO);
  try {
    // 1. Create page in DA
    const createResult = await createPage(path, html, env);
    if (!createResult.success) {
      console.error('[DA] Pipeline failed at step 1 (create page):', createResult.error);
      return { success: false, error: createResult.error };
    }

    // 2. Trigger preview
    const previewResult = await triggerPreview(path, env);
    if (!previewResult.success) {
      console.error('[DA] Pipeline failed at step 2 (preview):', previewResult.error);
      return { success: false, error: previewResult.error };
    }

    // 3. Wait for preview
    const previewReady = await waitForPreview(path, env);
    if (!previewReady) {
      console.warn('[DA] Preview not ready within timeout, continuing to publish');
    }

    // 4. Publish to live
    const publishResult = await publishToLive(path, env);
    if (!publishResult.success) {
      console.error('[DA] Pipeline failed at step 4 (publish):', publishResult.error);
      return { success: false, error: publishResult.error };
    }

    // 5. Purge cache
    await purgeCache(path, env);

    return {
      success: true,
      urls: {
        preview: previewResult.url,
        live: publishResult.url,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
