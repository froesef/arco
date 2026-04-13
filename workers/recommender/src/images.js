/**
 * Resolve content tokens (products, recipes, reviews, accessories) to real HTML with images.
 */

/* eslint-disable import/extensions, import/no-relative-packages */
import productsData from '../../../content/products/products.json';
import recipesData from '../../../content/recipes/recipes.json';
import reviewsData from '../../../content/metadata/reviews.json';
import accessoriesData from '../../../content/accessories/accessories.json';
/* eslint-enable import/extensions, import/no-relative-packages */

import { selectHeroImage } from './hero-images.js';

const ARCO_BASE = 'https://main--arco--froesef.aem.live';

// Default hero image — used when no specific product is featured
const HERO_MAIN_IMAGE = '/media_1f7e12f4bd38e8ecf4fdc73dc84ebd9a5fd516521.jpg';

const products = productsData.data || [];
const recipes = recipesData.data || [];
const reviews = reviewsData.data || [];
const accessories = accessoriesData.data || [];

const productsMap = new Map(products.map((p) => [p.id, p]));
const reviewsMap = new Map(reviews.map((r) => [r.id, r]));
const accessoriesMap = new Map(accessories.map((a) => [a.id, a]));

/**
 * Ensure an image URL is absolute.
 */
function absoluteImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${ARCO_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Get the best image URL for a product.
 */
function getProductImage(productId) {
  const product = productsMap.get(productId);
  if (!product) return '';
  const img = product.images?.[0] || product.image || '';
  return absoluteImageUrl(img);
}

/**
 * Get the best image URL for an accessory.
 */
function getAccessoryImage(accessoryId) {
  const accessory = accessoriesMap.get(accessoryId);
  if (!accessory) return '';
  const img = accessory.images?.[0] || accessory.image || '';
  return absoluteImageUrl(img);
}

/**
 * Resolve a {{product:ID}} token to a product card HTML.
 */
function resolveProductToken(productId) {
  const product = productsMap.get(productId);
  if (!product) return `<!-- unknown product: ${productId} -->`;

  const image = getProductImage(productId);
  const price = product.price ? `$${product.price}` : '';
  const url = product.url || `/products/espresso-machines/${productId}`;

  return `<div>
      <div>${image ? `<picture><img src="${image}" alt="${product.name}"></picture>` : ''}</div>
      <div>
        <p><strong>${product.name}</strong></p>
        <p>${price}</p>
        <p>${product.tagline || product.description?.substring(0, 120) || ''}</p>
        <p><a href="${url}">View Details</a></p>
      </div>
    </div>`;
}

/**
 * Find a recipe by name (case-insensitive partial match).
 */
function findRecipe(name) {
  const lower = name.toLowerCase();
  return recipes.find((r) => (r.name || '').toLowerCase() === lower)
    || recipes.find((r) => (r.name || '').toLowerCase().includes(lower));
}

/**
 * Resolve a {{recipe-image:NAME}} token to a <picture> tag.
 */
function resolveRecipeImageToken(recipeName) {
  const recipe = findRecipe(recipeName);
  if (!recipe) return `<!-- unknown recipe image: ${recipeName} -->`;
  const image = absoluteImageUrl(recipe.image || recipe.imageUrl || '');
  if (!image) return '';
  return `<picture><img src="${image}" alt="${recipe.name}"></picture>`;
}

/**
 * Resolve a {{recipe:NAME}} token to a recipe card HTML.
 */
function resolveRecipeToken(recipeName) {
  const recipe = findRecipe(recipeName);
  if (!recipe) return `<!-- unknown recipe: ${recipeName} -->`;

  const image = absoluteImageUrl(recipe.image || recipe.imageUrl || '');
  const url = recipe.url || `/recipes/${recipe.id}`;

  return `<div>
      <div>${image ? `<picture><img src="${image}" alt="${recipe.name}"></picture>` : ''}</div>
      <div>
        <p><strong>${recipe.name}</strong></p>
        <p>${recipe.description?.substring(0, 120) || ''}</p>
        <p><a href="${url}">View Recipe</a></p>
      </div>
    </div>`;
}

/**
 * Resolve a {{review:ID}} token to a blockquote HTML.
 */
function resolveReviewToken(reviewId) {
  const review = reviewsMap.get(reviewId);
  if (!review) return `<!-- unknown review: ${reviewId} -->`;

  return `<blockquote>
      <p>${review.content || review.body || ''}</p>
      <p><strong>${review.author || 'Customer'}</strong>${review.productId ? `, ${review.productId}` : ''}</p>
    </blockquote>`;
}

/**
 * Resolve a {{product-image:ID}} token to a <picture> tag.
 */
function resolveProductImageToken(productId) {
  const imageUrl = getProductImage(productId.trim());
  const product = productsMap.get(productId.trim());
  if (!imageUrl) return `<!-- unknown product image: ${productId} -->`;
  return `<picture><img src="${imageUrl}" alt="${product?.name || productId}"></picture>`;
}

/**
 * Resolve a {{recipe-link:NAME}} token to an anchor tag.
 */
function resolveRecipeLinkToken(recipeName) {
  const recipe = findRecipe(recipeName);
  if (!recipe) return `<!-- unknown recipe: ${recipeName} -->`;
  const url = recipe.url || `/recipes/${recipe.id}`;
  return `<a href="${url}">${recipe.name}</a>`;
}

/**
 * Resolve a {{product-link:ID}} token to an anchor tag.
 */
function resolveProductLinkToken(productId) {
  const product = productsMap.get(productId.trim());
  if (!product) return `<!-- unknown product link: ${productId} -->`;
  const url = product.url || `/products/espresso-machines/${product.id}`;
  return `<a href="${url}">${product.name}</a>`;
}

/**
 * Resolve a {{accessory:ID}} token to an accessory card HTML.
 */
function resolveAccessoryToken(accessoryId) {
  const accessory = accessoriesMap.get(accessoryId);
  if (!accessory) return `<!-- unknown accessory: ${accessoryId} -->`;

  const image = getAccessoryImage(accessoryId);
  const price = accessory.price ? `$${accessory.price}` : '';
  const url = accessory.url || `/accessories/${accessoryId}`;

  return `<div>
      <div>${image ? `<picture><img src="${image}" alt="${accessory.name}"></picture>` : ''}</div>
      <div>
        <p><strong>${accessory.name}</strong></p>
        <p>${price}</p>
        <p>${accessory.description?.substring(0, 120) || ''}</p>
        <p><a href="${url}">View Details</a></p>
      </div>
    </div>`;
}

/**
 * Resolve a {{accessory-image:ID}} token to a <picture> tag.
 */
function resolveAccessoryImageToken(accessoryId) {
  const image = getAccessoryImage(accessoryId.trim());
  const accessory = accessoriesMap.get(accessoryId.trim());
  if (!image) return `<!-- unknown accessory image: ${accessoryId} -->`;
  return `<picture><img src="${image}" alt="${accessory?.name || accessoryId}"></picture>`;
}

/**
 * Resolve a {{hero-image:main}} token to a <picture> tag.
 * When heroContext is set (via setHeroContext), uses the annotated catalog
 * to pick a contextually appropriate image. Falls back to the default.
 */
let currentHeroContext = null;

/**
 * Set the hero selection context for the current request.
 * Call this before resolveTokens() so the hero image matches the query.
 * @param {{ query?: string, useCases?: string[], intentType?: string, productIds?: string[] }} ctx
 */
export function setHeroContext(ctx) {
  currentHeroContext = ctx;
}

function resolveHeroImageToken() {
  if (currentHeroContext) {
    const hero = selectHeroImage(currentHeroContext);
    return `<picture><img src="${hero.url}" alt="${hero.alt}"></picture>`;
  }
  // Fallback: use the default hero image
  const image = absoluteImageUrl(HERO_MAIN_IMAGE);
  if (!image) return '<!-- hero-image:main unavailable -->';
  return `<picture><img src="${image}" alt="Arco espresso machine brewing a perfect shot on a sunlit kitchen counter"></picture>`;
}

// Build a set of known valid image URLs from product, recipe, and accessory data
const knownImageUrls = new Set();
products.forEach((p) => {
  (p.images || []).forEach((img) => knownImageUrls.add(absoluteImageUrl(img)));
  if (p.image) knownImageUrls.add(absoluteImageUrl(p.image));
});
recipes.forEach((r) => {
  if (r.image) knownImageUrls.add(absoluteImageUrl(r.image));
  if (r.imageUrl) knownImageUrls.add(absoluteImageUrl(r.imageUrl));
});
accessories.forEach((a) => {
  (a.images || []).forEach((img) => knownImageUrls.add(absoluteImageUrl(img)));
  if (a.image) knownImageUrls.add(absoluteImageUrl(a.image));
});
knownImageUrls.add(absoluteImageUrl(HERO_MAIN_IMAGE));
// Hero images resolve to real product images or the default hero at runtime,
// so all valid hero URLs are already in knownImageUrls via product/default entries.

/**
 * Remove <picture>/<img> tags with hallucinated image URLs (not from known data).
 */
function stripUnknownImages(html) {
  let cleaned = html.replace(/<picture>\s*<img\s+[^>]*src=["']([^"']+)["'][^>]*>\s*<\/picture>/gi, (match, src) => {
    const absolute = absoluteImageUrl(src);
    if (knownImageUrls.has(absolute)) return match;
    console.warn('[Images] Stripped unknown image URL: %s', src);
    return '';
  });
  cleaned = cleaned.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    const absolute = absoluteImageUrl(src);
    if (knownImageUrls.has(absolute)) return match;
    console.warn('[Images] Stripped unknown standalone img URL: %s', src);
    return '';
  });
  return cleaned;
}

