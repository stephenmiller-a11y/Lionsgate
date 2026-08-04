// api/stats.js
// Vercel serverless function — fetches live post stats from YouTube, Instagram,
// and TikTok and writes them back to Airtable deliverables records.
//
// Required env vars:
//   AIRTABLE_TOKEN        — Airtable Personal Access Token
//
// Per-platform env vars (only needed for the platforms you use):
//   YOUTUBE_API_KEY   — YouTube Data API v3 key (Google Cloud Console)
//   APIFY_API_TOKEN   — Apify API token (apify.com) — used for Instagram + TikTok scraping

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

// ── Instagram (via Apify apify/instagram-scraper) ────────────────────────────
// No access token needed — uses the same APIFY_API_TOKEN as TikTok.
// Matches results back to deliverables via the post shortcode in the URL.

function extractInstagramShortcode(url) {
  if (!url) return null;
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function fetchInstagramStatsApify(deliverables, apiToken) {
  const urls = deliverables.map(d => d.postLink);

  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${apiToken}&timeout=120`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resultsType:  'posts',
        directUrls:   urls,
        resultsLimit: 1,
      }),
    }
  );

  if (!res.ok) {
    const b = await res.text();
    throw new Error(`Apify Instagram scraper [${res.status}]: ${b}`);
  }

  const items = await res.json();

  // Build a map: shortCode → stats
  const byShortCode = {};
  for (const item of (Array.isArray(items) ? items : [])) {
    const code = item.shortCode;
    if (!code) continue;
    byShortCode[code] = {
      // videoViewCount is for feed videos; igPlayCount for Reels — use whichever is present
      views:       item.videoViewCount ?? item.igPlayCount ?? item.videoPlayCount ?? null,
      likes:       item.likesCount     ?? null,
      comments:    item.commentsCount  ?? null,
      shares:      item.reshareCount   ?? null,
      publishedAt: item.timestamp      || null,
    };
  }
  return byShortCode;
}

// ── TikTok (via Apify clockworks/tiktok-scraper) ─────────────────────────────
// Requires APIFY_API_TOKEN env var. Get one at apify.com.
// Uses run-sync-get-dataset-items so results come back in a single request.

function extractTikTokVideoId(url) {
  if (!url) return null;
  // Handles /@username/video/ID and /@/video/ID (empty username)
  const m = url.match(/tiktok\.com\/@[^/]*\/video\/(\d+)/);
  if (m) return m[1];
  // Fallback: share_item_id query param (present in some share URLs)
  try {
    const id = new URL(url).searchParams.get('share_item_id');
    if (id && /^\d+$/.test(id)) return id;
  } catch {}
  return null;
}

function isShortTikTokUrl(url) {
  return /tiktok\.com\/t\/|vm\.tiktok\.com|vt\.tiktok\.com/.test(url || '');
}

// Follow redirect to resolve shortened TikTok URLs (e.g. tiktok.com/t/XXXX)
// to their canonical /@user/video/ID form so we can extract the video ID.
//
// Strategy: read the Location header from the first redirect hop (manual redirect
// mode). This is cheaper and less likely to be bot-blocked than following all
// hops. Falls back to fully-followed GET if the first hop doesn't land on a
// canonical URL.
async function resolveShortUrl(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // First try: read the Location header directly (no page body needed)
  try {
    const res = await fetch(url, {
      method:   'GET',
      redirect: 'manual',
      headers,
      signal:   AbortSignal.timeout(6000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      if (location && extractTikTokVideoId(location)) return location;
      // Location might itself need following — fall through to full redirect
    }
  } catch {}

  // Second try: follow all redirects and use the final URL
  try {
    const res = await fetch(url, {
      method:   'GET',
      redirect: 'follow',
      headers,
      signal:   AbortSignal.timeout(8000),
    });
    if (res.url && extractTikTokVideoId(res.url)) return res.url;
  } catch {}

  return url; // give up — caller will emit a warning
}

// Strip query params from a TikTok URL, keeping only the canonical path.
// e.g. https://www.tiktok.com/@user/video/123?is_from_webapp=1 → https://www.tiktok.com/@user/video/123
function canonicalizeTikTokUrl(url) {
  if (!url) return url;
  try {
    const p = new URL(url);
    return `https://www.tiktok.com${p.pathname}`;
  } catch {
    return url;
  }
}

