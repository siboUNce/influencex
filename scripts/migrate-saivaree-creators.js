'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { upsertSaivareeMeta } = require('../server/saivaree/intelligence-routes');

const CLINIC_STATUSES = new Set([
  'watching',
  'interested',
  'contacted',
  'worked_with',
  'not_selected',
]);

function normalizeTikTokUsername(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('username is required');
  let candidate = value.trim();
  if (candidate.includes('://')) {
    let parsed;
    try { parsed = new URL(candidate); } catch { throw new Error('invalid TikTok profile URL'); }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) throw new Error('invalid TikTok profile URL');
    const segment = parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (!segment.startsWith('@')) throw new Error('invalid TikTok profile URL');
    candidate = segment.slice(1);
  } else {
    candidate = candidate.replace(/^@+/, '');
  }
  candidate = candidate.trim().toLowerCase();
  if (!/^[a-z0-9._]{1,64}$/.test(candidate)) throw new Error('invalid TikTok username');
  return candidate;
}

function normalizeMigrationRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record must be an object');
  const platform = String(record.platform || '').trim().toLowerCase();
  if (!platform) throw new Error('platform is required');

  let username = String(record.username || '').trim();
  let profileUrl = String(record.profile_url || '').trim();
  if (platform === 'tiktok') {
    username = normalizeTikTokUsername(username || profileUrl);
    profileUrl = 'https://www.tiktok.com/@' + username;
  } else {
    username = username.replace(/^@+/, '').trim().toLowerCase();
    if (!username) throw new Error('username is required');
    if (!profileUrl) throw new Error('profile_url is required for non-TikTok creators');
  }

  const clinicStatus = record.clinic_status == null || record.clinic_status === ''
    ? 'watching'
    : String(record.clinic_status);
  if (!CLINIC_STATUSES.has(clinicStatus)) throw new Error('invalid clinic_status');

  let clinicRating = record.clinic_rating;
  if (clinicRating === '' || clinicRating === undefined) clinicRating = null;
  if (clinicRating !== null) {
    clinicRating = Number(clinicRating);
    if (!Number.isInteger(clinicRating) || clinicRating < 1 || clinicRating > 5) throw new Error('clinic_rating must be 1-5 or null');
  }

  const clinicNotes = record.clinic_notes == null ? null : String(record.clinic_notes);
  const displayName = record.display_name == null || record.display_name === ''
    ? username
    : String(record.display_name);

  return {
    platform,
    username,
    display_name: displayName,
    profile_url: profileUrl,
    clinic_status: clinicStatus,
    clinic_rating: clinicRating,
    clinic_notes: clinicNotes,
  };
}

function identityKey(record) {
  return record.platform + ':' + record.username;
}

async function findExistingKol(db, workspaceId, record) {
  if (!workspaceId) return null;
  return db.queryOne(
    'SELECT * FROM kol_database WHERE workspace_id = ? AND platform = ? AND LOWER(username) = ?',
    [workspaceId, record.platform, record.username]
  );
}

