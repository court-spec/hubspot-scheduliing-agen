#!/usr/bin/env node
/**
 * WTG Office Investigation Poller
 *
 * Polls HubSpot for new "Office Investigation Form" submissions and creates
 * office_investigation custom-object records (objectTypeId 2-229533103) for each.
 *
 * Run via cron every 15 minutes:
 *   * /15 * * * * cd /path/to/project && node src/poll-office-investigations.js
 *
 * Required env var: HUBSPOT_TOKEN
 */

// ── Config ────────────────────────────────────────────────────────────────────

const PORTAL_ID       = '245172784';
const BASE_URL        = 'https://api.hubapi.com';
const FORM_ID         = 'ddf63bc2-ca0f-4f55-8595-c93b6560a49c';
const OBJECT_TYPE_ID  = '2-229533103'; // office_investigation

const DRY_RUN = process.argv.includes('--dry-run');

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('[ERROR] HUBSPOT_TOKEN environment variable is not set.');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// ── Property mapping: form field name -> investigation property name ──────────

// Fields that feed into the composite investigation_name are handled separately.
const DIRECT_MAP = {
  oi_office_tier_at_visit:    'office_tier_at_visit',
  oi_visit_trigger:           'visit_trigger',
  oi_spoke_with_role:         'spoke_with_role',
  oi_spoke_with_name:         'spoke_with_name',
  oi_receptivity:             'receptivity',
  oi_verbatim_quote:          'verbatim_quote',
  oi_hesitation_reasons:      'hesitation_reasons',
  oi_what_changed:            'what_changed',
  oi_action_committed:        'action_committed',
  oi_follow_up_by_date:       'follow_up_by_date',
  oi_referral_likelihood_90d: 'referral_likelihood_90d',
};

// Boolean fields stored as "Yes"/"No" in the form
const BOOL_FIELDS = new Set(['oi_follow_up_needed', 'oi_escalate_to_leadership']);

// Multi-select fields arrive semicolon-separated; HubSpot expects semicolons for enum lists
const MULTI_SELECT_FIELDS = new Set(['oi_hesitation_reasons', 'oi_what_changed']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function submissionValues(submission) {
  const map = {};
  for (const { name, value } of submission.values ?? []) {
    map[name] = value ?? '';
  }
  return map;
}

function toHubSpotBool(val) {
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'string') {
    const lower = val.toLowerCase().trim();
    if (lower === 'yes' || lower === 'true') return 'true';
  }
  return 'false';
}

function buildProperties(vals) {
  const props = {};

  // Composite name
  const officeName   = (vals['oi_office_name_submitted']  ?? '').trim();
  const marketerName = (vals['oi_marketer_name_submitted'] ?? '').trim();
  const visitDate    = (vals['oi_visit_date']              ?? '').trim();
  props['investigation_name'] =
    `${officeName} - ${visitDate} (by ${marketerName})`;

  // visit_date also maps directly
  if (visitDate) props['visit_date'] = visitDate;

  // Direct 1-to-1 mappings
  for (const [formField, objProp] of Object.entries(DIRECT_MAP)) {
    if (vals[formField] !== undefined && vals[formField] !== '') {
      props[objProp] = vals[formField];
    }
  }

  // Boolean conversions
  for (const formField of BOOL_FIELDS) {
    const targetProp = formField.replace(/^oi_/, '');
    if (vals[formField] !== undefined) {
      props[targetProp] = toHubSpotBool(vals[formField]);
    }
  }

  return props;
}

// ── HubSpot API calls ─────────────────────────────────────────────────────────

async function getLatestInvestigationDate() {
  const url =
    `${BASE_URL}/crm/v3/objects/${OBJECT_TYPE_ID}` +
    `?limit=1&sorts=-hs_createdate&properties=hs_createdate`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Failed to fetch latest investigation: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();

  if (data.results?.length > 0) {
    const createdAt = data.results[0].createdAt;
    return new Date(createdAt);
  }

  // No records yet — look back 24 hours
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000);
  log(`No existing investigation records found; using 24-hour lookback: ${fallback.toISOString()}`);
  return fallback;
}

async function fetchFormSubmissions() {
  const url =
    `${BASE_URL}/form-integrations/v1/submissions/forms/${FORM_ID}?limit=50`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Failed to fetch form submissions: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.results ?? [];
}

async function createInvestigationRecord(properties, label) {
  if (DRY_RUN) {
    log(`[DRY RUN] Would create record: ${label}`);
    log(`[DRY RUN] Properties: ${JSON.stringify(properties, null, 2)}`);
    return { id: 'dry-run' };
  }

  const url = `${BASE_URL}/crm/v3/objects/${OBJECT_TYPE_ID}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify({ properties }),
  });

  if (!res.ok) {
    throw new Error(`POST failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting Office Investigation poll (dry-run=${DRY_RUN})`);

  // Step 1: determine cutoff
  const cutoff = await getLatestInvestigationDate();
  log(`Cutoff timestamp: ${cutoff.toISOString()}`);

  // Step 2: fetch recent form submissions
  const submissions = await fetchFormSubmissions();
  log(`Fetched ${submissions.length} total submission(s) from form`);

  // Step 3: filter to submissions after cutoff
  const newSubmissions = submissions.filter(s => {
    const submittedAt = new Date(s.submittedAt);
    return submittedAt > cutoff;
  });

  if (newSubmissions.length === 0) {
    log('No new submissions. Exiting.');
    return;
  }

  log(`Found ${newSubmissions.length} new submission(s) to process`);

  // Step 4: create a record for each new submission
  let created = 0;

  for (const submission of newSubmissions) {
    const vals  = submissionValues(submission);
    const label = `${vals['oi_office_name_submitted'] ?? '?'} / ${vals['oi_visit_date'] ?? '?'}`;

    try {
      const props  = buildProperties(vals);
      const record = await createInvestigationRecord(props, label);
      log(`Created record id=${record.id} for "${props['investigation_name']}"`);
      created++;
    } catch (err) {
      log(`[ERROR] Failed to create record for "${label}": ${err.message}`);
      // Continue with remaining submissions
    }
  }

  log(`Created ${created} investigation record(s).`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
