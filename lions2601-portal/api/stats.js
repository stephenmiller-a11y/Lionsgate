// api/stats.js
// Vercel serverless function — fetches live post stats from YouTube, Instagram,
// and TikTok and writes them back to Airtable deliverables records.
//
// Required env vars:
//   AIRTABLE_TOKEN        — Airtable Personal Access Token
//
// Per-platform env vars (only needed for the platforms you use):
//   YOUTUBE_API_KEY           — YouTube Data API v3 key (Google Cloud Console)
//   INSTAGRAM_ACCESS_TOKEN    — Meta long-lived User Access Token with instagram_basic scope
//   APIFY_API_TOKEN           — Apify API token (apify.com) — used for TikTok scraping

const BASE_ID            = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const AT_BASE            = `https://api.airtable.com/v0/${BASE_ID}`;
const DELIVERABLES_TABLE = 'tblNOrIcXwZ0R78LJ';

// Deliverable field IDs
const F_VIEWS       = 'fldliR0ZyX2OzMkvs';
const F_LIKES       = 'fld3BhTWQ1IdTe6um';
const F_COMMENTS    = 'fldTm8YrIhRvRCQUr';
const F_SHARES      = 'fldqqQzTtUl6k5crI';
const F_SOCIAL_POST = 'fldHkJxRyOoTrXvHc';

// ── Platform detection ────────────────────────────────────────────────────────

function detectPlatform(url) {
  if (!url) return null;
  if (/youtube\.com|youtu\.be/.test(url))  return 'youtube';
  if (/instagram\.com/.test(url))          return 'instagram';
  if (/tiktok\.com/.test(url))             return 'tiktok';
  return null;
}

// ── YouTube ───────────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

async function fetchYouTubeStats(videoIds, apiKey) {
  const result = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${chunk.join(',')}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) { const b = await res.text(); throw new Error(`YouTube API [${res.status}]: ${b}`); }
    const data = await res.json();
    for (const item of (data.items || [])) {
      const s = item.statistics || {}, sn = item.snippet || {};
      result[item.id] = {
        views:       s.viewCount    != null ? parseInt(s.viewCount,    10) : null,
        likes:       s.likeCount    != null ? parseInt(s.likeCount,    10) : null,
        comments:    s.commentCount != null ? parseInt(s.commentCount, 10) : null,
        publishedAt: sn.publishedAt || null,
      };
    }
  }
  return result;
}

// ── Instagram ─────────────────────────────────────────────────────────────────
// Uses the Instagram Graph API with a long-lived access token.
// The shortcode (e.g. "CxyzABC") in the URL is decoded to a numeric media ID
// using the standard base64url alphabet Instagram uses internally.

function extractInstagramShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function shortcodeToMediaId(shortcode) {
  // Instagram encodes media IDs in base64url; reverse it to get the numeric ID
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = BigInt(0);
  for (const char of shortcode) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) return null;
    id = id * BigInt(64) + BigInt(idx);
  }
  return id.toString();
}