async function planMigration({ db, workspaceId = null, records }) {
  if (!db || typeof db.queryOne !== 'function') throw new Error('db.queryOne is required');
  if (!Array.isArray(records)) throw new Error('migration input must be an array');

  const normalized = [];
  const invalid = [];
  for (let index = 0; index < records.length; index += 1) {
    try {
      normalized.push({ index, record: normalizeMigrationRecord(records[index]) });
    } catch (error) {
      invalid.push({ index, error: error.message });
    }
  }

  const grouped = new Map();
  for (const entry of normalized) {
    const key = identityKey(entry.record);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  const conflictKeys = new Set(
    [...grouped.entries()].filter(([, entries]) => entries.length > 1).map(([key]) => key)
  );

  const actions = [];
  let matched = 0;
  let wouldCreate = 0;
  for (const entry of normalized) {
    const key = identityKey(entry.record);
    if (conflictKeys.has(key)) continue;
    const existing = await findExistingKol(db, workspaceId, entry.record);
    if (existing) matched += 1;
    else wouldCreate += 1;
    actions.push({ ...entry, existing });
  }

  return {
    summary: {
      input: records.length,
      matched,
      wouldCreate,
      conflicts: conflictKeys.size,
      invalid: invalid.length,
    },
    actions,
    invalid,
    conflicts: [...conflictKeys],
  };
}

async function applyMigration({ db, workspaceId, records, idFactory = uuidv4 }) {
  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('workspaceId is required for apply');
  if (!db || typeof db.queryOne !== 'function' || typeof db.exec !== 'function') throw new Error('db.queryOne and db.exec are required');

  const plan = await planMigration({ db, workspaceId, records });
  if (plan.summary.conflicts > 0 || plan.summary.invalid > 0) {
    const error = new Error('migration input contains conflicts or invalid records');
    error.plan = plan;
    throw error;
  }

  let created = 0;
  let matched = 0;
  for (const action of plan.actions) {
    const record = action.record;
    let kol = action.existing;
    if (!kol) {
      const id = idFactory();
      await db.exec(
        "INSERT INTO kol_database (id, workspace_id, platform, username, display_name, profile_url, scrape_status) VALUES (?, ?, ?, ?, ?, ?, 'partial')",
        [id, workspaceId, record.platform, record.username, record.display_name, record.profile_url]
      );
      kol = { id };
      created += 1;
    } else {
      matched += 1;
    }

    await upsertSaivareeMeta(db, workspaceId, kol.id, {
      platform: record.platform,
      username: record.username,
      clinic_status: record.clinic_status,
      clinic_rating: record.clinic_rating,
      clinic_notes: record.clinic_notes,
    });
  }

  return {
    input: plan.summary.input,
    created,
    matched,
    conflicts: 0,
    invalid: 0,
  };
}

function parseArgs(argv) {
  const args = { apply: false, input: null, workspace: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--apply') args.apply = true;
    else if (value === '--input') args.input = argv[++i] || null;
    else if (value === '--workspace') args.workspace = argv[++i] || null;
    else throw new Error('unknown argument: ' + value);
  }
  if (!args.input) throw new Error('--input is required');
  if (args.apply && !args.workspace) throw new Error('--workspace is required with --apply');
  return args;
}

function readRecords(inputPath) {
  const fullPath = path.resolve(inputPath);
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  throw new Error('input JSON must be an array or contain a records array');
}

function printSummary(mode, summary) {
  process.stdout.write([
    'MODE=' + mode,
    'INPUT=' + summary.input,
    'MATCHED=' + summary.matched,
    (mode === 'dry-run' ? 'WOULD_CREATE=' : 'CREATED=') + (mode === 'dry-run' ? summary.wouldCreate : summary.created),
    'CONFLICTS=' + summary.conflicts,
    'INVALID=' + summary.invalid,
  ].join('\n') + '\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const records = readRecords(args.input);
  const database = require('../server/database');
  const { runPendingMigrations } = require('../server/migrations');
  await database.initializeDatabase();
  await runPendingMigrations({
    query: database.query,
    queryOne: database.queryOne,
    exec: database.exec,
    usePostgres: database.usePostgres,
  });

  if (!args.apply) {
    const result = await planMigration({
      db: { queryOne: database.queryOne },
      workspaceId: args.workspace,
      records,
    });
    printSummary('dry-run', result.summary);
    return;
  }

  const result = await applyMigration({
    db: { queryOne: database.queryOne, exec: database.exec },
    workspaceId: args.workspace,
    records,
  });
  printSummary('apply', result);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('MIGRATION_ERROR=' + error.message + '\n');
    if (error.plan) printSummary('dry-run', error.plan.summary);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeMigrationRecord,
  planMigration,
  applyMigration,
  parseArgs,
  readRecords,
  printSummary,
  main,
};
