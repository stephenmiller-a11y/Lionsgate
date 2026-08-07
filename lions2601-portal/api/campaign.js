// api/campaign.js
// Vercel serverless function — fetches campaign data from Airtable
// Keeps AIRTABLE_TOKEN server-side; never exposed to the browser.
//
// Required environment variable (set in Vercel dashboard or .env.local):
//   AIRTABLE_TOKEN  — your Airtable Personal Access Token
//
// Optional overrides:
//   AIRTABLE_BASE_ID  — default: appcKC14Om93O40QC

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appcKC14Om93O40QC';
const AT_BASE = `https://api.airtable.com/v0/${BASE_ID}`;

// ── Table IDs ────────────────────────────────────────────────────────────────
const TABLES = {
  campaigns:    'tblUKz2hOxJmDUWhk',
  deliverables: 'tblNOrIcXwZ0R78LJ',
  offers:       'tblmH1uMjxYG1y8X6',
  timelines:    'tblq7dwxv0yUdzPou',
};

// ── Field IDs ─────────────────────────────────────────────────────────────────
// Deliverables table — accessed by field ID (returnFieldsByFieldId=true)
const DELIVERABLE_FIELDS = [
  'fldrNfr3G8KgviLkR', // Deliverable Code
  'fldDiP9NLIgCSUPkA', // Talent Name (formula — resolves to talent's name)
  'fldDjtURDzrqQqT8O', // Type (singleSelect)
  'fld9R7BcRAKciybge', // Status (singleSelect)
  'fldgonVo2oC1R483t', // Air Date
  'fldoSvBFD45ZdpYHJ', // Post Link
  'fldliR0ZyX2OzMkvs', // Views
  'fld3BhTWQ1IdTe6um', // Likes
  'fldTm8YrIhRvRCQUr', // Comments
  'fldqqQzTtUl6k5crI', // Shares
  'flds3ZtOYpN6eTur5', // Post Thumbnail (multipleAttachments — populated by stats pull)
];

// Offers table — accessed by field ID (returnFieldsByFieldId=true)
const OFFER_FIELDS = [
  'fldrjJQqkKpdXFDyM', // Name (from Talent) — multipleLookupValues
  'fldj9RNXpglllTMBE', // Status (singleSelect)
  'fld2jDj78o2PYGukg', // Brand Feedback
  'fldoZlmO1OIJc6fI7', // Brand Approval (singleSelect)
  'fldWceYkW6KgT58KI', // Brand Ranking
  'fld0pTahNYhyvIMgK', // Instagram URL — multipleLookupValues
  'fldT0Ay8sZT2CdFSO', // TikTok URL — multipleLookupValues
  'fld4PkLU2QwRoJ8Sk', // YouTube URL — multipleLookupValues
  'fldMnSn105js66oLh', // Snapchat URL — multipleLookupValues
  'fldFlu16WtdeFsWfX', // Headshot — multipleLookupValues of attachments
  'fldGwHtpe9pNZmCYI', // Biography — multipleLookupValues
  'fldWRvRqw9E1leW0g', // US Audience — multipleLookupValues
  'fldmqzhGoXj8iuuDa', // Offer amount
  'fldBtszBWAURqUSl0', // Talent — multipleRecordLinks (needed to join follower counts)
];

