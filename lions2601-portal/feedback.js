// api/feedback.js
// Saves Brand Feedback text for an Offer record back to Airtable.
// Called by the portal whenever a user edits a feedback box (debounced).
//
// Expects JSON body: { offerId: "recXXXXXX", feedback: "Some text" }

const BASE_ID      = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const OFFERS_TABLE = 'tblmH1uMjxYG1y8X6';
const FEEDBACK_FIELD = 'fld2jDj78o2PYGukg'; // Brand Feedback field ID

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

  const { offerId, feedback } = req.body || {};
  if (!offerId) {
    return res.status(400).json({ error: 'Missing required field: offerId' });
  }
  if (typeof feedback !== 'string') {
    return res.status(400).json({ error: 'Missing required field: feedback (string)' });
  }

  try {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${OFFERS_TABLE}/${offerId}`;
    const atRes = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: { [FEEDBACK_FIELD]: feedback },
      }),
    });

    if (!atRes.ok) {
      const body = await atRes.text();
      throw new Error(`Airtable [${atRes.status}]: ${body}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/feedback]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