async function fetchInstagramStats(mediaId, token) {
  // video_views = play count; like_count / comments_count also available
  const url = `https://graph.facebook.com/v19.0/${mediaId}?fields=video_views,like_count,comments_count,timestamp&access_token=${token}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`Instagram API: ${data.error.message}`);
  return {
    views:       data.video_views    ?? null,
    likes:       data.like_count     ?? null,
    comments:    data.comments_count ?? null,
    publishedAt: data.timestamp      || null,
  };
}

// ── TikTok (via Apify clockworks/tiktok-scraper) ─────────────────────────────
// Requires APIFY_API_TOKEN env var. Get one at apify.com.
// Uses run-sync-get-dataset-items so results come back in a single request.

function extractTikTokVideoId(url) {
  const m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchTikTokStatsApify(deliverables, apiToken, sessionId) {
  const urls = deliverables.map(d => d.postLink);

  const input = {
    postURLs:                      urls,
    shouldDownloadVideos:          false,
    shouldDownloadCovers:          false,
    shouldDownloadSubtitles:       false,
    shouldDownloadSlideshowImages: false,
  };

  // Pass a logged-in session cookie so age-restricted videos are accessible
  if (sessionId) {
    input.cookies = [
      { name: 'sessionid', value: sessionId, domain: '.tiktok.com' },
    ];
  }

  // Run the Apify TikTok scraper synchronously — waits up to 120s for results
  const res = await fetch(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?token=${apiToken}&timeout=120`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!res.ok) {
    const b = await res.text();
    throw new Error(`Apify TikTok scraper [${res.status}]: ${b}`);
  }

  const items = await res.json();

  // Build a map: videoId (string) → stats
  // IMPORTANT: TikTok video IDs are 19-digit numbers that exceed JS safe integer range.
  // Apify may return them as JSON numbers which lose precision. Extract from the URL
  // string instead (webVideoUrl) which preserves the full digit sequence.
  const byVideoId = {};
  for (const item of (Array.isArray(items) ? items : [])) {
    const urlId = extractTikTokVideoId(item.webVideoUrl || item.videoUrl || '');
    const id    = urlId || String(item.id ?? '');
    if (!id) continue;
    byVideoId[id] = {
      views:       item.playCount    ?? item.stats?.playCount    ?? null,
      likes:       item.diggCount    ?? item.stats?.diggCount    ?? null,
      comments:    item.commentCount ?? item.stats?.commentCount ?? null,
      shares:      item.shareCount   ?? item.stats?.shareCount   ?? null,
      publishedAt: item.createTimeISO
        || (item.createTime ? new Date(item.createTime * 1000).toISOString() : null),
    };
  }
  return byVideoId;
}

// ── Airtable PATCH ────────────────────────────────────────────────────────────

