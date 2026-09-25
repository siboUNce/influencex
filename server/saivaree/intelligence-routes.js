'use strict';

async function getSaivareeMeta(db, workspaceId, kolId) {
  return db.queryOne(
    'SELECT * FROM saivaree_kol_meta WHERE workspace_id = ? AND kol_database_id = ?',
    [workspaceId, kolId]
  );
}

async function upsertSaivareeMeta(db, workspaceId, kolId, patch) {
  const current = await getSaivareeMeta(db, workspaceId, kolId);
  const next = {
    platform: patch.platform ?? current?.platform,
    username: patch.username ?? current?.username,
    saivaree_creator_id:
      patch.saivaree_creator_id ?? current?.saivaree_creator_id ?? null,
    clinic_status: patch.clinic_status ?? current?.clinic_status ?? 'watching',
    clinic_rating:
      Object.prototype.hasOwnProperty.call(patch, 'clinic_rating')
        ? patch.clinic_rating
        : current?.clinic_rating ?? null,
    clinic_notes:
      Object.prototype.hasOwnProperty.call(patch, 'clinic_notes')
        ? patch.clinic_notes
        : current?.clinic_notes ?? null,
  };

  if (!next.platform || !next.username) {
    throw new Error('platform and username are required for Saivaree metadata');
  }

  if (current) {
    await db.exec(
      `UPDATE saivaree_kol_meta
       SET platform = ?, username = ?, saivaree_creator_id = ?,
           clinic_status = ?, clinic_rating = ?, clinic_notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = ? AND kol_database_id = ?`,
      [
        next.platform,
        next.username,
        next.saivaree_creator_id,
        next.clinic_status,
        next.clinic_rating,
        next.clinic_notes,
        workspaceId,
        kolId,
      ]
    );
  } else {
    await db.exec(
      `INSERT INTO saivaree_kol_meta
       (workspace_id, kol_database_id, platform, username, saivaree_creator_id,
        clinic_status, clinic_rating, clinic_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        kolId,
        next.platform,
        next.username,
        next.saivaree_creator_id,
        next.clinic_status,
        next.clinic_rating,
        next.clinic_notes,
      ]
    );
  }

  return getSaivareeMeta(db, workspaceId, kolId);
}

module.exports = {
  getSaivareeMeta,
  upsertSaivareeMeta,
};
