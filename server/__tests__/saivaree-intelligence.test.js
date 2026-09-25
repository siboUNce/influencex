const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DB = path.join(
  os.tmpdir(),
  `influencex-saivaree-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
);

process.env.SQLITE_DB_PATH = TMP_DB;
process.env.DATABASE_URL = '';

const database = require('../database');
const { initializeDatabase, query, queryOne, exec } = database;
const { runPendingMigrations } = require('../migrations');
const { getSaivareeMeta, upsertSaivareeMeta } = require('../saivaree/intelligence-routes');

before(async () => {
  await initializeDatabase();
  await runPendingMigrations({ query, queryOne, exec });
});

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch {}
  }
});

test('saivaree_kol_meta migration creates constrained sidecar table idempotently', async () => {
  const second = await runPendingMigrations({ query, queryOne, exec });
  assert.equal(second.applied, 0);

  const table = await queryOne(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ['saivaree_kol_meta']
  );
  assert.ok(table?.sql, 'sidecar table must exist');
  for (const column of [
    'workspace_id',
    'kol_database_id',
    'platform',
    'username',
    'saivaree_creator_id',
    'clinic_status',
    'clinic_rating',
    'clinic_notes',
    'created_at',
    'updated_at',
  ]) {
    assert.match(table.sql, new RegExp('\\b' + column + '\\b', 'i'));
  }
  assert.match(table.sql, /UNIQUE\s*\(workspace_id,\s*kol_database_id\)/i);
  assert.match(table.sql, /clinic_rating\s+IS\s+NULL/i);

  await exec(
    `INSERT INTO saivaree_kol_meta
       (workspace_id, kol_database_id, platform, username, clinic_status, clinic_rating)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['ws-a', 'kol-a', 'tiktok', 'creator.a', 'contacted', 5]
  );

  await assert.rejects(
    exec(
      `INSERT INTO saivaree_kol_meta
         (workspace_id, kol_database_id, platform, username, clinic_status)
       VALUES (?, ?, ?, ?, ?)`,
      ['ws-a', 'kol-b', 'tiktok', 'creator.b', 'invalid-status']
    ),
    /CHECK constraint failed/i
  );

  await assert.rejects(
    exec(
      `INSERT INTO saivaree_kol_meta
         (workspace_id, kol_database_id, platform, username, clinic_rating)
       VALUES (?, ?, ?, ?, ?)`,
      ['ws-a', 'kol-c', 'tiktok', 'creator.c', 6]
    ),
    /CHECK constraint failed/i
  );

  await assert.rejects(
    exec(
      `INSERT INTO saivaree_kol_meta
         (workspace_id, kol_database_id, platform, username)
       VALUES (?, ?, ?, ?)`,
      ['ws-a', 'kol-a', 'tiktok', 'creator.a']
    ),
    /UNIQUE constraint failed/i
  );
});

test('saivaree metadata helpers isolate workspace and kol id', async () => {
  const dbApi = { queryOne, exec };

  await upsertSaivareeMeta(dbApi, 'ws-a', 'shared-kol', {
    platform: 'tiktok',
    username: 'creator.same',
    clinic_status: 'worked_with',
    clinic_rating: 5,
    clinic_notes: 'A only',
  });
  await upsertSaivareeMeta(dbApi, 'ws-b', 'shared-kol', {
    platform: 'tiktok',
    username: 'creator.same',
    clinic_status: 'watching',
    clinic_rating: 2,
    clinic_notes: 'B only',
  });

  const a = await getSaivareeMeta(dbApi, 'ws-a', 'shared-kol');
  const b = await getSaivareeMeta(dbApi, 'ws-b', 'shared-kol');

  assert.equal(a.clinic_status, 'worked_with');
  assert.equal(a.clinic_rating, 5);
  assert.equal(a.clinic_notes, 'A only');
  assert.equal(b.clinic_status, 'watching');
  assert.equal(b.clinic_rating, 2);
  assert.equal(b.clinic_notes, 'B only');
});
