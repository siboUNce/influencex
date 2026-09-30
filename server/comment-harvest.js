/**
 * Comment / inbox harvesting via Apify (skeleton — Phase C).
 *
 * Pulls top comments from a given Instagram post or TikTok video URL and
 * normalizes them into the `inbox_messages` shape so the existing Community
 * Inbox UI can render them. Currently exposes module functions only —
 * dispatcher routes will be added when the Inbox UI gets the "sync from
 * Apify" action wired up.
 *
 * Default actors:
 *   - apify/instagram-comment-scraper
 *   - clockworks/tiktok-comments-scraper (or equivalent)
 */

const apify = require('./apify-client');
const quota = require('./apify-quota');

const IG_ACTOR = process.env.APIFY_IG_COMMENTS_ACTOR_ID || 'apify/instagram-comment-scraper';
const TT_ACTOR = process.env.APIFY_TT_COMMENTS_ACTOR_ID || 'clockworks/tiktok-comments-scraper';

function normalizeIgComment(item, postUrl) {
  if (!item) return null;
  return {
    platform: 'instagram',
    external_id: item.id,
    author_handle: item.ownerUsername || item.owner?.username || '',
    author_name: item.owner?.full_name || item.ownerUsername || '',
    body: item.text || '',
    created_at: item.timestamp ? new Date(item.timestamp).toISOString() : null,
    likes: item.likesCount || 0,
    source_url: postUrl,
  };
}

function normalizeTtComment(item, videoUrl) {
  if (!item) return null;
  return {
    platform: 'tiktok',
    external_id: item.cid || item.id,
    author_handle: item.user?.uniqueId || item.user?.unique_id || '',
    author_name: item.user?.nickname || '',
    public_author_bio: [item.user?.signature, item.user?.bio].filter(value => typeof value === 'string').join(' ').slice(0, 500),
    public_author_locality: [item.user?.city, item.user?.region, item.user?.country, item.user?.locality].filter(value => typeof value === 'string').join(' ').slice(0, 300),
    body: item.text || '',
    created_at: item.create_time ? new Date(item.create_time * 1000).toISOString() : null,
    likes: item.digg_count || 0,
    source_url: videoUrl,
  };
}

async function harvestInstagramComments({ postUrls, limitPerPost = 50, workspaceId } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!Array.isArray(postUrls) || postUrls.length === 0) return { success: false, error: 'postUrls required' };

  const out = [];
  for (const url of postUrls.slice(0, 20)) {
    const check = quota.canCall(IG_ACTOR, limitPerPost, workspaceId);
    if (!check.allowed) {
      console.warn(`[comment-harvest] IG harvest skipped — quota exhausted (${check.reason})`);
      break;
    }
    const r = await apify.runActor(IG_ACTOR, {
      directUrls: [url],
      resultsLimit: limitPerPost,
    }, { workspaceId });
    if (!r.success) continue;
    quota.record(IG_ACTOR, r.items?.length || 0, workspaceId);
    for (const it of r.items || []) {
      const norm = normalizeIgComment(it, url);
      if (norm) out.push(norm);
    }
  }
  return { success: true, comments: out };
}

async function harvestTikTokComments({ videoUrls, limitPerVideo = 50, workspaceId, strict = false } = {}) {
  if (!apify.isConfigured()) return { success: false, error: 'APIFY_TOKEN not configured' };
  if (!Array.isArray(videoUrls) || videoUrls.length === 0) return { success: false, error: 'videoUrls required' };

  if (strict) limitPerVideo = Math.min(30, Math.max(1, Number.isInteger(limitPerVideo) ? limitPerVideo : 30));
  const out = [];
  const runs = [];
  let postsSampled = 0;
  const coverage = () => ({ posts_sampled: postsSampled, successful_post_count: postsSampled, failed_post_count: runs.filter(run => !run.success).length });
  for (const url of [...new Set(videoUrls)].slice(0, strict ? 3 : 20)) {
    const check = quota.canCall(TT_ACTOR, limitPerVideo, workspaceId);
    if (!check.allowed) {
      console.warn(`[comment-harvest] TT harvest skipped — quota exhausted (${check.reason})`);
      if (strict) return { success: false, code: 'quota_exceeded', comments: out, runs };
      break;
    }
    const r = await apify.runActor(TT_ACTOR, {
      postURLs: [url],
      commentsPerPost: limitPerVideo,
    }, { workspaceId });
    runs.push({ actor_id: TT_ACTOR, run_id: r.runId || null, success: r.success === true });
    if (strict && !r.success) quota.record(TT_ACTOR, 0, workspaceId);
    if (!r.success) {
      if (strict) return { success: postsSampled > 0, partial: postsSampled > 0, code: 'comment_provider_failed', comments: out, runs, ...coverage() };
      continue;
    }
    quota.record(TT_ACTOR, r.items?.length || 0, workspaceId);
    const before = out.length;
    for (const it of (r.items || []).slice(0, limitPerVideo)) {
      const norm = normalizeTtComment(it, url);
      if (norm && (!strict || [norm.body, norm.public_author_locality, norm.public_author_bio].some(value => typeof value === 'string' && value.trim()))) out.push(norm);
    }
    if (out.length > before) postsSampled++;
  }
  return { success: true, comments: out, runs, ...(strict ? { partial: false, ...coverage() } : {}) };
}

module.exports = {
  harvestInstagramComments,
  harvestTikTokComments,
  normalizeIgComment,
  normalizeTtComment,
  IG_ACTOR,
  TT_ACTOR,
};
