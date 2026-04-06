// api/campaign.js
// Vercel serverless function — fetches Lionsgate Michael campaign data from Airtable
// Keeps AIRTABLE_TOKEN server-side; never exposed to the browser.
//
// Required environment variable (set in Vercel dashboard or .env.local):
//   AIRTABLE_TOKEN  — your Airtable Personal Access Token
//
// Optional overrides:
//   AIRTABLE_BASE_ID      — default: appcKC14Om93O40QC
//   CAMPAIGN_RECORD_ID    — default: recrv0pJcLVXBhfPj
 
const BASE_ID     = process.env.AIRTABLE_BASE_ID    || 'appcKC14Om93O40QC';
const CAMPAIGN_ID = process.env.CAMPAIGN_RECORD_ID  || 'recrv0pJcLVXBhfPj';
const AT_BASE     = `https://api.airtable.com/v0/${BASE_ID}`;
 
// ── Table IDs ────────────────────────────────────────────────────────────────
const TABLES = {
  campaigns:    'tblUKz2hOxJmDUWhk',
  deliverables: 'tblNOrIcXwZ0R78LJ',
  offers:       'tblmH1uMjxYG1y8X6',
  timelines:    'tblq7dwxv0yUdzPou',
};
 
// ── Field IDs (Airtable always returns fields keyed by NAME, but IDs control
//    which fields are included in the response) ────────────────────────────────
const CAMPAIGN_FIELDS = [
  'fldlzyQ0W6jrbve1a', // Campaign (formula name)
  'fld5K1hvHduNHOWB3', // Budget
  'fldKK0fGNDjJl1kwg', // Start Date
  'fld5sHcNArzzzeRU9', // End Date
  'fldapLz7u5adkEBwY', // Status
  'fldPPqqDgpDcmrgvh', // Brief Background
  'fldBaDzAw0sUF5nzt', // Brief Creative Guidelines
  'fldizWsdOaIYHGf4J', // Brief CTA
  'fldEN5rkjgf7nZMrZ', // Deliverables (linked)
  'fldLpvnXZssyb0EQ8', // Offers (linked)
  'fldnENF0Iizlzoedr', // 📅 Timelines (linked)
];
 
const DELIVERABLE_FIELDS = [
  'fldrNfr3G8KgviLkR', // Deliverable Code
  'fldjPPOdxTy6Hw8EO', // Talent (linked)
  'fldDjtURDzrqQqT8O', // Type
  'fld9R7BcRAKciybge', // Status
  'fldgonVo2oC1R483t', // Air Date
  'fldoSvBFD45ZdpYHJ', // Post Link
  'fldliR0ZyX2OzMkvs', // Views
  'fld3BhTWQ1IdTe6um', // Likes
  'fldTm8YrIhRvRCQUr', // Comments
  'fldqqQzTtUl6k5crI', // Shares
];
 
const OFFER_FIELDS = [
  'fldB426sihwzSFIjO', // Record ID (formula)
  'fldrjJQqkKpdXFDyM', // Name (from Talent) — lookup
  'fldj9RNXpglllTMBE', // Status
  'fld2jDj78o2PYGukg', // Brand Feedback
  'fldoZlmO1OIJc6fI7', // Brand Approval
  'fldWceYkW6KgT58KI', // Brand Ranking
  'fld0pTahNYhyvIMgK', // Instagram URL — lookup
  'fldT0Ay8sZT2CdFSO', // TikTok URL — lookup
  'fld4PkLU2QwRoJ8Sk', // YouTube URL — lookup
  'fldMnSn105js66oLh', // Snapchat URL — lookup
  'fldFlu16WtdeFsWfX', // Headshot — lookup of attachments
  'fldGwHtpe9pNZmCYI', // Biography — lookup
  'fldWRvRqw9E1leW0g', // US Audience — lookup
  'fldmqzhGoXj8iuuDa', // Offer amount
];
 
// ── Helpers ──────────────────────────────────────────────────────────────────
 
async function atGet(path, fieldIds, token) {
  const url = new URL(`${AT_BASE}/${path}`);
  if (fieldIds && fieldIds.length) {
    fieldIds.forEach(id => url.searchParams.append('fields[]', id));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable [${res.status}] ${path}: ${body}`);
  }
  return res.json();
}
 
async function atGetByIds(tableId, ids, fieldIds, token) {
  if (!ids || ids.length === 0) return { records: [] };
  const formula = ids.length === 1
    ? `RECORD_ID()='${ids[0]}'`
    : `OR(${ids.map(id => `RECORD_ID()='${id}'`).join(',')})`;
  const url = new URL(`${AT_BASE}/${tableId}`);
  url.searchParams.set('filterByFormula', formula);
  fieldIds.forEach(id => url.searchParams.append('fields[]', id));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable [${res.status}] ${tableId}: ${body}`);
  }
  return res.json();
}
 
