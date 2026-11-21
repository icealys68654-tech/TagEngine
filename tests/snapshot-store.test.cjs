const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnapshotStore } = require('../dist/snapshot-store');

test('persists snapshot metadata and supports volume filtering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entec-snapshot-store-test-'));
  const text = [
    ' Volume Serial Number is ABCD-1234',
    ' Directory of C:\\Users\\Demo',
    '11/20/2026  08:00 AM             1,024 sample.txt',
    ''
  ].join('\n');
  let store;
  try {
    store = new SnapshotStore(dir);
    const created = await store.create({ snapshotText: text, volumeId: 'volume-a', label: 'Baseline' });
    assert.equal(created.volumeId, 'volume-a');
    assert.equal(created.label, 'Baseline');
    assert.equal(created.processedCount, 1);
    assert.equal(store.list('volume-a').length, 1);
    assert.equal(store.list('volume-b').length, 0);
    store.close();
    store = new SnapshotStore(dir);
    assert.equal(store.get(created.id).id, created.id);
    assert.equal(store.list()[0].volumeSerial, 'ABCD-1234');
  } finally {
    if (store) {
      try { store.close(); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
