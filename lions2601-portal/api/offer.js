// api/offer.js
// Saves Brand Approval and/or Brand Ranking for an Offer record to Airtable.
//
// Expects JSON body:
//   { offerId: "recXXXXXX", approval: "Approved" | "Rejected" | null }
//   { offerId: "recXXXXXX", ranking: 1 }
//   (or both fields at once)

const BASE_ID      = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const OFFERS_TABLE = 'tblmH1uMjxYG1y8X6';

const APPROVAL_FIELD = 'fldoZlmO1OIJc6fI7'; // Brand Approval (singleSelect: "Approved" | "Rejected")
const RANKING_FIELD  = 'fldWceYkW6KgT58KI'; // Brand Ranking (number)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'AIRTABLE_TOKEN is not configured.' });
  }

  const { offerId, approval, ranking } = req.body || {};
  if (!offerId) {
    return res.status(400).json({ error: 'Missing required field: offerId' });
  }
  if (approval === undefined && ranking === undefined) {
    return res.status(400).json({ error: 'Provide at least one of: approval, ranking' });
  }

  try {
    const fields = {};

    if (approval !== undefined) {
      // Airtable singleSelect options: "Approved", "Rejected", "Pending"
      // Pass null to clear the field entirely
      fields[APPROVAL_FIELD] = approval;
    }
    if (ranking !== undefined) {
      fields[RANKING_FIELD] = ranking;
    }

    const url = `https://api.airtable.com/v0/${BASE_ID}/${OFFERS_TABLE}/${offerId}`;
    const atRes = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!atRes.ok) {
      const body = await atRes.text();
      throw new Error(`Airtable [${atRes.status}]: ${body}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/offer]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
