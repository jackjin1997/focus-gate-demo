import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type * as NodeSqlite from 'node:sqlite'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite

type JsonObject = Record<string, unknown>

export interface StoredReadPlan {
  id: string
  digest: string
  approvalNonceHash: string
  startsAt: string
  endsAt: string
  expiresAt: string
  manifest: JsonObject
  status: 'pending' | 'approved'
  approvedAt: string | null
}

export interface StoredInboundEvent {
  runId: string
  sourceId: string
  occurredAt: string
  senderOpenId: string | null
  chatId: string | null
  content: string | null
  metadata: JsonObject
  rawDeletedAt: string | null
}

export interface StoredDigest {
  id: string
  runId: string
  createdAt: string
  summary: JsonObject
}

export interface StoredReadRun {
  id: string
  planId: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  completedAt: string | null
  failureCode: string | null
}

export interface StoredCapabilityReview {
  id: string
  createdAt: string
  report: JsonObject
}

function parseJson(value: unknown): JsonObject {
  if (typeof value !== 'string') return {}
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {}
}

export class FocusGateStore {
  private readonly database: NodeSqlite.DatabaseSync
  private closed = false

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode = WAL;')
    this.database.exec('PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close() {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  saveCapabilityReview(review: StoredCapabilityReview) {
    this.database
      .prepare(`
        INSERT INTO capability_reviews (id, created_at, report_json)
        VALUES (?, ?, ?)
      `)
      .run(review.id, review.createdAt, JSON.stringify(review.report))
  }

  getLatestCapabilityReview(): StoredCapabilityReview | null {
    const row = this.database
      .prepare('SELECT * FROM capability_reviews ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      createdAt: String(row.created_at),
      report: parseJson(row.report_json),
    }
  }

  saveReadPlan(plan: Omit<StoredReadPlan, 'status' | 'approvedAt'>) {
    this.database
      .prepare(`
        INSERT INTO read_plans (
          id, digest, approval_nonce_hash, starts_at, ends_at, expires_at,
          manifest_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(
        plan.id,
        plan.digest,
        plan.approvalNonceHash,
        plan.startsAt,
        plan.endsAt,
        plan.expiresAt,
        JSON.stringify(plan.manifest),
        new Date().toISOString(),
      )
  }

  getReadPlan(id: string): StoredReadPlan | null {
    const row = this.database
      .prepare('SELECT * FROM read_plans WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      digest: String(row.digest),
      approvalNonceHash: String(row.approval_nonce_hash),
      startsAt: String(row.starts_at),
      endsAt: String(row.ends_at),
      expiresAt: String(row.expires_at),
      manifest: parseJson(row.manifest_json),
      status: row.status === 'approved' ? 'approved' : 'pending',
      approvedAt: row.approved_at ? String(row.approved_at) : null,
    }
  }

  claimReadPlan(input: {
    id: string
    digest: string
    approvalNonceHash: string
    now: string
  }): StoredReadPlan {
    this.database.exec('BEGIN IMMEDIATE;')
    try {
      const plan = this.getReadPlan(input.id)
      if (!plan) throw new Error('READ_PLAN_NOT_FOUND')
      if (plan.digest !== input.digest || plan.approvalNonceHash !== input.approvalNonceHash) {
        throw new Error('READ_PLAN_MISMATCH')
      }
      if (plan.status !== 'pending') throw new Error('READ_PLAN_ALREADY_CLAIMED')
      const now = Date.parse(input.now)
      const expiresAt = Date.parse(plan.expiresAt)
      if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || now >= expiresAt) {
        throw new Error('READ_PLAN_EXPIRED')
      }

      const update = this.database
        .prepare(`
          UPDATE read_plans
          SET status = 'approved', approved_at = ?
          WHERE id = ? AND status = 'pending'
        `)
        .run(input.now, input.id)
      if (Number(update.changes) !== 1) throw new Error('READ_PLAN_ALREADY_CLAIMED')
      this.database.exec('COMMIT;')
      return { ...plan, status: 'approved', approvedAt: input.now }
    } catch (error) {
      this.database.exec('ROLLBACK;')
      throw error
    }
  }

  createReadRun(input: { id: string; planId: string; startedAt: string }) {
    this.database
      .prepare(`
        INSERT INTO read_runs (id, plan_id, status, started_at)
        VALUES (?, ?, 'running', ?)
      `)
      .run(input.id, input.planId, input.startedAt)
  }

  getReadRun(id: string): StoredReadRun | null {
    const row = this.database
      .prepare('SELECT * FROM read_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    const status = row.status === 'completed'
      ? 'completed'
      : row.status === 'failed'
        ? 'failed'
        : 'running'
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      status,
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      failureCode: row.failure_code ? String(row.failure_code) : null,
    }
  }

  listReadRunsForPlan(planId: string): StoredReadRun[] {
    const rows = this.database
      .prepare('SELECT * FROM read_runs WHERE plan_id = ? ORDER BY started_at, rowid')
      .all(planId) as Record<string, unknown>[]
    return rows.map(readRunFromRow)
  }

  recoverInterruptedReads(recoveredAt: string) {
    this.database.exec('BEGIN IMMEDIATE;')
    try {
      const interrupted = this.database.prepare(`
        UPDATE read_runs
        SET status = 'failed', completed_at = ?,
            failure_code = 'PROCESS_INTERRUPTED_RESULT_UNKNOWN'
        WHERE status = 'running'
      `).run(recoveredAt)
      const orphaned = this.database.prepare(`
        INSERT INTO read_runs (
          id, plan_id, status, started_at, completed_at, failure_code
        )
        SELECT
          'recovered_' || lower(hex(randomblob(16))),
          plans.id,
          'failed',
          COALESCE(plans.approved_at, plans.created_at),
          ?,
          'PROCESS_INTERRUPTED_BEFORE_RUN'
        FROM read_plans AS plans
        WHERE plans.status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM read_runs AS runs WHERE runs.plan_id = plans.id
          )
      `).run(recoveredAt)
      this.database.exec('COMMIT;')
      return {
        interruptedRuns: Number(interrupted.changes),
        orphanedPlans: Number(orphaned.changes),
      }
    } catch (error) {
      this.database.exec('ROLLBACK;')
      throw error
    }
  }

  failReadRun(input: { id: string; failedAt: string; failureCode: string }) {
    const update = this.database
      .prepare(`
        UPDATE read_runs
        SET status = 'failed', completed_at = ?, failure_code = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(input.failedAt, input.failureCode, input.id)
    if (Number(update.changes) !== 1) throw new Error('READ_RUN_NOT_RUNNING')
  }

