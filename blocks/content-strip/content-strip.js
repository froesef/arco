/**
 * Content Strip Block
 * Renders a lightweight horizontal strip of related content links.
 *
 * Expected row structure:
 *   Row 0: Heading (h3)
 *   Row 1+: Link items rendered as compact pills/chips
 */

export default function decorate(block) {
  const rows = [...block.children];
  const heading = rows[0]?.querySelector('h3, h2, h4');

  // Build the strip container
  const strip = document.createElement('div');
  strip.className = 'content-strip-items';

  // Collect all links from remaining rows
  rows.slice(heading ? 1 : 0).forEach((row) => {
    const links = row.querySelectorAll('a');
    links.forEach((link) => {
      const pill = document.createElement('a');
      pill.href = link.href;
      pill.className = 'content-strip-pill';
      pill.textContent = link.textContent;

      // Infer content type from href for icon hint
      const href = link.getAttribute('href') || '';
      if (href.includes('/tools/maintenance') || href.includes('/descaling') || href.includes('/care')) {
        pill.dataset.type = 'maintenance';
      } else if (href.includes('/tools/pairing') || href.includes('/bean-to-machine') || href.includes('/compatibility')) {
        pill.dataset.type = 'pairing';
      } else if (href.includes('/comparison') || href.includes('-vs-')) {
        pill.dataset.type = 'comparison';
      } else if (href.includes('/recipes') || href.includes('/recipe')) {
        pill.dataset.type = 'recipe';
      } else if (href.includes('/blog')) {
        pill.dataset.type = 'article';
      } else if (href.includes('/guides')) {
        pill.dataset.type = 'guide';
      }

      strip.append(pill);
    });

    // Also handle plain text items (non-link content in cells)
    if (links.length === 0) {
      [...row.children].forEach((cell) => {
        const text = cell.textContent.trim();
        if (text) {
          const pill = document.createElement('span');
          pill.className = 'content-strip-pill';
          pill.textContent = text;
          strip.append(pill);
        }
      });
    }
  });

  block.textContent = '';
  if (heading) {
    const header = document.createElement('div');
    header.className = 'content-strip-heading';
    header.append(heading);
    block.append(header);
  }
  block.append(strip);
}