// Get first value from a multipleLookupValues array
function firstLookup(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
}
 
// Extract headshot URL — Headshot is a lookup of attachment fields
function extractHeadshot(field) {
  if (!field || !Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  if (!first) return null;
  // Direct attachment object
  if (typeof first === 'object' && first.url) return first.url;
  // Nested array of attachment objects (lookup of attachment field)
  if (Array.isArray(first) && first[0] && first[0].url) return first[0].url;
  return null;
}
 
// ── Handler ───────────────────────────────────────────────────────────────────
 
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
 
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'AIRTABLE_TOKEN is not configured. Set it in your Vercel environment variables.',
    });
  }
 
  // Temporary diagnostic — remove after confirming token is correct
  if (req.query.debug === '1') {
    return res.status(200).json({
      tokenPrefix: token.substring(0, 10) + '...',
      tokenLength: token.length,
    });
  }
 
  try {
    // 1. Fetch campaign record
    const campRecord = await atGet(
      `${TABLES.campaigns}/${CAMPAIGN_ID}`,
      CAMPAIGN_FIELDS,
      token
    );
    const cf = campRecord.fields;
 
    // Extract linked record IDs
    const deliverableIds = (cf['Deliverables'] || []).map(r => r.id);
    const offerIds       = (cf['Offers']       || []).map(r => r.id);
    const timelineIds    = (cf['📅 Timelines'] || []).map(r => r.id);
 
    // 2. Fetch related records in parallel
    const [delivsData, offersData, timelinesData] = await Promise.all([
      atGetByIds(TABLES.deliverables, deliverableIds, DELIVERABLE_FIELDS, token),
      atGetByIds(TABLES.offers,       offerIds,       OFFER_FIELDS,       token),
      atGetByIds(TABLES.timelines,    timelineIds,    [],                 token),
    ]);
 
    // 3. Shape campaign
    const campaign = {
      name:            cf['Campaign']                  || 'Snap – Lionsgate Michael',
      budget:          cf['Budget']                    ?? 0,
      startDate:       cf['Start Date']                || null,
      endDate:         cf['End Date']                  || null,
      status:          cf['Status']?.name              || null,
      briefBackground: cf['Brief Background']          || null,
      briefGuidelines: cf['Brief Creative Guidelines'] || null,
      briefCTA:        cf['Brief CTA']                 || null,
    };
 
    // 4. Shape deliverables (sorted by code)
    const deliverables = (delivsData.records || [])
      .map(r => {
        const f = r.fields;
        const talentArr = f['Talent'];
        return {
          id:       r.id,
          code:     f['Deliverable Code'] || '',
          talent:   Array.isArray(talentArr) ? (talentArr[0]?.name || '') : '',
          type:     f['Type']?.name    || '',
          status:   f['Status']?.name  || '',
          airDate:  f['Air Date']      || null,
          postLink: f['Post Link']     || null,
          views:    f['Views']         ?? null,
          likes:    f['Likes']         ?? null,
          comments: f['Comments']      ?? null,
          shares:   f['Shares']        ?? null,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
 
    // 5. Shape offers
    const offers = (offersData.records || []).map(r => {
      const f = r.fields;
      return {
        id:             r.id,
        name:           firstLookup(f['Name (from Talent)']) || '',
        status:         f['Status']?.name          || '',
        brandFeedback:  f['Brand Feedback']        || '',
        brandApproval:  f['Brand Approval']?.name  || null,
        brandRanking:   f['Brand Ranking']         ?? null,
        instagramUrl:   firstLookup(f['Instagram URL']),
        tiktokUrl:      firstLookup(f['TikTok URL']),
        youtubeUrl:     firstLookup(f['YouTube URL']),
        snapchatUrl:    firstLookup(f['Snapchat URL']),
        headshotUrl:    extractHeadshot(f['Headshot']),
        biography:      firstLookup(f['Biography']),
        usAudience:     firstLookup(f['US Audience']),
        offer:          f['Offer'] ?? null,
      };
    });
 
    // 6. Shape timelines (sorted by date)
    const timelines = (timelinesData.records || [])
      .map(r => ({
        id:     r.id,
        task:   r.fields['Task']           || '',
        date:   r.fields['Date']           || null,
        status: r.fields['Status']?.name   || null,
        phase:  r.fields['Phase']?.name    || null,
      }))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
 
    // 60-second CDN cache, 5-minute stale-while-revalidate
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ campaign, deliverables, offers, timelines });
 
  } catch (err) {
    console.error('[api/campaign]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
