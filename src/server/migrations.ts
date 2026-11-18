import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './crypto';

export interface MigrationRecord {
  id: string;
  name: string;
  appliedAt: string;
}

interface MigrationStep {
  id: string;
  name: string;
  up: (db: DatabaseSync) => void;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

const MIGRATIONS: MigrationStep[] = [
  {
    id: '001',
    name: 'initial_control_plane_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          organization_name TEXT NOT NULL,
          name TEXT NOT NULL,
          region TEXT NOT NULL,
          plan_tier TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS members (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          schema_write INTEGER NOT NULL,
          data_write INTEGER NOT NULL,
          mfa_enabled INTEGER NOT NULL,
          status TEXT NOT NULL,
          joined_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          method TEXT NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          database_name TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          username TEXT NOT NULL,
          encrypted_secret TEXT NOT NULL,
          encrypt INTEGER NOT NULL,
          trust_cert INTEGER NOT NULL,
          read_only INTEGER NOT NULL,
          environment TEXT NOT NULL,
          status TEXT NOT NULL,
          engine_version TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          last_error TEXT,
          capabilities_json TEXT NOT NULL,
          agent_id TEXT,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS schema_snapshots (
          connection_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS change_plans (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          environment TEXT NOT NULL,
          title TEXT NOT NULL,
          plain_explanation TEXT NOT NULL,
          operations_json TEXT NOT NULL,
          sql_preview TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          requires_confirm_text TEXT,
          requires_approval INTEGER NOT NULL,
          status TEXT NOT NULL,
          target_fingerprint TEXT NOT NULL,
          digest TEXT NOT NULL,
          preflight_json TEXT NOT NULL,
          created_by_id TEXT NOT NULL,
          created_by_name TEXT NOT NULL,
          approved_by_id TEXT,
          approved_by_name TEXT,
          created_at TEXT NOT NULL,
          executed_at TEXT,
          execution_summary TEXT,
          error_message TEXT,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          target TEXT NOT NULL,
          database_name TEXT,
          status TEXT NOT NULL,
          detail TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS diagram_layouts (
          connection_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          positions_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS saved_queries (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          name TEXT NOT NULL,
          sql_text TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS query_history (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          sql_text TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          executed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS windows_agents (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          hostname TEXT NOT NULL,
          version TEXT NOT NULL,
          status TEXT NOT NULL,
          last_heartbeat_at TEXT,
          pairing_token_hash TEXT NOT NULL,
          pairing_token_preview TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    id: '002',
    name: 'auth_sessions_invitations_billing',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS workspace_invitations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          email TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          token_preview TEXT NOT NULL,
          status TEXT NOT NULL,
          invited_by_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS billing_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          target_tier TEXT NOT NULL,
          status TEXT NOT NULL,
          note TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);

      // Seed password credentials for default localhost accounts so Sign In works out of the box
      const now = new Date().toISOString();
      const defaultPassHash = hashPassword('VisualDB#2026');
      const seededUsers = [
        ['usr_owner', 'Zainab Jadoon', 'zainab@visualdatastudio.io'],
        ['usr_designer', 'Hamza Malik', 'hamza@visualdatastudio.io'],
        ['usr_viewer', 'Sara Ahmed', 'sara@visualdatastudio.io'],
        ['usr_sec_owner', 'Omar Farooq', 'omar@crescentretail.pk'],
      ];
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      for (const [id, name, email] of seededUsers) {
        stmt.run(id, name, email, defaultPassHash, now);
      }
    },
  },
  {
    id: '003',
    name: 'connection_discovery_and_plan_baseline',
    up: (db) => {
      if (!hasColumn(db, 'connections', 'instance_name')) {
        db.exec(`ALTER TABLE connections ADD COLUMN instance_name TEXT;`);
      }
      if (!hasColumn(db, 'connections', 'timeout_ms')) {
        db.exec(`ALTER TABLE connections ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 8000;`);
      }
      if (!hasColumn(db, 'connections', 'reconnect_on_startup')) {
        db.exec(`ALTER TABLE connections ADD COLUMN reconnect_on_startup INTEGER NOT NULL DEFAULT 1;`);
      }
      if (!hasColumn(db, 'connections', 'domain')) {
        db.exec(`ALTER TABLE connections ADD COLUMN domain TEXT;`);
      }
      if (!hasColumn(db, 'change_plans', 'baseline_snapshot_json')) {
        db.exec(`ALTER TABLE change_plans ADD COLUMN baseline_snapshot_json TEXT;`);
      }
      if (!hasColumn(db, 'windows_agents', 'os_info')) {
        db.exec(`ALTER TABLE windows_agents ADD COLUMN os_info TEXT;`);
      }
      if (!hasColumn(db, 'windows_agents', 'discovered_count')) {
        db.exec(`ALTER TABLE windows_agents ADD COLUMN discovered_count INTEGER DEFAULT 0;`);
      }
    },
  },
];

export function runControlPlaneMigrations(db: DatabaseSync): MigrationRecord[] {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map((r) => r.id)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString()
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  const rows = db
    .prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC')
    .all() as Array<{ id: string; name: string; applied_at: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, appliedAt: r.applied_at }));
}
