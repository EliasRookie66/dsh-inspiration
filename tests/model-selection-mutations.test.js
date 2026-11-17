import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ModelPreferences } from '../selection.js';
const source = await readFile(new URL('../selection.js', import.meta.url), 'utf8');
async function fixture(Preferences = ModelPreferences) {
  let record, broken = false;
  const unit = { async loadAll() { return { tables: { settings: record ? { model: structuredClone(record) } : {} }, global: null }; },
    async putRecord(_table, _key, value) { if (broken) throw new Error('injected disk failure'); record = structuredClone(value); }, async close() {} };
  const llm = { listProviders: () => [{ id: 'p', name: 'P' }], async listModels() { return [{ provider: 'p', id: 'm', name: 'M' }]; },
    async resolveModelInfo() { return { provider: 'p', id: 'm', name: 'M', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }; }, async resolveCallConfig(config) { return config; } };
  const prefs = await new Preferences({ kv: { open: async () => unit } }, llm, () => ({ provider: 'p', model: 'm' })).init();
  return { prefs, fault: () => { broken = true; } };
}
const cases = [
  ['settings revision guard', "if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.value.revision)", 'if (false)', async ({ prefs }) => {
    await assert.rejects(prefs.save(null, 0), { code: 'CONFLICT' });
  }],
  ['advertised effort guard', "if (route.reasoningEffort !== undefined && !details.efforts.some(item => item.id === route.reasoningEffort))", 'if (false)', async ({ prefs }) => {
    await assert.rejects(prefs.save({ provider: 'p', model: 'm', reasoningEffort: 'invented' }, 1), { code: 'MODEL' });
  }],
  ['persist-before-memory boundary', "await this.unit.putRecord('settings', RECORD, copy(committed));", "this.value = committed; await this.unit.putRecord('settings', RECORD, copy(committed));", async ({ prefs, fault }) => {
    fault(); await assert.rejects(prefs.save(null, 1), /disk failure/);
    assert.deepEqual(prefs.snapshot(), { revision: 1, selection: null });
  }],
  ['detached saved snapshot', 'snapshot() { this.ready(); return copy(this.value); }', 'snapshot() { this.ready(); return this.value; }', async ({ prefs }) => {
    const snapshot = prefs.snapshot(); snapshot.revision = 400;
    assert.equal(prefs.snapshot().revision, 1);
  }],
];
for (const [name, before, after, oracle] of cases) test(`model preference oracle detects broken ${name}`, async () => {
  const healthy = await fixture();
  try { await oracle(healthy); } finally { await healthy.prefs.close(); }
  assert.equal(source.split(before).length, 2, 'Mutation anchor must match exactly once');
  const variant = await import('data:text/javascript;base64,' + Buffer.from(source.replace(before, after)).toString('base64'));
  const broken = await fixture(variant.ModelPreferences);
  try { await assert.rejects(oracle(broken), error => error?.code === 'ERR_ASSERTION'); }
  finally { await broken.prefs.close(); }
});
