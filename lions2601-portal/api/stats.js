// api/stats.js
// Vercel serverless function — fetches live post stats from YouTube, Instagram,
// and TikTok and writes them back to Airtable deliverables records.
//
// Required env vars:
//   AIRTABLE_TOKEN        — Airtable Personal Access Token
//
// Per-platform env vars (only needed for the platforms you use):
//   YOUTUBE_API_KEY       — YouTube Data API v3 key (Google Cloud Console)
//   APIFY_API_TOKEN       — Apify API token (apify.com) — used for Instagram + TikTok scraping
//   INSTAGRAM_COOKIES     — JSON array of instagram.com cookies from a logged-in browser session.
//                           Export with the "Cookie-Editor" browser extension → Export → JSON.
//                           Required to scrape age-restricted Reels. Optional otherwise.

const BASE_ID            = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const AT_BASE            = `https://api.airtable.com/v0/${BASE_ID}`;
const DELIVERABLES_TABLE = 'tblNOrIcXwZ0R78LJ';
const F_STAT_ERRORS      = 'fldfpjcNq41Jmxgb7'; // Stat Errors (on Deliverable record)

// Deliverable field IDs
const F_VIEWS         = 'fldliR0ZyX2OzMkvs';
const F_LIKES         = 'fld3BhTWQ1IdTe6um';
const F_COMMENTS      = 'fldTm8YrIhRvRCQUr';
const F_SHARES        = 'fldqqQzTtUl6k5crI';
const F_SAVES         = 'fldbxbzPhXG4LKjVV';
const F_SOCIAL_POST   = 'fldHkJxRyOoTrXvHc';
const F_THUMBNAIL     = 'flds3ZtOYpN6eTur5';
const F_STATS_UPDATED = 'fldHFyucfmau6iFLc'; // Stats Updated (dateTime)

// ── Platform detection ────────────────────────────────────────────────────────

