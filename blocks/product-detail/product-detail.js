import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  track,
  flush,
  parsePriceCents,
  productSlugFromPath,
} from '../../scripts/analytics-events.js';

/**
 * Parses block rows into a config object keyed by the first cell text (lowercased).
 * Rows whose first cell contains a picture element are stored under the 'images' key.
 * @param {Element} block The block element
 * @returns {object} Parsed configuration
 */
function parseBlockRows(block) {
  const config = {};
  const images = [];

  [...block.children].forEach((row) => {
    const cols = [...row.children];
    if (!cols.length) return;

    // Row with images: either cell may contain picture elements
    const allPictures = cols.flatMap((col) => [...col.querySelectorAll('picture')]);
    if (allPictures.length) {
      allPictures.forEach((pic) => images.push(pic));
      return;
    }

    // Key-value row
    const [keyCell, valueCell] = cols;
    const key = keyCell.textContent.trim().toLowerCase();
    if (key && valueCell) {
      config[key] = valueCell;
    }
  });

  config.images = images;
  return config;
}

/**
 * Builds the image gallery with main image and optional thumbnail strip.
 * @param {Array<Element>} pictures Array of picture elements
 * @returns {Element} The gallery element
 */
function buildGallery(pictures) {
  const gallery = document.createElement('div');
  gallery.className = 'product-detail-gallery';

  // Main image container
  const mainImageContainer = document.createElement('div');
  mainImageContainer.className = 'product-detail-main-image';

  if (pictures.length > 0) {
    const firstPic = pictures[0];
    const img = firstPic.querySelector('img');
    const optimized = createOptimizedPicture(
      img.src,
      img.alt || '',
      true,
      [{ media: '(min-width: 600px)', width: '2000' }, { width: '750' }],
    );
    mainImageContainer.append(optimized);
  }

  gallery.append(mainImageContainer);

  // Thumbnail strip (only if multiple images)
  if (pictures.length > 1) {
    const thumbStrip = document.createElement('div');
    thumbStrip.className = 'product-detail-thumbnails';

    pictures.forEach((pic, index) => {
      const img = pic.querySelector('img');
      const thumbButton = document.createElement('button');
      thumbButton.className = 'product-detail-thumbnail';
      thumbButton.setAttribute('type', 'button');
      thumbButton.setAttribute('aria-label', `View image ${index + 1}`);
      if (index === 0) thumbButton.classList.add('active');

      const thumbPic = createOptimizedPicture(
        img.src,
        img.alt || '',
        false,
        [{ width: '200' }],
      );
      thumbButton.append(thumbPic);

      thumbButton.addEventListener('click', () => {
        // Update main image
        const newMain = createOptimizedPicture(
          img.src,
          img.alt || '',
          true,
          [{ media: '(min-width: 600px)', width: '2000' }, { width: '750' }],
        );
        mainImageContainer.replaceChildren(newMain);

        // Update active thumbnail
        thumbStrip.querySelectorAll('.product-detail-thumbnail').forEach((t) => t.classList.remove('active'));
        thumbButton.classList.add('active');
      });

      thumbStrip.append(thumbButton);
    });

    gallery.append(thumbStrip);
  }

  return gallery;
}

/**
 * Builds variant selector buttons.
 * @param {Element} variantCell The cell containing variant options
 * @returns {Element} The variant selector container
 */
