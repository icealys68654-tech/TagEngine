const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnapshotStore } = require('../dist/snapshot-store');

const snapshot = (name, size) => [
  ' Volume Serial Number is ABCD-1234',
  ' Directory of C:\\Users\\Demo',
  '11/20/2026  08:00 AM             ' + String(size).padStart(5) + ' ' + name,
  ''
].join('\n');

test('compares persisted snapshots, stores results, and reloads comparison history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-comparison-test-'));
  let store;
  try {
    store = new SnapshotStore(dir);
    const baseline = await store.create({ snapshotText: snapshot('sample.txt', 1024), volumeId: 'volume-a', label: 'Baseline' });
    const target = await store.create({ snapshotText: snapshot('sample.txt', 2048) + snapshot('new.exe', 512), volumeId: 'volume-a', label: 'Target' });
    const comparison = await store.compare({ baselineId: baseline.id, targetId: target.id, minSeverity: 0 });
    assert.equal(comparison.baselineId, baseline.id);
    assert.equal(comparison.targetId, target.id);
    assert.equal(comparison.summary.added, 1);
    assert.equal(comparison.summary.modified, 1);
    assert.ok(comparison.alerts.length >= 1);
    assert.equal(store.listComparisons('volume-a').length, 1);
    const comparisonId = comparison.id;
    store.close();
    store = new SnapshotStore(dir);
    const restored = store.getComparison(comparisonId);
    assert.equal(restored.id, comparisonId);
    assert.equal(restored.summary.added, 1);
    assert.equal(restored.alerts.length, comparison.alerts.length);
  } finally {
    if (store) { try { store.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects comparisons across different volume IDs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-volume-compare-test-'));
  let store;
  try {
    store = new SnapshotStore(dir);
    const a = await store.create({ snapshotText: snapshot('a.txt', 10), volumeId: 'a' });
    const b = await store.create({ snapshotText: snapshot('b.txt', 10), volumeId: 'b' });
    await assert.rejects(store.compare({ baselineId: a.id, targetId: b.id }), /same volume/);
  } finally {
    if (store) { try { store.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