/**
 * Normalize product URLs in HTML.
 * Strips external domains, ensures product URLs use the correct path structure.
 */
export function normalizeProductUrls(html) {
  let out = html;
  // Safety net: strip non-Arco external domain URLs in href attributes.
  // Allows arco site URLs, relative URLs.
  out = out.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname.endsWith('aem.live')
        || hostname.endsWith('aem.page')
        || hostname.endsWith('da.live')) {
        return match;
      }
    } catch { /* invalid URL */ }
    console.warn('[Images] Stripped external URL: %s', url);
    return 'href="#"';
  });
  return out;
}

/**
 * Get product data for enrichment (used by llm-generate for suggestions).
 */
export function getProductData(productId) {
  const product = productsMap.get(productId);
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    image: getProductImage(productId),
    url: product.url,
  };
}

/**
 * Resolve all content tokens and fix image URLs in an HTML string.
 */
export function resolveTokens(html) {
  let resolved = html
    .replace(/\{\{product:([^}]+)\}\}/g, (_, id) => resolveProductToken(id.trim()))
    .replace(/\{\{product-image:([^}]+)\}\}/g, (_, id) => resolveProductImageToken(id.trim()))
    .replace(/\{\{recipe-image:([^}]+)\}\}/g, (_, name) => resolveRecipeImageToken(name.trim()))
    .replace(/\{\{recipe-link:([^}]+)\}\}/g, (_, name) => resolveRecipeLinkToken(name.trim()))
    .replace(/\{\{product-link:([^}]+)\}\}/g, (_, id) => resolveProductLinkToken(id.trim()))
    .replace(/\{\{recipe:([^}]+)\}\}/g, (_, name) => resolveRecipeToken(name.trim()))
    .replace(/\{\{review:([^}]+)\}\}/g, (_, id) => resolveReviewToken(id.trim()))
    .replace(/\{\{accessory:([^}]+)\}\}/g, (_, id) => resolveAccessoryToken(id.trim()))
    .replace(/\{\{accessory-image:([^}]+)\}\}/g, (_, id) => resolveAccessoryImageToken(id.trim()))
    .replace(/\{\{hero-image:main\}\}/g, () => resolveHeroImageToken());
  resolved = stripUnknownImages(resolved);
  return resolved;
}
