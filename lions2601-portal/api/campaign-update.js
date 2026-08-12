// api/campaign-update.js
// Vercel serverless function — PATCHes editable brief fields on a campaign record.
//
// POST body: { campaignId, field, value }
//   field: "background" | "guidelines" | "cta"

const BASE_ID        = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const CAMPAIGNS_TABLE = 'tblUKz2hOxJmDUWhk';

const FIELD_MAP = {
  background:  'fldPPqqDgpDcmrgvh', // Brief Background  (richText)
  guidelines:  'fldBaDzAw0sUF5nzt', // Brief Creative Guidelines (richText)
  cta:         'fldizWsdOaIYHGf4J', // Brief CTA         (richText)
  kpis:        'fldAqTjKNP91wOR36', // KPIs              (richText)
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return res.status(500).json({ error: 'AIRTABLE_TOKEN not configured.' });

  const { campaignId, field, value } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: 'Missing campaignId.' });
  if (!field || !FIELD_MAP[field]) return res.status(400).json({ error: `Unknown field "${field}". Must be one of: ${Object.keys(FIELD_MAP).join(', ')}.` });

  const fieldId = FIELD_MAP[field];
  const url = `https://api.airtable.com/v0/${BASE_ID}/${CAMPAIGNS_TABLE}/${campaignId}`;

  const atRes = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: { [fieldId]: value || '' } }),
  });

  if (!atRes.ok) {
    const body = await atRes.text();
    return res.status(atRes.status).json({ error: `Airtable error: ${body}` });
  }

  return res.status(200).json({ ok: true });
};