async function patchDeliverable(recordId, fields, token) {
  const res = await fetch(`${AT_BASE}/${DELIVERABLES_TABLE}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) { const b = await res.text(); throw new Error(`Airtable PATCH [${res.status}] ${recordId}: ${b}`); }
  return res.json();
}

function buildFields(stats) {
  const fields = {};
  if (stats.views       != null) fields[F_VIEWS]       = stats.views;
  if (stats.likes       != null) fields[F_LIKES]       = stats.likes;
  if (stats.comments    != null) fields[F_COMMENTS]    = stats.comments;
  if (stats.shares      != null) fields[F_SHARES]      = stats.shares;
  if (stats.publishedAt != null) fields[F_SOCIAL_POST] = stats.publishedAt;
  return fields;
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const airtableToken = process.env.AIRTABLE_TOKEN;
  if (!airtableToken) return res.status(500).json({ error: 'AIRTABLE_TOKEN not configured.' });

  const youtubeKey      = process.env.YOUTUBE_API_KEY;
  const instagramToken  = process.env.INSTAGRAM_ACCESS_TOKEN;
  const apifyToken      = process.env.APIFY_API_TOKEN;
  const tiktokSessionId = process.env.TIKTOK_SESSION_ID;

  const { deliverables } = req.body || {};
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    return res.status(400).json({ error: 'Missing deliverables array in request body.' });
  }

  // Group by platform
  const byPlatform = { youtube: [], instagram: [], tiktok: [], unknown: [] };
  for (const d of deliverables) {
    if (!d.postLink) { byPlatform.unknown.push(d); continue; }
    const platform = detectPlatform(d.postLink);
    (byPlatform[platform] || byPlatform.unknown).push(d);
  }

  const results  = [];
  const warnings = [];

  try {
    // ── YouTube ────────────────────────────────────────────────────────────────
    if (byPlatform.youtube.length > 0) {
      if (!youtubeKey) {
        warnings.push('YouTube: YOUTUBE_API_KEY not configured — skipped.');
      } else {
        const idMap = {};
        for (const d of byPlatform.youtube) {
          const vid = extractYouTubeId(d.postLink);
          if (vid) idMap[vid] = d;
          else warnings.push(`YouTube: could not parse video ID from ${d.postLink}`);
        }
        const statsMap = await fetchYouTubeStats(Object.keys(idMap), youtubeKey);
        await Promise.all(Object.entries(idMap).map(async ([vid, d]) => {
          const stats = statsMap[vid];
          if (!stats) { results.push({ id: d.id, platform: 'youtube', status: 'not_found' }); return; }
          await patchDeliverable(d.id, buildFields(stats), airtableToken);
          results.push({ id: d.id, platform: 'youtube', status: 'updated', ...stats });
        }));
      }
    }

    // ── Instagram ──────────────────────────────────────────────────────────────
    if (byPlatform.instagram.length > 0) {
      if (!instagramToken) {
        warnings.push('Instagram: INSTAGRAM_ACCESS_TOKEN not configured — skipped. Add a long-lived Meta User Access Token in Vercel env vars.');
      } else {
        await Promise.all(byPlatform.instagram.map(async (d) => {
          const shortcode = extractInstagramShortcode(d.postLink);
          if (!shortcode) { warnings.push(`Instagram: could not parse shortcode from ${d.postLink}`); return; }
          const mediaId = shortcodeToMediaId(shortcode);
          if (!mediaId) { warnings.push(`Instagram: could not decode media ID for ${d.postLink}`); return; }
          try {
            const stats = await fetchInstagramStats(mediaId, instagramToken);
            await patchDeliverable(d.id, buildFields(stats), airtableToken);
            results.push({ id: d.id, platform: 'instagram', status: 'updated', ...stats });
          } catch (err) {
            warnings.push(`Instagram (${shortcode}): ${err.message}`);
            results.push({ id: d.id, platform: 'instagram', status: 'error' });
          }
        }));
      }
    }

    // ── TikTok (via Apify) ─────────────────────────────────────────────────────
    if (byPlatform.tiktok.length > 0) {
      if (!apifyToken) {
        warnings.push('TikTok: APIFY_API_TOKEN not configured — skipped. Add your Apify token to Vercel env vars.');
      } else {
        try {
          const byVideoId = await fetchTikTokStatsApify(byPlatform.tiktok, apifyToken, tiktokSessionId);
          await Promise.all(byPlatform.tiktok.map(async (d) => {
            const videoId = extractTikTokVideoId(d.postLink);
            if (!videoId) { warnings.push(`TikTok: could not parse video ID from ${d.postLink}`); return; }
            const stats = byVideoId[videoId];
            if (!stats) { results.push({ id: d.id, platform: 'tiktok', status: 'not_found' }); return; }
            await patchDeliverable(d.id, buildFields(stats), airtableToken);
            results.push({ id: d.id, platform: 'tiktok', status: 'updated', ...stats });
          }));
        } catch (err) {
          warnings.push(`TikTok (Apify): ${err.message}`);
          byPlatform.tiktok.forEach(d => results.push({ id: d.id, platform: 'tiktok', status: 'error' }));
        }
      }
    }

    const updated = results.filter(r => r.status === 'updated').length;
    const byPlat  = ['youtube','instagram','tiktok'].map(p => {
      const n = results.filter(r => r.platform === p && r.status === 'updated').length;
      return n > 0 ? `${n} ${p}` : null;
    }).filter(Boolean).join(', ');

    const message = updated > 0
      ? `Updated ${updated} deliverable${updated !== 1 ? 's' : ''} (${byPlat}).`
      : 'No stats were updated.';

    return res.status(200).json({
      updated,
      skipped: byPlatform.unknown.length,
      message,
      warnings: warnings.length > 0 ? warnings : undefined,
      results,
    });

  } catch (err) {
    console.error('[api/stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
