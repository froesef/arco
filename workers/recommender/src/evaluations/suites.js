/**
 * Evaluation suites — JSON test datasets bundled into the worker.
 *
 * Suites live in `eval/suites/*.json` at the repo root and are imported here
 * statically so they ship in the Workers bundle. To add a new suite, drop a
 * new JSON file alongside the existing one and add an import + registry entry
 * below.
 */
// eslint-disable-next-line import/no-relative-packages, import/extensions
import coffeeDefault from '../../../../eval/suites/coffee-default.json';
// eslint-disable-next-line import/no-relative-packages, import/extensions
import coffeeDev from '../../../../eval/suites/coffee-dev.json';
// eslint-disable-next-line import/no-relative-packages, import/extensions
import coffeeExtended from '../../../../eval/suites/coffee-extended.json';

const SUITE_REGISTRY = [coffeeExtended, coffeeDefault, coffeeDev];

const SUITES_BY_ID = new Map(SUITE_REGISTRY.map((s) => [s.id, s]));

/**
 * Light-weight summary used by the suite picker dropdown.
 */
export function listSuites() {
  return SUITE_REGISTRY.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description || '',
    version: s.version || 1,
    queryCount: Array.isArray(s.queries) ? s.queries.length : 0,
  }));
}

/**
 * Full suite payload. Returns null when the suite id is unknown.
 */
export function getSuite(id) {
  if (!id) return null;
  const suite = SUITES_BY_ID.get(id);
  if (!suite) return null;
  return {
    id: suite.id,
    name: suite.name,
    description: suite.description || '',
    version: suite.version || 1,
    queries: Array.isArray(suite.queries) ? suite.queries : [],
  };
}
