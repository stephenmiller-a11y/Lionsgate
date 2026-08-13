// api/fetch-thumbnails.js
// Fetches TikTok video thumbnails via Apify and writes the URLs back to Airtable.
//
// POST body: { deliverables: [{ delivId: "recXXX", postLink: "https://tiktok.com/..." }] }
//
// Required env vars: APIFY_API_TOKEN, AIRTABLE_TOKEN
// Optional:          AIRTABLE_BASE_ID
//
// NOTE: This calls Apify synchronously (run-sync-get-dataset-items).
// If your Vercel plan has a 10s function timeout (Hobby), add vercel.json:
//   { "functions": { "api/fetch-thumbnails.js": { "maxDuration": 60 } } }

const BASE_ID     = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const DELIV_TABLE = 'tblNOrIcXwZ0R78LJ';
const THUMB_FIELD = 'fld1SsIcnuhPtt8FJ'; // Post Thumbnail URL (text field)
const APIFY_ACTOR = 'clockworks~tiktok-scraper';

// Extract a TikTok video ID from a URL, e.g. ".../video/7234567890123456789"
function tiktokId(url) {
  const m = (url || '').match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apifyToken = process.env.APIFY_API_TOKEN;
  const atToken    = process.env.AIRTABLE_TOKEN;
  if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not configured' });
  if (!atToken)    return res.status(500).json({ error: 'AIRTABLE_TOKEN not configured' });

  const { deliverables } = req.body || {};
  if (!Array.isArray(deliverables) || !deliverables.length) {
    return res.status(400).json({ error: 'deliverables array required' });
  }

  // Only process TikTok posts that have a post link
  const tiktokPosts = deliverables.filter(d => {
    const link = (d.postLink || '').toLowerCase();
    return link.includes('tiktok.com') || link.includes('vm.tiktok');
  });

  if (!tiktokPosts.length) {
    return res.status(200).json({ ok: true, updated: 0, message: 'No TikTok post links found' });
  }

  const startUrls = tiktokPosts.map(d => ({ url: d.postLink }));

  // Run Apify actor synchronously — waits for completion and returns dataset items
  let items;
  try {
    const apifyUrl = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`
      + `?token=${apifyToken}&timeout=55`;
    const apifyRes = await fetch(apifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls,
        maxItems: tiktokPosts.length + 5, // small buffer
        proxyConfiguration: { useApifyProxy: true }, // required — TikTok blocks direct requests
      }),
    });
    if (!apifyRes.ok) {
      const body = await apifyRes.text();
      return res.status(502).json({ error: `Apify error [${apifyRes.status}]: ${body}` });
    }
    items = await apifyRes.json();
  } catch (err) {
    return res.status(502).json({ error: `Apify request failed: ${err.message}` });
  }

  if (!Array.isArray(items) || !items.length) {
    return res.status(200).json({ ok: true, updated: 0, message: 'Apify returned no items' });
  }

  // Build lookups: by exact URL and by video ID
  const thumbByUrl = {};
  const thumbById  = {};
  items.forEach(item => {
    // Try multiple possible thumbnail field paths across actor versions
    const thumb = item.videoMeta?.coverUrl
      || (Array.isArray(item.covers) ? item.covers[0] : null)
      || item.coverUrl
      || item.thumbnail
      || '';
    const webUrl = item.webVideoUrl || item.videoUrl || '';
    if (!thumb) return;
    if (webUrl) thumbByUrl[webUrl] = thumb;
    const id = tiktokId(webUrl);
    if (id) thumbById[id] = thumb;
  });

  // Write thumbnail URLs back to Airtable in parallel
  const results = [];
  await Promise.all(tiktokPosts.map(async d => {
    const id    = tiktokId(d.postLink);
    const thumb = thumbByUrl[d.postLink] || (id ? thumbById[id] : null) || null;
    if (!thumb) return;
    try {
      const atRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${DELIV_TABLE}/${d.delivId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${atToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fields: { [THUMB_FIELD]: thumb } }),
        }
      );
      if (atRes.ok) {
        results.push({ delivId: d.delivId, thumb });
      } else {
        const body = await atRes.text();
        console.error('[fetch-thumbnails] AT write error:', atRes.status, body);
      }
    } catch (err) {
      console.error('[fetch-thumbnails] AT fetch error:', err.message);
    }
  }));

  return res.status(200).json({ ok: true, updated: results.length, results });
};
