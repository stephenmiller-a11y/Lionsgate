// api/fetch-thumbnails.js
// Fetches TikTok and YouTube video thumbnails via their public oEmbed APIs
// (no API key required) and stores them as attachments in Airtable field
// flds3ZtOYpN6eTur5 (Post Thumbnail). Airtable downloads and stores the
// image itself — no expiry concerns.
//
// POST body: { deliverables: [{ delivId: "recXXX", postLink: "https://..." }] }
//
// Required env var: AIRTABLE_TOKEN
// Optional:         AIRTABLE_BASE_ID

const BASE_ID     = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const DELIV_TABLE = 'tblNOrIcXwZ0R78LJ';
const THUMB_FIELD = 'flds3ZtOYpN6eTur5'; // Post Thumbnail (multipleAttachments)

// Detect platform from URL; returns 'tiktok', 'youtube', or null
function detectPlatform(url) {
  const l = url.toLowerCase();
  if (l.includes('tiktok.com') || l.includes('vm.tiktok')) return 'tiktok';
  if (l.includes('youtube.com') || l.includes('youtu.be'))  return 'youtube';
  return null;
}

// Build the oEmbed fetch URL for a given platform
function oembedUrl(platform, videoUrl) {
  if (platform === 'tiktok')  return `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`;
  if (platform === 'youtube') return `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const atToken = process.env.AIRTABLE_TOKEN;
  if (!atToken) return res.status(500).json({ error: 'AIRTABLE_TOKEN not configured' });

  const { deliverables } = req.body || {};
  if (!Array.isArray(deliverables) || !deliverables.length) {
    return res.status(400).json({ error: 'deliverables array required' });
  }

  // Filter to TikTok and YouTube posts
  const eligible = deliverables
    .map(d => ({ ...d, platform: detectPlatform(d.postLink || '') }))
    .filter(d => d.platform !== null);

  if (!eligible.length) {
    return res.status(200).json({ ok: true, updated: 0, message: 'No TikTok or YouTube post links found' });
  }

  const results = [];
  const errors  = [];

  await Promise.all(eligible.map(async d => {
    try {
      let url = d.postLink;

      // Resolve shortened TikTok URLs (vm.tiktok.com) via redirect
      if (d.platform === 'tiktok' && url.toLowerCase().includes('vm.tiktok')) {
        try {
          const redir = await fetch(url, { method: 'HEAD', redirect: 'follow' });
          url = redir.url || url;
        } catch (_) { /* fall through */ }
      }

      const fetchUrl = oembedUrl(d.platform, url);
      const oembedRes = await fetch(fetchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' },
      });

      if (!oembedRes.ok) {
        const body = await oembedRes.text();
        errors.push({ delivId: d.delivId, error: `${d.platform} oEmbed ${oembedRes.status}: ${body.slice(0, 120)}` });
        console.error('[fetch-thumbnails] oEmbed error', d.platform, oembedRes.status, url, body.slice(0, 200));
        return;
      }

      const oembed = await oembedRes.json();
      const thumb  = oembed.thumbnail_url;

      if (!thumb) {
        errors.push({ delivId: d.delivId, error: `No thumbnail_url in ${d.platform} oEmbed response` });
        console.error('[fetch-thumbnails] no thumbnail_url', d.platform, url, JSON.stringify(oembed).slice(0, 200));
        return;
      }

      // Write to Airtable attachment field — Airtable fetches and stores the image
      const atRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${DELIV_TABLE}/${d.delivId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${atToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: { [THUMB_FIELD]: [{ url: thumb, filename: `thumb_${d.delivId}.jpg` }] },
          }),
        }
      );

      if (atRes.ok) {
        results.push({ delivId: d.delivId, thumb, platform: d.platform });
      } else {
        const body = await atRes.text();
        errors.push({ delivId: d.delivId, error: `Airtable ${atRes.status}: ${body.slice(0, 120)}` });
        console.error('[fetch-thumbnails] Airtable write error', atRes.status, body);
      }
    } catch (err) {
      errors.push({ delivId: d.delivId, error: err.message });
      console.error('[fetch-thumbnails] exception for', d.postLink, err.message);
    }
  }));

  return res.status(200).json({
    ok: true,
    updated: results.length,
    results,
    ...(errors.length ? { errors } : {}),
  });
};
