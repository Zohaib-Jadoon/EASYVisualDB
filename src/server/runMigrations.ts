import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runControlPlaneMigrations } from './migrations';

const dataDir = process.env.VDS_DATA_DIR
  ? path.resolve(process.env.VDS_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'control-plane.db');

const db = new DatabaseSync(dbPath);
const applied = runControlPlaneMigrations(db);
console.log(`Control-plane database ready at ${dbPath}`);
for (const m of applied) {
  console.log(`  [${m.id}] ${m.name} (applied ${m.appliedAt})`);
}
db.close();