function buildVariantSelector(variantCell) {
  const container = document.createElement('div');
  container.className = 'product-detail-variants';

  const label = document.createElement('span');
  label.className = 'product-detail-variants-label';
  label.textContent = 'Options';
  container.append(label);

  const btnGroup = document.createElement('div');
  btnGroup.className = 'product-detail-variant-buttons';

  const text = variantCell.textContent.trim();
  const options = text.split(',').map((opt) => opt.trim()).filter(Boolean);

  options.forEach((option, index) => {
    const btn = document.createElement('button');
    btn.className = 'product-detail-variant-btn';
    btn.setAttribute('type', 'button');
    btn.textContent = option;
    if (index === 0) btn.classList.add('active');

    btn.addEventListener('click', () => {
      btnGroup.querySelectorAll('.product-detail-variant-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });

    btnGroup.append(btn);
  });

  container.append(btnGroup);
  return container;
}

/**
 * Builds the specifications table.
 * @param {Element} specsCell The cell containing spec entries
 * @returns {Element} The specs table container
 */
function buildSpecsTable(specsCell) {
  const container = document.createElement('div');
  container.className = 'product-detail-specs';

  const heading = document.createElement('h3');
  heading.textContent = 'Specifications';
  container.append(heading);

  const table = document.createElement('table');
  table.className = 'product-detail-specs-table';
  const tbody = document.createElement('tbody');

  // Specs can be in paragraphs or plain text lines
  const paragraphs = specsCell.querySelectorAll('p');
  const entries = paragraphs.length
    ? [...paragraphs].map((p) => p.textContent.trim())
    : specsCell.textContent.trim().split('\n').map((l) => l.trim());

  entries.filter(Boolean).forEach((entry) => {
    const [specName, ...rest] = entry.split(':');
    const specValue = rest.join(':').trim();
    if (specName && specValue) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = specName.trim();
      const td = document.createElement('td');
      td.textContent = specValue;
      tr.append(th, td);
      tbody.append(tr);
    }
  });

  table.append(tbody);
  container.append(table);
  return container;
}

/**
 * Appends JSON-LD Product schema to the document head.
 * @param {string} name Product name
 * @param {string} description Product description
 * @param {string} price Product price
 */
function appendJsonLd(name, description, price) {
  // Strip currency symbols and whitespace for the price value
  const numericPrice = price.replace(/[^0-9.,]/g, '').trim();

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    description,
    offers: {
      '@type': 'Offer',
      price: numericPrice,
      priceCurrency: 'USD',
    },
  };

  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(schema);
  document.head.append(script);
}

/**
 * Builds the simulated "Add to cart" control.
 *
 * The demo has no checkout — this is the hard conversion event the ROI model
 * counts, so the click must be recorded even though nothing is really sold.
 *
 * @param {string} name  Product name
 * @param {string} price Raw authored price string
 * @returns {Element}
 */
function buildAddToCart(name, price) {
  const wrap = document.createElement('div');
  wrap.className = 'product-detail-actions';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'product-detail-add-to-cart';
  button.textContent = 'Add to cart';

  const status = document.createElement('span');
  status.className = 'product-detail-cart-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  button.addEventListener('click', async () => {
    const slug = productSlugFromPath(window.location.pathname);
    if (!slug) return;

    const priceCents = parsePriceCents(price);
    const { addToCart } = await import('../../scripts/cart.js');
    const count = addToCart({ slug, name, priceCents });

    track('add_to_cart', { productSlug: slug, valueCents: priceCents });
    flush();

    button.classList.add('is-added');
    button.textContent = 'Added ✓';
    status.textContent = `${count} item${count === 1 ? '' : 's'} in cart`;

    setTimeout(() => {
      button.classList.remove('is-added');
      button.textContent = 'Add to cart';
    }, 2000);
  });

  wrap.append(button, status);
  return wrap;
}

/**
 * Loads and decorates the product-detail block.
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const config = parseBlockRows(block);

  // Extract text values
  const name = config.name ? config.name.textContent.trim() : '';
  const price = config.price ? config.price.textContent.trim() : '';
  const category = config.category ? config.category.textContent.trim() : '';
  const description = config.description ? config.description.textContent.trim() : '';

  // Clear block content
  block.replaceChildren();

  // Build gallery (left column)
  const gallery = buildGallery(config.images);

  // Build info panel (right column)
  const info = document.createElement('div');
  info.className = 'product-detail-info';

  if (category) {
    const categoryEl = document.createElement('span');
    categoryEl.className = 'product-detail-category';
    categoryEl.textContent = category;
    info.append(categoryEl);
  }

  if (name) {
    const h1 = document.createElement('h1');
    h1.className = 'product-detail-name';
    h1.textContent = name;
    info.append(h1);
  }

  if (price) {
    const priceEl = document.createElement('p');
    priceEl.className = 'product-detail-price';
    priceEl.textContent = price;
    info.append(priceEl);
  }

  if (description) {
    const descEl = document.createElement('p');
    descEl.className = 'product-detail-description';
    descEl.textContent = description;
    info.append(descEl);
  }

  // Add to cart — hard conversion for the ROI funnel
  info.append(buildAddToCart(name, price));

  // Variant selector
  if (config.variants) {
    info.append(buildVariantSelector(config.variants));
  }

  // Specs table
  if (config.specs) {
    info.append(buildSpecsTable(config.specs));
  }

  // Assemble two-column layout
  block.append(gallery, info);

  // JSON-LD structured data
  if (name) {
    appendJsonLd(name, description, price);
  }
}
