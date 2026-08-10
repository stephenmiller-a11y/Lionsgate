// api/deliverable-update.js
// PATCHes writeable fields on a Deliverable record in Airtable.
// Used by the Concepts and Drafts tabs for approve and request-changes actions.
//
// Expects JSON body: { delivId: "recXXXXXX", fields: { scriptApproval: true, conceptNotes: "..." } }

const BASE_ID     = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const DELIV_TABLE = 'tblNOrIcXwZ0R78LJ';

// Map friendly field names → Airtable field IDs
const WRITABLE = {
  scriptApproval: 'fldVukxDJTU0q3zrZ', // checkbox
  cutApproval:    'fldMlhJRn66OhYPIB', // checkbox
  conceptNotes:   'fldsMs0SjgU1UU8KI', // richText
  draftV1Notes:   'fldq0TUAznUzNHZIq', // richText
  draftV2Notes:   'fldlp5I9siz7M2tR2', // richText
  draftV3Notes:   'fld2ANvIsNG7G9c1g', // richText
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) return res.status(500).json({ error: 'AIRTABLE_TOKEN is not configured.' });

  const { delivId, fields } = req.body || {};
  if (!delivId || !fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'Missing delivId or fields' });
  }

  // Translate friendly names → Airtable field IDs
  const atFields = {};
  for (const [key, val] of Object.entries(fields)) {
    if (WRITABLE[key] !== undefined) atFields[WRITABLE[key]] = val;
  }
  if (Object.keys(atFields).length === 0) {
    return res.status(400).json({ error: 'No recognised writable fields provided' });
  }

  try {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${DELIV_TABLE}/${delivId}`;
    const atRes = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: atFields }),
    });
    if (!atRes.ok) {
      const body = await atRes.text();
      throw new Error(`Airtable [${atRes.status}]: ${body}`);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/deliverable-update]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
