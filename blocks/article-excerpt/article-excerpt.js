import { createOptimizedPicture } from '../../scripts/aem.js';

/**
 * Article Excerpt Block — editorial preview cards for RAG-surfaced blog articles.
 * Renders 1–4 articles with an excerpt, metadata, and CTA link.
 * Pairs with {{story:slug}} tokens from the recommender.
 *
 * Expected row structure per article:
 *   Col 1 (optional): picture
 *   Col 2 (or Col 1 if no image): content
 *     - em: category / tag label
 *     - h1–h6: article title
 *     - p (first non-meta, non-link): excerpt text
 *     - p with no link and no em: author / read-time meta
 *     - a: link to full article
 */

function buildArticleExcerpt(row) {
  const cols = [...row.children];
  const hasImage = cols.length >= 2 && cols[0].querySelector('picture, img');
  const imageCol = hasImage ? cols[0] : null;
  const infoCol = hasImage ? cols[1] : cols[0];

  const article = document.createElement('article');
  article.className = 'article-excerpt-item';

  // --- Image ---
  if (imageCol) {
    const imageWrap = document.createElement('div');
    imageWrap.className = 'article-excerpt-image';
    const picture = imageCol.querySelector('picture');
    const img = imageCol.querySelector('img');
    if (picture && img) {
      const optimized = createOptimizedPicture(img.src, img.alt || '', false, [{ width: '400' }]);
      imageWrap.append(optimized);
    } else if (img) {
      const optimized = createOptimizedPicture(img.src, img.alt || '', false, [{ width: '400' }]);
      imageWrap.append(optimized);
    }
    article.append(imageWrap);
  }

  // --- Content ---
  const content = document.createElement('div');
  content.className = 'article-excerpt-content';

  // Tag / category label (em element)
  const tagEl = infoCol.querySelector('em');
  if (tagEl) {
    const tag = document.createElement('span');
    tag.className = 'article-excerpt-tag';
    tag.textContent = tagEl.textContent.trim();
    content.append(tag);
  }

  // Title (any heading)
  const heading = infoCol.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) {
    const title = document.createElement('h3');
    title.className = 'article-excerpt-title';
    title.textContent = heading.textContent.trim();
    content.append(title);
  }

  // Excerpt — first paragraph that isn't a link-only paragraph and isn't the em container
  const paragraphs = [...infoCol.querySelectorAll('p')];
  const excerptPara = paragraphs.find((p) => {
    const text = p.textContent.trim();
    return text
      && !p.querySelector('a')
      && !p.querySelector('em')
      && !p.querySelector('strong');
  });
  if (excerptPara) {
    const excerpt = document.createElement('p');
    excerpt.className = 'article-excerpt-excerpt';
    excerpt.textContent = excerptPara.textContent.trim();
    content.append(excerpt);
  }

  // Meta — paragraph with strong (author / read time)
  const metaPara = paragraphs.find((p) => p.querySelector('strong') && !p.querySelector('a'));
  if (metaPara) {
    const meta = document.createElement('p');
    meta.className = 'article-excerpt-meta';
    meta.textContent = metaPara.textContent.trim();
    content.append(meta);
  }

  // CTA link
  const link = infoCol.querySelector('a');
  if (link) {
    const cta = document.createElement('a');
    cta.href = link.href;
    cta.className = 'article-excerpt-cta';
    cta.textContent = link.textContent.trim() || 'Read Article';
    cta.setAttribute('aria-label', `Read: ${heading?.textContent.trim() || link.textContent.trim()}`);
    content.append(cta);
  }

  article.append(content);
  return article;
}

/**
 * Loads and decorates the article-excerpt block.
 * @param {Element} block The block element
 */
export default function decorate(block) {
  const rows = [...block.children];
  const list = document.createElement('div');
  list.className = 'article-excerpt-list';

  rows.forEach((row) => {
    list.append(buildArticleExcerpt(row));
  });

  block.replaceChildren(list);
}
