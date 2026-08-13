// api/fetch-thumbnails.js
// Fetches TikTok video thumbnails via TikTok's public oEmbed API (no API key required)
// and stores them as attachments in Airtable field flds3ZtOYpN6eTur5 (Post Thumbnail).
// Airtable downloads and stores the image itself — no expiry concerns.
//
// POST body: { deliverables: [{ delivId: "recXXX", postLink: "https://tiktok.com/..." }] }
//
// Required env var: AIRTABLE_TOKEN
// Optional:         AIRTABLE_BASE_ID

const BASE_ID     = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const DELIV_TABLE = 'tblNOrIcXwZ0R78LJ';
const THUMB_FIELD = 'flds3ZtOYpN6eTur5'; // Post Thumbnail (multipleAttachments)

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

  // Only process TikTok posts
  const tiktokPosts = deliverables.filter(d => {
    const link = (d.postLink || '').toLowerCase();
    return link.includes('tiktok.com') || link.includes('vm.tiktok');
  });

  if (!tiktokPosts.length) {
    return res.status(200).json({ ok: true, updated: 0, message: 'No TikTok post links found' });
  }

  // Fetch each thumbnail from TikTok oEmbed, then write to Airtable — all in parallel
  const results = [];
  const errors  = [];

  await Promise.all(tiktokPosts.map(async d => {
    try {
      // Resolve any shortened URLs (vm.tiktok.com) by following the redirect first
      let url = d.postLink;
      if (url.toLowerCase().includes('vm.tiktok')) {
        try {
          const redir = await fetch(url, { method: 'HEAD', redirect: 'follow' });
          url = redir.url || url;
        } catch (_) { /* fall through with original URL */ }
      }

      const oembedRes = await fetch(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' } }
      );

      if (!oembedRes.ok) {
        const body = await oembedRes.text();
        errors.push({ delivId: d.delivId, error: `oEmbed ${oembedRes.status}: ${body.slice(0, 120)}` });
        console.error('[fetch-thumbnails] oEmbed error', oembedRes.status, url, body.slice(0, 200));
        return;
      }

      const oembed = await oembedRes.json();
      const thumb  = oembed.thumbnail_url;

      if (!thumb) {
        errors.push({ delivId: d.delivId, error: 'No thumbnail_url in oEmbed response' });
        console.error('[fetch-thumbnails] no thumbnail_url', url, JSON.stringify(oembed).slice(0, 200));
        return;
      }

      // Write URL back to Airtable
      const atRes = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${DELIV_TABLE}/${d.delivId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${atToken}`,
            'Content-Type': 'application/json',
          },
          // Attachment fields take an array of { url } objects —
          // Airtable fetches and stores the image itself.
          body: JSON.stringify({ fields: { [THUMB_FIELD]: [{ url: thumb, filename: `thumb_${d.delivId}.jpg` }] } }),
        }
      );

      if (atRes.ok) {
        results.push({ delivId: d.delivId, thumb });
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