function detectPlatform(url) {
  if (!url) return null;
  if (/youtube\.com|youtu\.be/.test(url))  return 'youtube';
  if (/instagram\.com/.test(url))          return 'instagram';
  if (/tiktok\.com/.test(url))             return 'tiktok';
  if (/snapchat\.com/.test(url))           return 'snapchat';
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

// ── Instagram (via Apify patient_discovery/instagram-reel-analytics-by-url) ──
// No login required. Returns all six engagement metrics (views, likes, comments,
// shares, saves, reposts) for any public post or Reel URL.
// Matches results back to deliverables via the post shortcode (item.code).

function extractInstagramShortcode(url) {
  if (!url) return null;
  // Handles /p/, /reel/, /reels/ (plural), /tv/
  const m = url.match(/instagram\.com\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Strip query params and normalise reels→reel so Apify's URL validator accepts it.
// e.g. https://www.instagram.com/reels/ABC/?utm_source=... → https://www.instagram.com/reel/ABC/
function canonicalizeInstagramUrl(url) {
  if (!url) return null;
  const shortcode = extractInstagramShortcode(url);
  if (!shortcode) return null;
  const isReel = /\/(?:reels?|tv)\//.test(url);
  return `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${shortcode}/`;
}

async function fetchInstagramStatsApify(deliverables, apiToken) {
  // Canonicalize (strip query params, normalise reels→reel) and deduplicate.
  const seen = new Set();
  const uniqueUrls = [];
  for (const d of deliverables) {
    const canonical = canonicalizeInstagramUrl(d.postLink);
    if (canonical && !seen.has(canonical)) { seen.add(canonical); uniqueUrls.push(canonical); }
  }
  if (uniqueUrls.length === 0) return {};

  const res = await fetch(
    `https://api.apify.com/v2/acts/patient_discovery~instagram-reel-analytics-by-url/run-sync-get-dataset-items?token=${apiToken}&timeout=180&memoryMbytes=2048`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postUrls: uniqueUrls }),
    }
  );

  if (!res.ok) {
    const b = await res.text();
    throw new Error(`Apify Instagram scraper [${res.status}]: ${b}`);
  }

  const items = await res.json();

  // Build a map: shortCode → stats
  // Output schema: item.code, item.metrics.{play_count, like_count, comment_count, share_count}, item.taken_at_date
  const byShortCode = {};
  for (const item of (Array.isArray(items) ? items : [])) {
    const code = item.code;
    if (!code) continue;
    const m = item.metrics || {};
    byShortCode[code] = {
      views:       m.play_count     ?? m.ig_play_count ?? null,
      likes:       m.like_count     ?? null,
      comments:    m.comment_count  ?? null,
      shares:      m.share_count    ?? null,
      saves:       m.saved_count    ?? m.saves_count ?? m.save_count ?? null,
      publishedAt: item.taken_at_date || null,
      coverUrl:    item.thumbnail_url || item.display_url || item.image_url
                   || item.image_versions?.[0]?.url || null,
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

  // Run the Apify TikTok scraper synchronously — waits up to 180s for results
  const res = await fetch(
    `https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?token=${apiToken}&timeout=180&memoryMbytes=2048`,
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
      views:       item.playCount     ?? item.stats?.playCount     ?? null,
      likes:       item.diggCount     ?? item.stats?.diggCount     ?? null,
      comments:    item.commentCount  ?? item.stats?.commentCount  ?? null,
      shares:      item.shareCount    ?? item.stats?.shareCount    ?? null,
      saves:       item.collectCount  ?? item.stats?.collectCount  ?? null,
      publishedAt: item.createTimeISO
        || (item.createTime ? new Date(item.createTime * 1000).toISOString() : null),
      coverUrl:    item.coverUrl || item.covers?.[0] || item.video?.cover || null,
    };
  }
  return byVideoId;
}

// ── Snapchat (via Apify tri_angle/snapchat-spotlight-scraper) ─────────────────
// Only works for Spotlight URLs (snapchat.com/spotlight/...).
// Stories are private/ephemeral — no public stats available.
// Output has viewCount and shareCount; no likes or comments.

function isSnapchatSpotlight(url) {
  // Matches both snapchat.com/spotlight/TOKEN and snapchat.com/@user/spotlight/TOKEN
  return /snapchat\.com.*\/spotlight\//.test(url || '');
}

function extractSpotlightToken(url) {
  if (!url) return null;
  const m = url.match(/\/spotlight\/([^/?#]+)/);
  return m ? m[1] : null;
}

function isSnapchatShortUrl(url) {
  return /snapchat\.com\/t\//.test(url || '');
}

// Resolve a short Snapchat URL (snapchat.com/t/XXXX) to a canonical spotlight URL.
// Returns https://www.snapchat.com/spotlight/TOKEN on success, null on failure.
async function resolveSnapchatShortUrl(url) {
  try {
    const res = await fetch(url, {
      method:   'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
      signal:   AbortSignal.timeout(8000),
    });
    const token = extractSpotlightToken(res.url || '');
    if (token) return `https://www.snapchat.com/spotlight/${token}`;
  } catch {}
  return null;
}

function canonicalizeSnapchatUrl(url) {
  if (!url) return url;
  try {
    const p = new URL(url);
    return `https://www.snapchat.com${p.pathname}`;
  } catch { return url; }
}


async function fetchSnapchatStatsApify(deliverables, apiToken) {
  const urls = deliverables.map(d => canonicalizeSnapchatUrl(d.postLink));

  const res = await fetch(
    `https://api.apify.com/v2/acts/tri_angle~snapchat-spotlight-scraper/run-sync-get-dataset-items?token=${apiToken}&timeout=180&memoryMbytes=2048`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotlightUrls: urls }),
    }
  );

  if (!res.ok) {
    const b = await res.text();
    throw new Error(`Apify Snapchat scraper [${res.status}]: ${b}`);
  }

  const items = await res.json();

  // Build map: spotlight token → stats
  // Apify strips @username from the output URL, so match by token not full URL
  const byToken = {};
  for (const item of (Array.isArray(items) ? items : [])) {
    const token = extractSpotlightToken(item.url || '');
    if (token) byToken[token] = {
      views:       item.viewCount  ?? null,
      shares:      item.shareCount ?? null,
      publishedAt: item.dateUploaded || null,
      coverUrl:    item.thumbnailUrl || null,
    };
  }
  return byToken;
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

// thumbnailUrl: only passed when the deliverable doesn't already have one (one-time).
function buildFields(stats, thumbnailUrl) {
  const fields = {};
  if (stats.views    != null && stats.views    > 0) fields[F_VIEWS]    = stats.views;
  if (stats.likes    != null && stats.likes    > 0) fields[F_LIKES]    = stats.likes;
  if (stats.comments != null && stats.comments > 0) fields[F_COMMENTS] = stats.comments;
  if (stats.shares   != null && stats.shares   > 0) fields[F_SHARES]   = stats.shares;
  if (stats.saves    != null && stats.saves    > 0) fields[F_SAVES]    = stats.saves;
  if (stats.publishedAt != null) fields[F_SOCIAL_POST] = stats.publishedAt;
  if (thumbnailUrl)               fields[F_THUMBNAIL]   = [{ url: thumbnailUrl }];
  // Only stamp the update time if at least one engagement count was actually written
  const hasEngagement = F_VIEWS in fields || F_LIKES in fields || F_COMMENTS in fields || F_SHARES in fields || F_SAVES in fields;
  if (hasEngagement && F_STATS_UPDATED) fields[F_STATS_UPDATED] = new Date().toISOString();
  fields[F_STAT_ERRORS] = ''; // clear any previous error
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

  const youtubeKey       = process.env.YOUTUBE_API_KEY;
  const apifyToken       = process.env.APIFY_API_TOKEN;
  const instagramCookies = (() => {
    const raw = (process.env.INSTAGRAM_COOKIES || '').trim();
    if (!raw) return null;
    // Accept either a JSON array (from Cookie-Editor) or a raw document.cookie string
    // (semicolon-separated name=value pairs copied from the browser console).
    if (raw.startsWith('[')) {
      try { return JSON.parse(raw); } catch { return null; }
    }
    // Parse "name=value; name2=value2" into Apify's expected format
    return raw.split(';').map(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: '.instagram.com', path: '/' };
    }).filter(Boolean);
  })();

  const { deliverables } = req.body || {};
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    return res.status(400).json({ error: 'Missing deliverables array in request body.' });
  }

  // Group by platform
  const byPlatform = { youtube: [], instagram: [], tiktok: [], snapchat: [], unknown: [] };
  for (const d of deliverables) {
    if (!d.postLink) { byPlatform.unknown.push(d); continue; }
    const platform = detectPlatform(d.postLink);
    (byPlatform[platform] || byPlatform.unknown).push(d);
  }

  const results    = [];
  const warnings   = [];
  const delivErrors = {}; // delivId → error message, for writing to F_STAT_ERRORS

  // Helper: record a warning and associate it with a specific deliverable
  function warnDeliv(d, msg) {
    warnings.push(msg);
    delivErrors[d.id] = msg;
  }

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
          else warnDeliv(d, `YouTube: could not parse video ID from ${d.postLink}`);
        }
        const statsMap = await fetchYouTubeStats(Object.keys(idMap), youtubeKey);
        await Promise.all(Object.entries(idMap).map(async ([vid, d]) => {
          const stats = statsMap[vid];
          if (!stats) {
            warnDeliv(d, `YouTube: no data returned for video ${vid} — video may be private or removed`);
            results.push({ id: d.id, platform: 'youtube', status: 'not_found' });
            return;
          }
          await patchDeliverable(d.id, buildFields(stats, null), airtableToken);
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
          // Sequential chunks — one Apify response in memory at a time.
          // Patch Airtable immediately per chunk before fetching the next.
          const CHUNK = 25;
          for (let i = 0; i < byPlatform.instagram.length; i += CHUNK) {
            const chunk = byPlatform.instagram.slice(i, i + CHUNK);
            const byShortCode = await fetchInstagramStatsApify(chunk, apifyToken);
            console.log(`[stats] Instagram chunk ${Math.floor(i/CHUNK)+1} — returned: ${Object.keys(byShortCode).length}`);
            for (const d of chunk) {
              const shortcode = extractInstagramShortcode(d.postLink);
              if (!shortcode) { warnDeliv(d, `Instagram: could not parse shortcode from ${d.postLink}`); continue; }
              const stats = byShortCode[shortcode];
              if (!stats) {
                warnDeliv(d, `Instagram: no data returned for ${shortcode} — post may be age-restricted, private, or removed. Requires manual entry.`);
                results.push({ id: d.id, platform: 'instagram', status: 'not_found' });
                continue;
              }
              const igThumb = d.hasThumbnail ? null : (stats.coverUrl || null);
              await patchDeliverable(d.id, buildFields(stats, igThumb), airtableToken);
              results.push({ id: d.id, platform: 'instagram', status: 'updated', ...stats });
            }
          }
        } catch (err) {
          const msg = `Instagram (Apify): ${err.message}`;
          warnings.push(msg);
          byPlatform.instagram.forEach(d => { delivErrors[d.id] = msg; results.push({ id: d.id, platform: 'instagram', status: 'error' }); });
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

          // Sequential chunks — one Apify response in memory at a time.
          // Patch Airtable immediately per chunk before fetching the next.
          if (longUrls.length > 0) {
            const CHUNK = 25;
            for (let i = 0; i < longUrls.length; i += CHUNK) {
              const chunk = longUrls.slice(i, i + CHUNK);
              const byVideoId = await fetchTikTokStatsApify(chunk, apifyToken);
              console.log(`[stats] TikTok chunk ${Math.floor(i/CHUNK)+1} — returned: ${Object.keys(byVideoId).length}`);
              for (const d of chunk) {
                const videoId = extractTikTokVideoId(d.postLink);
                if (!videoId) { warnDeliv(d, `TikTok: could not parse video ID from ${d.postLink}`); continue; }
                const stats = byVideoId[videoId];
                if (!stats) {
                  warnDeliv(d, `TikTok: video likely has audience controls (18+/friends only) and requires manual entry`);
                  results.push({ id: d.id, platform: 'tiktok', status: 'not_found' });
                  continue;
                }
                const ttThumb = d.hasThumbnail ? null : (stats.coverUrl || null);
                await patchDeliverable(d.id, buildFields(stats, ttThumb), airtableToken);
                results.push({ id: d.id, platform: 'tiktok', status: 'updated', ...stats });
              }
            }
          }

          // Short URLs — sequential, one Apify call each (1 in, 1 out, no matching problem)
          for (const d of shortUrls) {
            try {
              const byVideoId = await fetchTikTokStatsApify([d], apifyToken);
              const ids = Object.keys(byVideoId);
              console.log('[stats] TikTok short URL —', d.postLink, '| Apify returned:', ids.length, 'items');
              if (ids.length === 0) {
                warnDeliv(d, `TikTok: video likely has audience controls and requires manual entry`);
                results.push({ id: d.id, platform: 'tiktok', status: 'not_found' });
                continue;
              }
              const stats = byVideoId[ids[0]];
              const ttShortThumb = d.hasThumbnail ? null : (stats.coverUrl || null);
              await patchDeliverable(d.id, buildFields(stats, ttShortThumb), airtableToken);
              results.push({ id: d.id, platform: 'tiktok', status: 'updated', ...stats });
            } catch (err) {
              warnDeliv(d, `TikTok: ${err.message}`);
              results.push({ id: d.id, platform: 'tiktok', status: 'error' });
            }
          }
        } catch (err) {
          const msg = `TikTok (Apify): ${err.message}`;
          warnings.push(msg);
          byPlatform.tiktok.forEach(d => { delivErrors[d.id] = msg; results.push({ id: d.id, platform: 'tiktok', status: 'error' }); });
        }
      }
    }

    // ── Snapchat (via Apify) ────────────────────────────────────────────────────
    if (byPlatform.snapchat.length > 0) {
      if (!apifyToken) {
        warnings.push('Snapchat: APIFY_API_TOKEN not configured — skipped.');
      } else {
        try {
          // Resolve short URLs (snapchat.com/t/XXXX) before filtering
          const allSnap = byPlatform.snapchat;
          const shortUrlDelivs  = allSnap.filter(d =>  isSnapchatShortUrl(d.postLink));
          const longUrlDelivs   = allSnap.filter(d => !isSnapchatShortUrl(d.postLink));

          // Resolve short URLs (snapchat.com/t/XXXX) to canonical spotlight URLs
          const resolvedShort = await Promise.all(shortUrlDelivs.map(async d => {
            const resolved = await resolveSnapchatShortUrl(d.postLink);
            if (!resolved) {
              warnDeliv(d, `Snapchat: could not resolve short URL — please replace with full Spotlight URL`);
              results.push({ id: d.id, platform: 'snapchat', status: 'not_supported' });
              return null;
            }
            return { ...d, postLink: resolved };
          }));

          const spotlights = [
            ...longUrlDelivs.filter(d => isSnapchatSpotlight(d.postLink)),
            ...resolvedShort.filter(Boolean),
          ];
          const nonSpotlights = longUrlDelivs.filter(d => !isSnapchatSpotlight(d.postLink));
          for (const d of nonSpotlights) {
            warnDeliv(d, `Snapchat: only Spotlight video URLs are supported (not profile or feed links) — manual entry required`);
            results.push({ id: d.id, platform: 'snapchat', status: 'not_supported' });
          }
          if (spotlights.length > 0) {
            const CHUNK = 25;
            for (let i = 0; i < spotlights.length; i += CHUNK) {
              const chunk  = spotlights.slice(i, i + CHUNK);
              const byToken = await fetchSnapchatStatsApify(chunk, apifyToken);
              console.log(`[stats] Snapchat chunk ${Math.floor(i/CHUNK)+1} — returned: ${Object.keys(byToken).length}`);
              for (const d of chunk) {
                const token = extractSpotlightToken(d.postLink);
                const stats = token ? byToken[token] : null;
                if (!stats) {
                  warnDeliv(d, `Snapchat: no data returned — video may be unavailable`);
                  results.push({ id: d.id, platform: 'snapchat', status: 'not_found' });
                  continue;
                }
                const scThumb = d.hasThumbnail ? null : (stats.coverUrl || null);
                await patchDeliverable(d.id, buildFields(stats, scThumb), airtableToken);
                results.push({ id: d.id, platform: 'snapchat', status: 'updated', ...stats });
              }
            }
          }
        } catch (err) {
          const msg = `Snapchat (Apify): ${err.message}`;
          warnings.push(msg);
          byPlatform.snapchat.forEach(d => { delivErrors[d.id] = msg; results.push({ id: d.id, platform: 'snapchat', status: 'error' }); });
        }
      }
    }

    // Write per-deliverable error messages (or clear on success via buildFields)
    const errorIds = Object.keys(delivErrors);
    if (errorIds.length > 0) {
      await Promise.all(errorIds.map(id =>
        patchDeliverable(id, { [F_STAT_ERRORS]: delivErrors[id] }, airtableToken).catch(() => {})
      ));
    }

    const updated = results.filter(r => r.status === 'updated').length;
    const byPlat = ['youtube', 'instagram', 'tiktok', 'snapchat'].map(p => {
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
