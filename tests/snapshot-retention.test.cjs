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

test('retention defaults to dry-run, preserves newest per volume, and deletes eligible files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-retention-test-'));
  let store;
  try {
    store = new SnapshotStore(dir);
    const first = await store.create({ snapshotText: snapshot('a.txt', 10), volumeId: 'vol-a' });
    const second = await store.create({ snapshotText: snapshot('b.txt', 20), volumeId: 'vol-a' });
    const newest = await store.create({ snapshotText: snapshot('c.txt', 30), volumeId: 'vol-a' });
    store.db.prepare('UPDATE snapshots SET created_at = ? WHERE id IN (?, ?)').run('2020-01-01T00:00:00.000Z', first.id, second.id);
    const dry = store.applyRetention({ retentionDays: 30, keepLatestPerVolume: 1 });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.candidates.snapshots, 2);
    assert.equal(store.list('vol-a').length, 3);
    const applied = store.applyRetention({ retentionDays: 30, keepLatestPerVolume: 1, dryRun: false });
    assert.equal(applied.deleted.snapshots, 2);
    assert.equal(store.list('vol-a').length, 1);
    assert.equal(store.get(newest.id).id, newest.id);
    assert.equal(fs.existsSync(path.join(dir, first.id + '.snapshot.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, second.id + '.vectors.jsonl')), false);
    assert.ok(applied.bytesReclaimable > 0);
  } finally {
    if (store) { try { store.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retention protects old snapshots referenced by retained comparisons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-retention-ref-test-'));
  let store;
  try {
    store = new SnapshotStore(dir);
    const a = await store.create({ snapshotText: snapshot('a.txt', 10), volumeId: 'vol-a' });
    const b = await store.create({ snapshotText: snapshot('b.txt', 20), volumeId: 'vol-a' });
    const comparison = await store.compare({ baselineId: a.id, targetId: b.id, minSeverity: 0 });
    store.db.prepare('UPDATE snapshots SET created_at = ? WHERE id IN (?, ?)').run('2020-01-01T00:00:00.000Z', a.id, b.id);
    const result = store.applyRetention({ retentionDays: 30, keepLatestPerVolume: 0, dryRun: false });
    assert.equal(result.deleted.comparisons, 0);
    assert.equal(result.deleted.snapshots, 0);
    assert.equal(store.get(a.id).id, a.id);
    assert.equal(store.get(b.id).id, b.id);
    assert.equal(store.getComparison(comparison.id).id, comparison.id);
  } finally {
    if (store) { try { store.close(); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
