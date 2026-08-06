// api/patch-campaign.js
// PATCH a campaign record's KPIs field in Airtable.
// POST body: { campaignId: "recXXXX", kpis: "..." }

const BASE_ID    = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const CAMPAIGNS  = 'tblUKz2hOxJmDUWhk';
const AT_BASE    = `https://api.airtable.com/v0/${BASE_ID}`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { campaignId, kpis } = req.body || {};
  if (!campaignId) return res.status(400).json({ error: 'campaignId required' });

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return res.status(500).json({ error: 'AIRTABLE_TOKEN not set' });

  const resp = await fetch(`${AT_BASE}/${CAMPAIGNS}/${campaignId}`, {
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: { KPIs: kpis ?? '' } }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    return res.status(resp.status).json({ error: body });
  }

  return res.status(200).json({ ok: true });
};
