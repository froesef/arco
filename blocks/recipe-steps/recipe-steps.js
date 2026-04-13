/**
 * Recipe Steps Block
 * Renders step-by-step instructional content for recipes and maintenance guides.
 *
 * Expected row structure:
 *   Row 0: Title (h2) + description (p)
 *   Row 1: Equipment label (p) + equipment list (ul)
 *   Row 2: Steps (ol)
 *   Row 3: Tips label (p) + tips list (ul)
 *
 * Flexible: decorates whatever rows are present, identifying content by element type.
 */

export default function decorate(block) {
  const rows = [...block.children];
  const container = document.createElement('div');
  container.className = 'recipe-steps-content';

  rows.forEach((row) => {
    const cells = [...row.children];

    // Detect what type of content this row contains
    const hasOl = cells.some((cell) => cell.querySelector('ol'));
    const hasUl = cells.some((cell) => cell.querySelector('ul'));
    const hasH2 = cells.some((cell) => cell.querySelector('h2'));

    if (hasH2) {
      // Header row: title + description
      const header = document.createElement('div');
      header.className = 'recipe-steps-header';
      cells.forEach((cell) => header.append(...cell.childNodes));
      container.append(header);
    } else if (hasOl) {
      // Steps row: ordered list of instructions
      const stepsWrapper = document.createElement('div');
      stepsWrapper.className = 'recipe-steps-instructions';
      const ol = cells.reduce((found, cell) => found || cell.querySelector('ol'), null);
      if (ol) {
        // Add step numbers as data attributes for styling
        [...ol.children].forEach((li, idx) => {
          li.dataset.step = idx + 1;
        });
        stepsWrapper.append(ol);
      }
      container.append(stepsWrapper);
    } else if (hasUl) {
      // Equipment or tips row: label + unordered list
      const section = document.createElement('div');
      // Determine if this is equipment or tips based on label text
      const label = cells[0]?.textContent?.trim().toUpperCase() || '';
      const isTips = label.includes('TIP') || label.includes('NOTE');
      section.className = isTips ? 'recipe-steps-tips' : 'recipe-steps-equipment';
      cells.forEach((cell) => section.append(...cell.childNodes));
      container.append(section);
    } else {
      // Generic row: just append content
      const generic = document.createElement('div');
      generic.className = 'recipe-steps-section';
      cells.forEach((cell) => generic.append(...cell.childNodes));
      container.append(generic);
    }
  });

  block.textContent = '';
  block.append(container);
}
