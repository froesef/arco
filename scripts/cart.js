/**
 * Simulated cart for the demo storefront.
 *
 * There is no checkout — the funnel intentionally ends at "add to cart", which
 * is the hard conversion the ROI model counts. State lives in localStorage so
 * the header badge survives navigation.
 */

const CART_KEY = 'arco-cart';

/**
 * @returns {Array<{slug: string, name: string, priceCents: number, qty: number}>}
 */
export function getCart() {
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Total number of units in the cart.
 * @param {Array} [items]
 * @returns {number}
 */
export function cartCount(items) {
  return (items || getCart()).reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
}

function saveCart(items) {
  try {
    window.localStorage.setItem(CART_KEY, JSON.stringify(items));
  } catch { /* private mode — cart is ephemeral */ }
  window.dispatchEvent(new CustomEvent('arco-cart-updated', {
    detail: { count: cartCount(items) },
  }));
}

/**
 * Add one unit of a product.
 * @param {{slug: string, name: string, priceCents: number}} product
 * @returns {number} new cart count
 */
export function addToCart(product) {
  if (!product?.slug) return cartCount();
  const items = getCart();
  const existing = items.find((i) => i.slug === product.slug);
  if (existing) {
    existing.qty = (Number(existing.qty) || 0) + 1;
  } else {
    items.push({
      slug: product.slug,
      name: product.name || product.slug,
      priceCents: Number(product.priceCents) || 0,
      qty: 1,
    });
  }
  saveCart(items);
  return cartCount(items);
}

export default addToCart;
