// api/stats.js
// Vercel serverless function — fetches live video stats from YouTube Data API v3
// and writes them back to Airtable deliverables records.
//
// Required environment variables:
//   AIRTABLE_TOKEN   — Airtable Personal Access Token
//   YOUTUBE_API_KEY  — YouTube Data API v3 key (from Google Cloud Console)
//
// Only YouTube post links are supported for automatic fetching.
// Instagram, TikTok, and Snapchat require per-creator OAuth — enter those manually.

const BASE_ID            = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const AT_BASE            = `https://api.airtable.com/v0/${BASE_ID}`;
const DELIVERABLES_TABLE = 'tblNOrIcXwZ0R78LJ';

// Deliverable field IDs (returnFieldsByFieldId=true)
const F_VIEWS       = 'fldliR0ZyX2OzMkvs';
const F_LIKES       = 'fld3BhTWQ1IdTe6um';
const F_COMMENTS    = 'fldTm8YrIhRvRCQUr';
const F_SOCIAL_POST = 'fldHkJxRyOoTrXvHc'; // Social Post (dateTime)

// ── Helpers ───────────────────────────────────────────────────────────────────

function isYouTubeUrl(url) {
  return typeof url === 'string' && (url.includes('youtube.com') || url.includes('youtu.be'));
}

function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,           // youtube.com/watch?v=ID
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,       // youtu.be/ID
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/, // youtube.com/shorts/ID
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,  // youtube.com/embed/ID
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

// Batch-fetch stats for up to 50 video IDs in one API call
async function fetchYouTubeStats(videoIds, apiKey) {
  if (!videoIds.length) return {};
  // YouTube API accepts up to 50 IDs per request
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));

  const result = {};
  for (const chunk of chunks) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${chunk.join(',')}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`YouTube API [${res.status}]: ${body}`);
    }
    const data = await res.json();
    for (const item of (data.items || [])) {
      const s = item.statistics || {};
      const sn = item.snippet    || {};
      result[item.id] = {
        views:       s.viewCount    != null ? parseInt(s.viewCount,    10) : null,
        likes:       s.likeCount    != null ? parseInt(s.likeCount,    10) : null,
        comments:    s.commentCount != null ? parseInt(s.commentCount, 10) : null,
        publishedAt: sn.publishedAt || null, // ISO 8601 e.g. "2024-03-15T18:00:00Z"
      };
    }
  }
  return result;
}

async function patchDeliverable(recordId, fields, token) {
  const url = `${AT_BASE}/${DELIVERABLES_TABLE}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable PATCH [${res.status}] ${recordId}: ${body}`);
  }
  return res.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const airtableToken = process.env.AIRTABLE_TOKEN;
  const youtubeKey    = process.env.YOUTUBE_API_KEY;

  if (!airtableToken) {
    return res.status(500).json({ error: 'AIRTABLE_TOKEN not configured.' });
  }
  if (!youtubeKey) {
    return res.status(500).json({
      error: 'YOUTUBE_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.',
    });
  }

  // Body: { deliverables: [{ id, postLink, type }] }
  const { deliverables } = req.body || {};
  if (!Array.isArray(deliverables) || deliverables.length === 0) {
    return res.status(400).json({ error: 'Missing deliverables array in request body.' });
  }

  try {
    // 1. Separate deliverables with YouTube links from the rest
    const ytDeliverables    = deliverables.filter(d => d.postLink && isYouTubeUrl(d.postLink));
    const nonYtDeliverables = deliverables.filter(d => !d.postLink || !isYouTubeUrl(d.postLink));

    if (ytDeliverables.length === 0) {
      return res.status(200).json({
        updated:  0,
        skipped:  nonYtDeliverables.length,
        noLink:   deliverables.filter(d => !d.postLink).length,
        message:  'No YouTube post links found. Paste YouTube URLs into the Post Link field for each deliverable to enable auto-updating.',
        results:  [],
      });
    }

    // 2. Extract video IDs — map videoId → deliverable record
    const videoIdToDeliverable = {};
    const noIdDeliverables = [];
    for (const d of ytDeliverables) {
      const vid = extractYouTubeId(d.postLink);
      if (vid) videoIdToDeliverable[vid] = d;
      else noIdDeliverables.push(d);
    }

    const videoIds = Object.keys(videoIdToDeliverable);
    if (videoIds.length === 0) {
      return res.status(200).json({
        updated: 0,
        skipped: deliverables.length,
        message: 'Could not extract video IDs from the YouTube links. Make sure they are standard watch/shorts/youtu.be URLs.',
        results: [],
      });
    }

    // 3. Fetch live stats from YouTube Data API v3
    const statsMap = await fetchYouTubeStats(videoIds, youtubeKey);

    // 4. PATCH Airtable records in parallel
    const results = [];
    await Promise.all(
      videoIds.map(async (vid) => {
        const stats      = statsMap[vid];
        const deliverable = videoIdToDeliverable[vid];
        if (!stats) {
          results.push({ id: deliverable.id, status: 'not_found', videoId: vid });
          return;
        }
        const fields = {};
        if (stats.views       != null) fields[F_VIEWS]       = stats.views;
        if (stats.likes       != null) fields[F_LIKES]       = stats.likes;
        if (stats.comments    != null) fields[F_COMMENTS]    = stats.comments;
        if (stats.publishedAt != null) fields[F_SOCIAL_POST] = stats.publishedAt;

        if (Object.keys(fields).length > 0) {
          await patchDeliverable(deliverable.id, fields, airtableToken);
        }
        results.push({
          id:       deliverable.id,
          status:   'updated',
          videoId:  vid,
          views:    stats.views,
          likes:    stats.likes,
          comments: stats.comments,
        });
      })
    );

    const updated  = results.filter(r => r.status === 'updated').length;
    const notFound = results.filter(r => r.status === 'not_found').length;
    const skipped  = nonYtDeliverables.length + noIdDeliverables.length + notFound;

    return res.status(200).json({
      updated,
      skipped,
      message: `Updated ${updated} deliverable${updated !== 1 ? 's' : ''} with live YouTube stats.${skipped > 0 ? ` ${skipped} skipped (non-YouTube or no link).` : ''}`,
      results,
    });

  } catch (err) {
    console.error('[api/stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
