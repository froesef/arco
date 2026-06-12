/**
 * Unit tests for the incremental stream parser. The key regression guard is
 * that markdown code fences (```json ... ```) around a JSON block — emitted by
 * some models, notably DiffusionGemma — are tolerated instead of dropping the
 * whole block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamParser } from '../../src/stream-parser.js';

test('stream-parser — parses bare JSON blocks split on ===', () => {
  const p = new StreamParser();
  const sections = p.feed('{"block":"hero","rows":[]}\n===\n{"block":"columns","rows":[]}\n===\n');
  assert.deepEqual(sections.map((s) => s.block), ['hero', 'columns']);
});

test('stream-parser — strips ```json fences around a block', () => {
  const p = new StreamParser();
  const raw = '```json\n{"block":"hero","rows":[]}\n```\n===\n{"block":"columns","rows":[]}\n===\n';
  const sections = p.feed(raw);
  assert.deepEqual(sections.map((s) => s.block), ['hero', 'columns']);
});

test('stream-parser — tolerates stray prose around the JSON object', () => {
  const p = new StreamParser();
  const raw = 'Here is the block:\n{"block":"hero","rows":[]}\nThat is all.\n===\n';
  const sections = p.feed(raw);
  assert.deepEqual(sections.map((s) => s.block), ['hero']);
});

test('stream-parser — finalize() parses a trailing fenced block', () => {
  const p = new StreamParser();
  p.feed('```json\n{"block":"hero","rows":[]}\n```');
  const { section } = p.finalize();
  assert.equal(section.block, 'hero');
});
