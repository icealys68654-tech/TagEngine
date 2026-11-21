import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { parseDirSnapshotToVectors, detectSnapshotAnchorEpoch } from './snapshot-manifest-parser';
import { compareSnapshotVectorsDiskBacked, SnapshotDiffAlert } from './sqlite-snapshot-diff-comparator';

export interface StoredSnapshot {
  id: string; volumeId: string; label: string; createdAt: string;
  processedCount: number; volumeSerial: string; anchorIso: string;
}
export interface StoredComparison {
  id: string; volumeId: string; baselineId: string; targetId: string;
  createdAt: string; minSeverity: number;
  summary: { added: number; modified: number; deleted: number; alertsEmitted: number };
  sharedAnchorIso: string;
}
export interface ComparisonResult extends StoredComparison { alerts: SnapshotDiffAlert[]; }

export class SnapshotStore {
  private readonly db: Database.Database;
  private readonly storageDir: string;
  constructor(storageDir: string, databasePath = path.join(storageDir, 'snapshots.sqlite')) {
    this.storageDir = path.resolve(storageDir);
    fs.mkdirSync(this.storageDir, { recursive: true });
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, volume_id TEXT NOT NULL, label TEXT NOT NULL,
        created_at TEXT NOT NULL, processed_count INTEGER NOT NULL,
        volume_serial TEXT NOT NULL, anchor_iso TEXT NOT NULL,
        source_path TEXT NOT NULL, vectors_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_volume_created ON snapshots(volume_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS snapshot_comparisons (
        id TEXT PRIMARY KEY, volume_id TEXT NOT NULL, baseline_id TEXT NOT NULL,
        target_id TEXT NOT NULL, created_at TEXT NOT NULL, min_severity REAL NOT NULL,
        added INTEGER NOT NULL, modified INTEGER NOT NULL, deleted INTEGER NOT NULL,
        alerts_emitted INTEGER NOT NULL, shared_anchor_iso TEXT NOT NULL, alerts_path TEXT NOT NULL,
        FOREIGN KEY(baseline_id) REFERENCES snapshots(id),
        FOREIGN KEY(target_id) REFERENCES snapshots(id)
      );
      CREATE INDEX IF NOT EXISTS idx_comparisons_volume_created ON snapshot_comparisons(volume_id, created_at DESC);
    `);
  }

  async create(input: { snapshotText: string; volumeId?: string; label?: string }): Promise<StoredSnapshot> {
    if (!input.snapshotText.trim()) throw new Error('snapshotText is required');
    const id = randomUUID();
    const volumeId = (input.volumeId || 'default').trim();
    const label = (input.label || 'Snapshot').trim();
    if (!volumeId || volumeId.length > 128) throw new Error('volumeId must be 1-128 characters');
    if (!label || label.length > 200) throw new Error('label must be 1-200 characters');
    const sourcePath = path.join(this.storageDir, id + '.snapshot.txt');
    const vectorsPath = path.join(this.storageDir, id + '.vectors.jsonl');
    const tempSourcePath = sourcePath + '.tmp';
    fs.writeFileSync(tempSourcePath, input.snapshotText, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(tempSourcePath, sourcePath);
      const parsed = await parseDirSnapshotToVectors(sourcePath, vectorsPath);
      const record: StoredSnapshot = { id, volumeId, label, createdAt: new Date().toISOString(),
        processedCount: parsed.processedCount, volumeSerial: parsed.volumeSerial, anchorIso: parsed.anchorIso };
      this.db.prepare(`INSERT INTO snapshots
        (id, volume_id, label, created_at, processed_count, volume_serial, anchor_iso, source_path, vectors_path)
        VALUES (@id, @volumeId, @label, @createdAt, @processedCount, @volumeSerial, @anchorIso, @sourcePath, @vectorsPath)`)
        .run({ ...record, sourcePath, vectorsPath });
      return record;
    } catch (error) {
      for (const file of [tempSourcePath, sourcePath, vectorsPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
      throw error;
    }
  }

  list(volumeId?: string, limit = 100): StoredSnapshot[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const sql = `SELECT id, volume_id AS volumeId, label, created_at AS createdAt,
      processed_count AS processedCount, volume_serial AS volumeSerial, anchor_iso AS anchorIso
      FROM snapshots ${volumeId ? 'WHERE volume_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`;
    return (volumeId ? this.db.prepare(sql).all(volumeId, safeLimit) : this.db.prepare(sql).all(safeLimit)) as StoredSnapshot[];
  }

  get(id: string): StoredSnapshot | undefined {
    return this.db.prepare(`SELECT id, volume_id AS volumeId, label, created_at AS createdAt,
      processed_count AS processedCount, volume_serial AS volumeSerial, anchor_iso AS anchorIso
      FROM snapshots WHERE id = ?`).get(id) as StoredSnapshot | undefined;
  }

  async compare(input: { baselineId: string; targetId: string; minSeverity?: number }): Promise<ComparisonResult> {
    const minSeverity = input.minSeverity ?? 1;
    if (!Number.isFinite(minSeverity) || minSeverity < 0 || minSeverity > 10) throw new Error('minSeverity must be between 0 and 10');
    if (input.baselineId === input.targetId) throw new Error('baselineId and targetId must be different');
    const rows = this.db.prepare('SELECT id, volume_id AS volumeId, source_path AS sourcePath FROM snapshots WHERE id IN (?, ?)')
      .all(input.baselineId, input.targetId) as Array<{ id: string; volumeId: string; sourcePath: string }>;
    if (rows.length !== 2) throw new Error('Baseline or target snapshot not found');
    const baseline = rows.find(row => row.id === input.baselineId)!;
    const target = rows.find(row => row.id === input.targetId)!;
    if (baseline.volumeId !== target.volumeId) throw new Error('Snapshots must belong to the same volume');
    for (const row of rows) {
      if (!path.resolve(row.sourcePath).startsWith(this.storageDir + path.sep) || !fs.existsSync(row.sourcePath)) {
        throw new Error('Stored snapshot source is unavailable');
      }
    }
    const id = randomUUID();
    const baseVectors = path.join(this.storageDir, id + '.baseline.jsonl');
    const targetVectors = path.join(this.storageDir, id + '.target.jsonl');
    const alertsPath = path.join(this.storageDir, id + '.alerts.jsonl');
    try {
      const anchor = Math.max(await detectSnapshotAnchorEpoch(baseline.sourcePath), await detectSnapshotAnchorEpoch(target.sourcePath));
      const [baseMeta] = await Promise.all([
        parseDirSnapshotToVectors(baseline.sourcePath, baseVectors, anchor),
        parseDirSnapshotToVectors(target.sourcePath, targetVectors, anchor)
      ]);
      const summary = await compareSnapshotVectorsDiskBacked(baseVectors, targetVectors, alertsPath, minSeverity);
      const record: StoredComparison = {
        id, volumeId: baseline.volumeId, baselineId: baseline.id, targetId: target.id,
        createdAt: new Date().toISOString(), minSeverity, summary, sharedAnchorIso: new Date(anchor).toISOString()
      };
      this.db.prepare(`INSERT INTO snapshot_comparisons
        (id, volume_id, baseline_id, target_id, created_at, min_severity, added, modified, deleted, alerts_emitted, shared_anchor_iso, alerts_path)
        VALUES (@id, @volumeId, @baselineId, @targetId, @createdAt, @minSeverity, @added, @modified, @deleted, @alertsEmitted, @sharedAnchorIso, @alertsPath)`)
        .run({ ...record, ...summary, alertsPath });
      const alerts: SnapshotDiffAlert[] = [];
      const rl = require('readline').createInterface({ input: fs.createReadStream(alertsPath, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) { if (line.trim()) { alerts.push(JSON.parse(line)); if (alerts.length >= 2000) break; } }
      return { ...record, alerts };
    } catch (error) {
      for (const file of [baseVectors, targetVectors, alertsPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
      throw error;
    } finally {
      for (const file of [baseVectors, targetVectors]) if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }

  listComparisons(volumeId?: string, limit = 100): StoredComparison[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const sql = `SELECT id, volume_id AS volumeId, baseline_id AS baselineId, target_id AS targetId,
      created_at AS createdAt, min_severity AS minSeverity, added, modified, deleted,
      alerts_emitted AS alertsEmitted, shared_anchor_iso AS sharedAnchorIso
      FROM snapshot_comparisons ${volumeId ? 'WHERE volume_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = (volumeId ? this.db.prepare(sql).all(volumeId, safeLimit) : this.db.prepare(sql).all(safeLimit)) as any[];
    return rows.map(row => ({ ...row, summary: { added: row.added, modified: row.modified, deleted: row.deleted, alertsEmitted: row.alertsEmitted } }));
  }

  getComparison(id: string): ComparisonResult | undefined {
    const row = this.db.prepare(`SELECT id, volume_id AS volumeId, baseline_id AS baselineId, target_id AS targetId,
      created_at AS createdAt, min_severity AS minSeverity, added, modified, deleted,
      alerts_emitted AS alertsEmitted, shared_anchor_iso AS sharedAnchorIso, alerts_path AS alertsPath
      FROM snapshot_comparisons WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    const alerts: SnapshotDiffAlert[] = [];
    if (fs.existsSync(row.alertsPath)) {
      const raw = fs.readFileSync(row.alertsPath, 'utf8');
      for (const line of raw.split('\n')) if (line.trim() && alerts.length < 2000) alerts.push(JSON.parse(line));
    }
    return { id: row.id, volumeId: row.volumeId, baselineId: row.baselineId, targetId: row.targetId,
      createdAt: row.createdAt, minSeverity: row.minSeverity, sharedAnchorIso: row.sharedAnchorIso,
      summary: { added: row.added, modified: row.modified, deleted: row.deleted, alertsEmitted: row.alertsEmitted }, alerts };
  }


  storageUsage(): { files: number; bytes: number } {
    const rows = this.db.prepare('SELECT source_path AS sourcePath, vectors_path AS vectorsPath FROM snapshots').all() as Array<{ sourcePath: string; vectorsPath: string }>;
    const comparisons = this.db.prepare('SELECT alerts_path AS alertsPath FROM snapshot_comparisons').all() as Array<{ alertsPath: string }>;
    let files = 0;
    let bytes = 0;
    for (const file of [...rows.flatMap(row => [row.sourcePath, row.vectorsPath]), ...comparisons.map(row => row.alertsPath)]) {
      if (!path.resolve(file).startsWith(this.storageDir + path.sep)) continue;
      try { const stat = fs.statSync(file); if (stat.isFile()) { files++; bytes += stat.size; } } catch {}
    }
    return { files, bytes };
  }

  applyRetention(input: { retentionDays: number; keepLatestPerVolume?: number; dryRun?: boolean }): {
    dryRun: boolean; cutoff: string; candidates: { snapshots: number; comparisons: number };
    deleted: { snapshots: number; comparisons: number }; bytesReclaimable: number;
    remainingUsage: { files: number; bytes: number };
  } {
    const { retentionDays } = input;
    const keepLatest = input.keepLatestPerVolume ?? 2;
    const dryRun = input.dryRun ?? true;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('retentionDays must be an integer from 1 to 3650');
    if (!Number.isInteger(keepLatest) || keepLatest < 0 || keepLatest > 1000) throw new Error('keepLatestPerVolume must be an integer from 0 to 1000');
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const comparisonRows = this.db.prepare('SELECT id, alerts_path AS alertsPath FROM snapshot_comparisons WHERE created_at < ?').all(cutoff) as Array<{ id: string; alertsPath: string }>;
    const oldSnapshots = this.db.prepare(`SELECT id, volume_id AS volumeId, created_at AS createdAt,
      source_path AS sourcePath, vectors_path AS vectorsPath FROM snapshots WHERE created_at < ? ORDER BY volume_id, created_at DESC`)
      .all(cutoff) as Array<{ id: string; volumeId: string; createdAt: string; sourcePath: string; vectorsPath: string }>;
    const kept = new Map<string, number>();
    const candidateSnapshots = oldSnapshots.filter(row => {
      const count = kept.get(row.volumeId) || 0;
      kept.set(row.volumeId, count + 1);
      return count >= keepLatest;
    });
    const removedComparisonIds = new Set(comparisonRows.map(row => row.id));
    const referenced = this.db.prepare('SELECT baseline_id AS baselineId, target_id AS targetId FROM snapshot_comparisons')
      .all() as Array<{ baselineId: string; targetId: string }>;
    const protectedIds = new Set(referenced.filter(row => !removedComparisonIds.has((row as any).id)).flatMap(row => [row.baselineId, row.targetId]));
    // Retain any snapshot still referenced by a comparison that is itself retained.
    const removableSnapshots = candidateSnapshots.filter(row => !protectedIds.has(row.id));
    const paths = [
      ...comparisonRows.map(row => row.alertsPath),
      ...removableSnapshots.flatMap(row => [row.sourcePath, row.vectorsPath]),
    ].filter(file => path.resolve(file).startsWith(this.storageDir + path.sep));
    let bytesReclaimable = 0;
    for (const file of paths) { try { const stat = fs.statSync(file); if (stat.isFile()) bytesReclaimable += stat.size; } catch {} }
    let deletedComparisons = 0;
    let deletedSnapshots = 0;
    if (!dryRun) {
      const remove = this.db.transaction(() => {
        const deleteComparison = this.db.prepare('DELETE FROM snapshot_comparisons WHERE id = ?');
        for (const row of comparisonRows) deletedComparisons += deleteComparison.run(row.id).changes;
        const deleteSnapshot = this.db.prepare('DELETE FROM snapshots WHERE id = ?');
        for (const row of removableSnapshots) deletedSnapshots += deleteSnapshot.run(row.id).changes;
      });
      remove();
      for (const file of paths) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* DB is authoritative; report usage for leftover files. */ } }
    }
    return {
      dryRun, cutoff,
      candidates: { snapshots: removableSnapshots.length, comparisons: comparisonRows.length },
      deleted: { snapshots: deletedSnapshots, comparisons: deletedComparisons },
      bytesReclaimable,
      remainingUsage: this.storageUsage(),
    };
  }

  close(): void { this.db.close(); }
}