  upsertInboundEvent(event: {
    runId: string
    sourceId: string
    occurredAt: string
    senderOpenId?: string | null
    chatId?: string | null
    metadata: JsonObject
    observedAt: string
  }) {
    this.database
      .prepare(`
        INSERT INTO inbound_events (
          run_id, source_id, occurred_at, sender_open_id, chat_id,
          content, metadata_json, observed_at, raw_deleted_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(run_id, source_id) DO UPDATE SET
          occurred_at = excluded.occurred_at,
          sender_open_id = excluded.sender_open_id,
          chat_id = excluded.chat_id,
          content = NULL,
          metadata_json = excluded.metadata_json,
          observed_at = excluded.observed_at,
          raw_deleted_at = excluded.raw_deleted_at
      `)
      .run(
        event.runId,
        event.sourceId,
        event.occurredAt,
        event.senderOpenId ?? null,
        event.chatId ?? null,
        JSON.stringify(event.metadata),
        event.observedAt,
        event.observedAt,
      )
  }

  listInboundEvents(runId: string): StoredInboundEvent[] {
    const rows = this.database
      .prepare('SELECT * FROM inbound_events WHERE run_id = ? ORDER BY occurred_at ASC')
      .all(runId) as Record<string, unknown>[]
    return rows.map((row) => ({
      runId: String(row.run_id),
      sourceId: String(row.source_id),
      occurredAt: String(row.occurred_at),
      senderOpenId: row.sender_open_id ? String(row.sender_open_id) : null,
      chatId: row.chat_id ? String(row.chat_id) : null,
      content: row.content === null ? null : String(row.content),
      metadata: parseJson(row.metadata_json),
      rawDeletedAt: row.raw_deleted_at ? String(row.raw_deleted_at) : null,
    }))
  }

  saveDigestAndCompleteRun(digest: StoredDigest) {
    this.database.exec('BEGIN IMMEDIATE;')
    try {
      this.database
        .prepare(`
          INSERT INTO digests (id, run_id, created_at, summary_json)
          VALUES (?, ?, ?, ?)
        `)
        .run(digest.id, digest.runId, digest.createdAt, JSON.stringify(digest.summary))
      this.database
        .prepare(`
          UPDATE read_runs
          SET status = 'completed', completed_at = ?
          WHERE id = ?
        `)
        .run(digest.createdAt, digest.runId)
      this.database.exec('COMMIT;')
    } catch (error) {
      this.database.exec('ROLLBACK;')
      throw error
    }
  }

  getDigestByRunId(runId: string): StoredDigest | null {
    const row = this.database
      .prepare('SELECT * FROM digests WHERE run_id = ?')
      .get(runId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      runId: String(row.run_id),
      createdAt: String(row.created_at),
      summary: parseJson(row.summary_json),
    }
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS capability_reviews (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS read_plans (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        approval_nonce_hash TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved')),
        created_at TEXT NOT NULL,
        approved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS read_runs (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        coverage_json TEXT,
        failure_code TEXT
      );

      CREATE TABLE IF NOT EXISTS inbound_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sender_open_id TEXT,
        chat_id TEXT,
        content TEXT,
        metadata_json TEXT NOT NULL,
        raw_deleted_at TEXT,
        UNIQUE(run_id, source_id)
      );

      CREATE TABLE IF NOT EXISTS digests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
    `)
    this.ensureColumn('read_runs', 'failure_code', 'TEXT')
    this.database.exec(`
      UPDATE inbound_events
      SET content = NULL,
          raw_deleted_at = COALESCE(raw_deleted_at, observed_at)
      WHERE content IS NOT NULL OR raw_deleted_at IS NULL;
    `)
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Record<string, unknown>[]
    if (columns.some((candidate) => candidate.name === column)) return
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
}

function readRunFromRow(row: Record<string, unknown>): StoredReadRun {
  const status = row.status === 'completed'
    ? 'completed'
    : row.status === 'failed'
      ? 'failed'
      : 'running'
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    status,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    failureCode: row.failure_code ? String(row.failure_code) : null,
  }
}