// Talent table — fetched separately to get per-platform follower counts
const TALENT_TABLE = 'tblE6sYQNKXKiDYJl';
const TALENT_FOLLOWER_FIELDS = [
  'fldy8xbWpSQg3yEMW', // Instagram followers
  'fldDY0xBfZcEDD7wb', // TikTok followers
  'fldRB7SmxeDcdKP6Z', // YouTube subscribers
  'fldZ1DBL9f9dDmynX', // Snapchat followers
];

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fetch a single record by path (no fields[] filter — single-record endpoint
// doesn't support it). Returns fields keyed by NAME.
async function atGet(path, token) {
  const url = new URL(`${AT_BASE}/${path}`);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable [${res.status}] ${path}: ${body}`);
  }
  return res.json();
}

// Fetch multiple records from a table by record IDs, handling Airtable pagination
// (max 100 records per page). Uses returnFieldsByFieldId=true.
async function atGetByIds(tableId, ids, fieldIds, token) {
  if (!ids || ids.length === 0) return { records: [] };
  const formula = ids.length === 1
    ? `RECORD_ID()='${ids[0]}'`
    : `OR(${ids.map(id => `RECORD_ID()='${id}'`).join(',')})`;

  const allRecords = [];
  let offset;
  do {
    const url = new URL(`${AT_BASE}/${tableId}`);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    fieldIds.forEach(id => url.searchParams.append('fields[]', id));
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable [${res.status}] ${tableId}: ${body}`);
    }
    const data = await res.json();
    allRecords.push(...(data.records || []));
    offset = data.offset;
  } while (offset);

  return { records: allRecords };
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
  if (typeof first === 'object' && first.url) return first.url;
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

  const campaignId = req.query.campaign;
  if (!campaignId) {
    return res.status(400).json({
      error: 'Missing required query parameter: campaign (e.g. /api/campaign?campaign=recXXXXXXXX)',
    });
  }

  try {
    // 1. Fetch campaign record (all fields, keyed by name)
    const campRecord = await atGet(`${TABLES.campaigns}/${campaignId}`, token);
    const cf = campRecord.fields;

    // Linked record fields return plain string ID arrays in the REST API
    const deliverableIds = cf['Deliverables'] || [];
    const offerIds       = cf['Offers']       || [];
    const timelineIds    = cf['📅 Timelines'] || [];
    const brandId        = (cf['Brand'] || [])[0] || null;

    // 2. Fetch related records in parallel (fields keyed by field ID)
    // Brand table primary field: fldzffs5mAHRcIadt
    const BRAND_TABLE = 'tblzolzC9inRloCvo';
    const [delivsData, offersData, timelinesData, brandData] = await Promise.all([
      atGetByIds(TABLES.deliverables, deliverableIds, DELIVERABLE_FIELDS, token),
      atGetByIds(TABLES.offers,       offerIds,       OFFER_FIELDS,       token),
      atGetByIds(TABLES.timelines,    timelineIds,    [],                 token),
      brandId ? atGetByIds(BRAND_TABLE, [brandId], ['fldzffs5mAHRcIadt'], token) : Promise.resolve({ records: [] }),
    ]);

    const brandName = brandData.records?.[0]?.fields?.['fldzffs5mAHRcIadt'] || null;

    // 2b. Collect unique Talent IDs from offers and fetch follower counts
    const talentIds = [...new Set(
      (offersData.records || []).flatMap(r => r.fields['fldBtszBWAURqUSl0'] || [])
    )];
    const talentData = await atGetByIds(TALENT_TABLE, talentIds, TALENT_FOLLOWER_FIELDS, token);
    // Build a map: talentId → { instagramFollowers, tiktokFollowers, youtubeFollowers, snapchatFollowers }
    const talentFollowers = {};
    (talentData.records || []).forEach(r => {
      talentFollowers[r.id] = {
        instagramFollowers: r.fields['fldy8xbWpSQg3yEMW'] ?? null,
        tiktokFollowers:    r.fields['fldDY0xBfZcEDD7wb'] ?? null,
        youtubeFollowers:   r.fields['fldRB7SmxeDcdKP6Z'] ?? null,
        snapchatFollowers:  r.fields['fldZ1DBL9f9dDmynX'] ?? null,
      };
    });

    // 3. Shape campaign
    // Single-select fields return plain strings (not objects) in the REST API
    const campaign = {
      name:            (cf['📇 Campaign Name'] || cf['Campaign'] || '').trim(),
      brandName:       brandName,
      logoUrl:         cf['Logo']?.[0]?.url || null,
      budget:          cf['Budget']                    ?? 0,
      startDate:       cf['Start Date']                || null,
      endDate:         cf['End Date']                  || null,
      status:          cf['Status']                    || null,
      briefBackground: cf['Brief Background']          || null,
      briefGuidelines: cf['Brief Creative Guidelines'] || null,
      briefCTA:        cf['Brief CTA']                 || null,
      kpis:            cf['KPIs']                      || null,
    };

    // 4. Shape deliverables — fields keyed by field ID
    const deliverables = (delivsData.records || [])
      .map(r => {
        const f = r.fields;
        return {
          id:       r.id,
          code:     f['fldrNfr3G8KgviLkR'] || '',  // Deliverable Code
          talent:   f['fldDiP9NLIgCSUPkA'] || '',  // Talent Name (formula)
          type:     f['fldDjtURDzrqQqT8O'] || '',  // Type (singleSelect string)
          status:   f['fld9R7BcRAKciybge'] || '',  // Status (singleSelect string)
          airDate:  f['fldgonVo2oC1R483t'] || null,
          postLink: f['fldoSvBFD45ZdpYHJ'] || null,
          views:        f['fldliR0ZyX2OzMkvs'] ?? null,
          likes:        f['fld3BhTWQ1IdTe6um'] ?? null,
          comments:     f['fldTm8YrIhRvRCQUr'] ?? null,
          shares:       f['fldqqQzTtUl6k5crI'] ?? null,
          hasThumbnail: !!(f['flds3ZtOYpN6eTur5'] && f['flds3ZtOYpN6eTur5'].length > 0),
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));

    // 5. Shape offers — fields keyed by field ID
    const offers = (offersData.records || []).map(r => {
      const f = r.fields;
      // Join follower counts from linked Talent record
      const talentId = (f['fldBtszBWAURqUSl0'] || [])[0] || null;
      const followers = talentId ? (talentFollowers[talentId] || {}) : {};
      return {
        id:                  r.id,
        name:                firstLookup(f['fldrjJQqkKpdXFDyM']) || '',  // Name (from Talent)
        status:              f['fldj9RNXpglllTMBE']              || '',  // Status
        brandFeedback:       f['fld2jDj78o2PYGukg']              || '',  // Brand Feedback
        brandApproval:       f['fldoZlmO1OIJc6fI7']              || null, // Brand Approval
        brandRanking:        f['fldWceYkW6KgT58KI']              ?? null, // Brand Ranking
        instagramUrl:        firstLookup(f['fld0pTahNYhyvIMgK']),
        tiktokUrl:           firstLookup(f['fldT0Ay8sZT2CdFSO']),
        youtubeUrl:          firstLookup(f['fld4PkLU2QwRoJ8Sk']),
        snapchatUrl:         firstLookup(f['fldMnSn105js66oLh']),
        headshotUrl:         extractHeadshot(f['fldFlu16WtdeFsWfX']),
        biography:           firstLookup(f['fldGwHtpe9pNZmCYI']),
        usAudience:          firstLookup(f['fldWRvRqw9E1leW0g']),
        offer:               f['fldmqzhGoXj8iuuDa']              ?? null,
        instagramFollowers:  followers.instagramFollowers  ?? null,
        tiktokFollowers:     followers.tiktokFollowers     ?? null,
        youtubeFollowers:    followers.youtubeFollowers    ?? null,
        snapchatFollowers:   followers.snapchatFollowers   ?? null,
      };
    });

    // 6. Shape timelines — fetched without field filter; fields keyed by name
    const timelines = (timelinesData.records || [])
      .map(r => ({
        id:     r.id,
        task:   r.fields['Task']   || '',
        date:   r.fields['Date']   || null,
        status: r.fields['Status'] || null,
        phase:  r.fields['Phase']  || null,
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
