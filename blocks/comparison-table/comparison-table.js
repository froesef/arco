/**
 * Comparison Table Block — responsive product comparison with persona-highlighted recommendation.
 * Reads arco_persona cookie to highlight the recommended product for the visitor.
 *
 * Expected authored structure:
 *   Row 1: Col 1 = "Products", Col 2 = Product A name, Col 3 = Product B name
 *   Row 2+: Col 1 = spec label, Col 2 = Product A value, Col 3 = Product B value
 *   Last row (optional): Col 1 = "Recommendation",
 *          Col 2 = persona:product-slug pairs (comma-separated)
 */

/**
 * Reads the arco_persona cookie value.
 * @returns {string|null}
 */
function getPersona() {
  const match = document.cookie.match(/(?:^|;\s*)arco_persona=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Parses recommendation data from a cell.
 * Format: "morning-minimalist:arco-primo, upgrader:arco-doppio"
 * @param {string} text
 * @returns {object} Map of persona → product slug
 */
function parseRecommendations(text) {
  const recs = {};
  text.split(',').forEach((pair) => {
    const [persona, product] = pair.split(':').map((s) => s.trim());
    if (persona && product) recs[persona] = product;
  });
  return recs;
}

export default async function decorate(block) {
  const rows = [...block.children];
  if (rows.length < 2) return;

  const persona = getPersona();
  let recommendations = {};
  let dataRows = rows;

  // Check if last row is recommendation data
  const lastRow = rows[rows.length - 1];
  const lastLabel = lastRow.children[0]?.textContent.trim().toLowerCase();
  if (lastLabel === 'recommendation' || lastLabel === 'recommendations') {
    recommendations = parseRecommendations(lastRow.children[1]?.textContent || '');
    dataRows = rows.slice(0, -1);
  }

  // Header row — product names (preserve links if present)
  const headerCols = [...dataRows[0].children];
  const productHeaders = [1, 2].map((i) => {
    const col = headerCols[i];
    if (!col) return { text: `Product ${i === 1 ? 'A' : 'B'}`, link: null };
    const anchor = col.querySelector('a');
    if (anchor) return { text: anchor.textContent.trim(), link: anchor.href };
    return { text: col.textContent.trim(), link: null };
  });
  const productNames = productHeaders.map((h) => h.text);

  // Determine which column is recommended
  const recommendedProduct = persona ? recommendations[persona] : null;
  let recommendedCol = -1;
  if (recommendedProduct) {
    const slugA = productNames[0].toLowerCase().replace(/\s+/g, '-').replace(/^arco-/, 'arco-');
    const slugB = productNames[1].toLowerCase().replace(/\s+/g, '-').replace(/^arco-/, 'arco-');
    if (recommendedProduct.includes(slugA.replace('arco ', 'arco-'))) recommendedCol = 0;
    else if (recommendedProduct.includes(slugB.replace('arco ', 'arco-'))) recommendedCol = 1;
  }

  // Build table
  const table = document.createElement('table');
  table.className = 'comparison-table-grid';
  table.setAttribute('role', 'table');

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.innerHTML = '<th scope="col"></th>';
  productHeaders.forEach(({ text, link }, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.textContent = text;
      th.append(a);
    } else {
      th.textContent = text;
    }
    if (i === recommendedCol) {
      th.classList.add('comparison-table-recommended');
      const badge = document.createElement('span');
      badge.className = 'comparison-table-rec-badge';
      badge.textContent = 'Recommended for you';
      th.append(badge);
    }
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  // Body rows (skip header row)
  const tbody = document.createElement('tbody');
  dataRows.slice(1).forEach((row) => {
    const cols = [...row.children];
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = cols[0]?.textContent.trim() || '';
    tr.append(th);

    [1, 2].forEach((i) => {
      const td = document.createElement('td');
      td.textContent = cols[i]?.textContent.trim() || '—';
      if (i - 1 === recommendedCol) td.classList.add('comparison-table-recommended');
      tr.append(td);
    });

    tbody.append(tr);
  });
  table.append(tbody);

  // Wrap for responsive scroll
  const wrapper = document.createElement('div');
  wrapper.className = 'comparison-table-wrapper';
  wrapper.append(table);

  block.replaceChildren(wrapper);
}
