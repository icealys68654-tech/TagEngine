import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { parseDirSnapshotToVectors } from './snapshot-manifest-parser';

export interface StoredSnapshot {
  id: string;
  volumeId: string;
  label: string;
  createdAt: string;
  processedCount: number;
  volumeSerial: string;
  anchorIso: string;
}

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
        id TEXT PRIMARY KEY,
        volume_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_count INTEGER NOT NULL,
        volume_serial TEXT NOT NULL,
        anchor_iso TEXT NOT NULL,
        source_path TEXT NOT NULL,
        vectors_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_volume_created
        ON snapshots(volume_id, created_at DESC);
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
      const record: StoredSnapshot = {
        id, volumeId, label, createdAt: new Date().toISOString(),
        processedCount: parsed.processedCount,
        volumeSerial: parsed.volumeSerial,
        anchorIso: parsed.anchorIso,
      };
      this.db.prepare(`
        INSERT INTO snapshots
        (id, volume_id, label, created_at, processed_count, volume_serial, anchor_iso, source_path, vectors_path)
        VALUES (@id, @volumeId, @label, @createdAt, @processedCount, @volumeSerial, @anchorIso, @sourcePath, @vectorsPath)
      `).run({ ...record, sourcePath, vectorsPath });
      return record;
    } catch (error) {
      for (const file of [tempSourcePath, sourcePath, vectorsPath]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      throw error;
    }
  }

  list(volumeId?: string, limit = 100): StoredSnapshot[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = volumeId
      ? this.db.prepare(`SELECT id, volume_id AS volumeId, label, created_at AS createdAt,
          processed_count AS processedCount, volume_serial AS volumeSerial, anchor_iso AS anchorIso
          FROM snapshots WHERE volume_id = ? ORDER BY created_at DESC LIMIT ?`).all(volumeId, safeLimit)
      : this.db.prepare(`SELECT id, volume_id AS volumeId, label, created_at AS createdAt,
          processed_count AS processedCount, volume_serial AS volumeSerial, anchor_iso AS anchorIso
          FROM snapshots ORDER BY created_at DESC LIMIT ?`).all(safeLimit);
    return rows as StoredSnapshot[];
  }

  get(id: string): StoredSnapshot | undefined {
    const row = this.db.prepare(`SELECT id, volume_id AS volumeId, label, created_at AS createdAt,
      processed_count AS processedCount, volume_serial AS volumeSerial, anchor_iso AS anchorIso
      FROM snapshots WHERE id = ?`).get(id);
    return row as StoredSnapshot | undefined;
  }

  close(): void {
    this.db.close();
  }
}