async function fetchTikTokStatsApify(deliverables, apiToken) {
  const urls = deliverables.map(d => canonicalizeTikTokUrl(d.postLink));

  const input = {
    postURLs:                      urls,
    shouldDownloadVideos:          false,
    shouldDownloadCovers:          false,
    shouldDownloadSubtitles:       false,
    shouldDownloadSlideshowImages: false,
  };

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

  const youtubeKey = process.env.YOUTUBE_API_KEY;
  const apifyToken = process.env.APIFY_API_TOKEN;

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

    // ── Instagram (via Apify) ──────────────────────────────────────────────────
    if (byPlatform.instagram.length > 0) {
      if (!apifyToken) {
        warnings.push('Instagram: APIFY_API_TOKEN not configured — skipped.');
      } else {
        try {
          // Chunk into groups of 10 to avoid Apify timeouts
          const CHUNK = 10;
          const chunks = [];
          for (let i = 0; i < byPlatform.instagram.length; i += CHUNK) {
            chunks.push(byPlatform.instagram.slice(i, i + CHUNK));
          }
          const chunkMaps = await Promise.all(chunks.map(c => fetchInstagramStatsApify(c, apifyToken)));
          const byShortCode = Object.assign({}, ...chunkMaps);

          console.log('[stats] Instagram — sent:', byPlatform.instagram.length, '| Apify returned:', Object.keys(byShortCode).length);
          await Promise.all(byPlatform.instagram.map(async (d) => {
            const shortcode = extractInstagramShortcode(d.postLink);
            if (!shortcode) { warnings.push(`Instagram: could not parse shortcode from ${d.postLink}`); return; }
            const stats = byShortCode[shortcode];
            if (!stats) {
              warnings.push(`Instagram: could not fetch stats for ${shortcode} — post may be private or removed`);
              results.push({ id: d.id, platform: 'instagram', status: 'not_found' });
              return;
            }
            await patchDeliverable(d.id, buildFields(stats), airtableToken);
            results.push({ id: d.id, platform: 'instagram', status: 'updated', ...stats });
          }));
        } catch (err) {
          warnings.push(`Instagram (Apify): ${err.message}`);
          byPlatform.instagram.forEach(d => results.push({ id: d.id, platform: 'instagram', status: 'error' }));
        }
      }
    }

    // ── TikTok (via Apify) ─────────────────────────────────────────────────────
    if (byPlatform.tiktok.length > 0) {
      if (!apifyToken) {
        warnings.push('TikTok: APIFY_API_TOKEN not configured — skipped. Add your Apify token to Vercel env vars.');
      } else {
        try {
          // Split: long URLs can be batched; short URLs are sent one at a time so
          // we can match the single result back to the right deliverable without
          // needing to resolve the redirect server-side (Apify's browser handles it).
          const longUrls  = byPlatform.tiktok.filter(d => !isShortTikTokUrl(d.postLink));
          const shortUrls = byPlatform.tiktok.filter(d =>  isShortTikTokUrl(d.postLink));

          // Batch the long URLs in chunks of 10 to avoid Apify timeouts on large runs.
          // Chunks run in parallel so total time stays reasonable.
          if (longUrls.length > 0) {
            const CHUNK = 10;
            const chunks = [];
            for (let i = 0; i < longUrls.length; i += CHUNK) chunks.push(longUrls.slice(i, i + CHUNK));

            const chunkMaps = await Promise.all(chunks.map(c => fetchTikTokStatsApify(c, apifyToken)));
            const byVideoId = Object.assign({}, ...chunkMaps);

            console.log('[stats] TikTok long URLs — sent:', longUrls.length, '| Apify returned:', Object.keys(byVideoId).length);
            await Promise.all(longUrls.map(async (d) => {
              const videoId = extractTikTokVideoId(d.postLink);
              if (!videoId) { warnings.push(`TikTok: could not parse video ID from ${d.postLink}`); return; }
              const stats = byVideoId[videoId];
              if (!stats) {
                warnings.push(`TikTok: could not fetch stats for video ${videoId} — video likely has audience controls (18+/friends only) and requires manual entry (${d.postLink})`);
                results.push({ id: d.id, platform: 'tiktok', status: 'not_found' });
                return;
              }
              await patchDeliverable(d.id, buildFields(stats), airtableToken);
              results.push({ id: d.id, platform: 'tiktok', status: 'updated', ...stats });
            }));
          }

          // Send each short URL individually — 1 in, 1 out, no matching problem
          await Promise.all(shortUrls.map(async (d) => {
            try {
              const byVideoId = await fetchTikTokStatsApify([d], apifyToken);
              const ids = Object.keys(byVideoId);
              console.log('[stats] TikTok short URL —', d.postLink, '| Apify returned:', ids.length, 'items');
              if (ids.length === 0) {
                warnings.push(`TikTok: could not fetch stats for short URL — video likely has audience controls and requires manual entry (${d.postLink})`);
                results.push({ id: d.id, platform: 'tiktok', status: 'not_found' });
                return;
              }
              const stats = byVideoId[ids[0]];
              await patchDeliverable(d.id, buildFields(stats), airtableToken);
              results.push({ id: d.id, platform: 'tiktok', status: 'updated', ...stats });
            } catch (err) {
              warnings.push(`TikTok (${d.postLink}): ${err.message}`);
              results.push({ id: d.id, platform: 'tiktok', status: 'error' });
            }
          }));
        } catch (err) {
          warnings.push(`TikTok (Apify): ${err.message}`);
          byPlatform.tiktok.forEach(d => results.push({ id: d.id, platform: 'tiktok', status: 'error' }));
        }
      }
    }

    const updated = results.filter(r => r.status === 'updated').length;
    const byPlat = ['youtube', 'instagram', 'tiktok'].map(p => {
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
