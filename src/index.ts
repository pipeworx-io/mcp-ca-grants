interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * California Grants Portal MCP — open State of California grant funding opportunities (keyless).
 *
 * Wraps the official California Grants Portal export published on the state open-data
 * portal (data.ca.gov, CKAN). Every row is one State grant opportunity: the administering
 * department, who may apply, how much money is available, and when applications are due.
 * Refreshed daily by the state.
 *
 *   Dataset:  https://data.ca.gov/dataset/california-grants-portal
 *   Portal:   https://www.grants.ca.gov/
 *   Resource: 111c8c88-21f6-453c-ae2c-b4785a0624f5
 *
 * Keyless. Uses CKAN datastore_search only (no SQL endpoint), with `fields=` to keep
 * payloads small and `filters=`/`q=` for server-side narrowing.
 *
 * Field-name and value gotchas that shape this pack (all probe-verified 2026-07-29):
 *   - Field ids are TitleCase (`AgencyDept`, `ApplicationDeadline`). Wrong case silently
 *     returns nothing rather than erroring.
 *   - EVERY value is stored as text. `EstAvailFunds` is a display string like "$750,000",
 *     `EstAmounts` like "Between $1 and $375,000". There is deliberately no numeric
 *     min-amount filter here because it could not be honest about ranges.
 *   - `ApplicationDeadline` is text: usually "YYYY-MM-DD HH:MM:SS", but 127 of the 177
 *     currently-active rows hold the literal string "Ongoing" (rolling intake, no due
 *     date) and one row is null. Deadline math therefore happens client-side and
 *     "Ongoing" is reported as its own bucket instead of being silently dropped.
 *   - `Categories` and `ApplicantType` are semicolon-joined lists, e.g.
 *     "Nonprofit; Public Agency; Tribal Government" — matched per-atom, case-insensitively.
 *   - `Status` values are `active`, `closed`, `forecasted`.
 *
 * All tools return shaped, LLM-friendly objects. A tool that legitimately cannot answer
 * resolves to { found: false, reason, hint }; only genuine transport/upstream faults throw.
 */


const BASE = 'https://data.ca.gov/api/3/action/datastore_search';
const RESOURCE = '111c8c88-21f6-453c-ae2c-b4785a0624f5';
const UA = 'pipeworx-mcp-ca-grants/1.0 (+https://pipeworx.io)';
const SOURCE = 'data.ca.gov — California Grants Portal (grants.ca.gov), updated daily';

/** Max rows pulled in one upstream scan. The whole dataset is ~1,974 rows. */
const SCAN_CAP = 2000;

/** Compact projection used by every list-shaped tool. */
const LIST_FIELDS = [
  'PortalID',
  'Title',
  'AgencyDept',
  'Status',
  'Categories',
  'ApplicantType',
  'EstAvailFunds',
  'EstAmounts',
  'OpenDate',
  'ApplicationDeadline',
  'GrantURL',
] as const;

const STATUS_VALUES = ['active', 'closed', 'forecasted'] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'ca_search_grants',
    description:
      'Search open State of California grant funding opportunities from the official California Grants Portal (grants.ca.gov) on data.ca.gov. Free-text search across grant titles, purposes and descriptions, with optional filters for status, category, and eligible applicant type. Each result returns the grant title, the administering California state department or agency, its categories, who is eligible to apply, estimated funding available, the application deadline, and a link to the official grant page. Defaults to currently-open (active) opportunities. Answers questions like "what California state grants can a nonprofit apply for right now", "state climate resilience funding in California", or "CalRecycle grant opportunities for tribal governments". This is CALIFORNIA STATE grant data, refreshed daily.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search across every field (title, purpose, description, agency), e.g. "climate", "wildfire resilience", "youth literacy".',
        },
        status: {
          type: 'string',
          enum: ['active', 'closed', 'forecasted', 'all'],
          description:
            'Which opportunities to include: "active" = currently open for applications (default), "forecasted" = announced but not yet open, "closed" = past deadline, "all" = every status.',
        },
        category: {
          type: 'string',
          description:
            'Match one grant category, case-insensitive, against the semicolon-joined Categories list, e.g. "Environment & Water", "Housing", "Education". Call ca_list_grant_categories to see the values present in the data.',
        },
        applicant_type: {
          type: 'string',
          description:
            'Match one eligible-applicant type, case-insensitive, against the semicolon-joined ApplicantType list. Known values: "Nonprofit", "Public Agency", "Tribal Government", "Business", "Individual", "Other Legal Entity".',
        },
        limit: { type: ['number', 'string'], description: 'Max records to return (default 20, max 100).' },
        offset: { type: ['number', 'string'], description: 'Number of matching records to skip, for pagination (default 0).' },
      },
    },
  },
  {
    name: 'ca_get_grant',
    description:
      'Fetch the complete detail record for one California state grant opportunity by its California Grants Portal ID (PortalID). Returns the full narrative purpose and description, eligible applicant types and eligibility notes, geography served, funding source, whether matching funds are required, estimated funds available and per-award amounts, funding method (reimbursement vs advance), the open date and application deadline, whether electronic submission is accepted, agency contact information, and links to the official grant page and agency site. Use after ca_search_grants to read the full terms of a specific California state grant.',
    inputSchema: {
      type: 'object',
      properties: {
        portal_id: {
          type: ['string', 'number'],
          description: 'The California Grants Portal ID from a search result, e.g. "189801".',
        },
      },
      required: ['portal_id'],
    },
  },
  {
    name: 'ca_grants_closing_soon',
    description:
      'List currently-open State of California grant opportunities whose application deadline falls within the next N days, soonest deadline first, so an applicant can see what is about to expire. Returns each grant with its days remaining, deadline timestamp, administering California state department, eligible applicant types, estimated funding available, and official link. Also reports separately how many active grants accept applications on a rolling "Ongoing" basis with no fixed due date, and how many rows carried an unreadable deadline. Answers "which California state grants close this month", "urgent CA grant deadlines", "what should I apply for before it closes".',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: ['number', 'string'], description: 'Deadline window in days from today (default 30, max 365).' },
        category: { type: 'string', description: 'Optional: restrict to one grant category, case-insensitive, e.g. "Environment & Water".' },
        applicant_type: {
          type: 'string',
          description: 'Optional: restrict to one eligible-applicant type, case-insensitive, e.g. "Nonprofit", "Tribal Government".',
        },
        limit: { type: ['number', 'string'], description: 'Max records to return (default 25, max 100).' },
      },
    },
  },
  {
    name: 'ca_grants_by_agency',
    description:
      'List the grant opportunities administered by a given California state department, agency, commission, or conservancy, matching the agency name as a forgiving case-insensitive substring so partial names like "Water Resources" or "Recycling" work. Returns the matched official agency names, a count breakdown by status, and the grant records with title, categories, eligible applicants, estimated funding, and deadline. Answers "what grants does CalRecycle offer", "grant programs from the California Energy Commission", "Department of Parks and Recreation funding opportunities".',
    inputSchema: {
      type: 'object',
      properties: {
        agency: {
          type: 'string',
          description:
            'California state department / agency name or fragment, case-insensitive, e.g. "Recycling", "Energy Commission", "Parks and Recreation", "Fish and Wildlife".',
        },
        status: {
          type: 'string',
          enum: ['active', 'closed', 'forecasted', 'all'],
          description: 'Which opportunities to include (default "all"; use "active" for only what is open now).',
        },
        limit: { type: ['number', 'string'], description: 'Max records to return (default 25, max 100).' },
        offset: { type: ['number', 'string'], description: 'Number of matching records to skip, for pagination (default 0).' },
      },
      required: ['agency'],
    },
  },
  {
    name: 'ca_list_grant_categories',
    description:
      'Enumerate the grant category values, eligible-applicant-type values, and administering agency names that actually occur in the California Grants Portal data, each with the number of grants carrying it, so filter values for ca_search_grants can be chosen from real data rather than guessed. Categories and applicant types are stored as semicolon-joined lists and are split into individual values here. Also reports the total row count and the count of currently-active opportunities. Call this first when a category or applicant-type filter returns nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'closed', 'forecasted', 'all'],
          description: 'Tally values over only this status (default "all"); use "active" to see what is available among currently-open grants.',
        },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ca_search_grants':
      return searchGrants(args);
    case 'ca_get_grant':
      return getGrant(args);
    case 'ca_grants_closing_soon':
      return closingSoon(args);
    case 'ca_grants_by_agency':
      return byAgency(args);
    case 'ca_list_grant_categories':
      return listCategories(args);
    default:
      throw new Error(`Unknown tool: ${name}. Available: ${tools.map((t) => t.name).join(', ')}`);
  }
}

// ── tools ──────────────────────────────────────────────────────────────────

async function searchGrants(args: Record<string, unknown>): Promise<unknown> {
  const limit = clampInt(args.limit, 20, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100_000);
  const status = statusArg(args.status, 'active');
  const query = strArg(args.query);
  const category = strArg(args.category);
  const applicantType = strArg(args.applicant_type);

  const params: Record<string, string> = { limit: String(SCAN_CAP), fields: LIST_FIELDS.join(',') };
  if (query) params.q = query;
  if (status) params.filters = JSON.stringify({ Status: status });

  const page = await ckan(params);
  let rows = page.records;
  const scanTruncated = page.total > rows.length;

  if (category) rows = rows.filter((r) => listHas(r.Categories, category));
  if (applicantType) rows = rows.filter((r) => listHas(r.ApplicantType, applicantType));

  if (rows.length === 0) {
    return {
      source: SOURCE,
      found: false,
      reason: 'no_matching_grants',
      hint: hintForEmpty({ query, status, category, applicantType }),
      query: query ?? null,
      status: status ?? 'all',
      category: category ?? null,
      applicant_type: applicantType ?? null,
    };
  }

  // Soonest real deadline first; rolling "Ongoing" intake after dated ones; unknown last.
  rows.sort((a, b) => deadlineRank(a.ApplicationDeadline) - deadlineRank(b.ApplicationDeadline));

  return {
    source: SOURCE,
    found: true,
    query: query ?? null,
    status: status ?? 'all',
    category: category ?? null,
    applicant_type: applicantType ?? null,
    total_matching: rows.length,
    scan_truncated: scanTruncated,
    limit,
    offset,
    count: Math.min(limit, Math.max(0, rows.length - offset)),
    grants: rows.slice(offset, offset + limit).map(shapeListRow),
  };
}

async function getGrant(args: Record<string, unknown>): Promise<unknown> {
  const portalId = strArg(args.portal_id);
  if (!portalId) {
    throw new Error('Required argument "portal_id" is missing. Pass a California Grants Portal ID like "189801" (get one from ca_search_grants).');
  }

  const page = await ckan({ limit: '5', filters: JSON.stringify({ PortalID: portalId }) });
  const row = page.records[0];
  if (!row) {
    return {
      source: SOURCE,
      found: false,
      reason: 'portal_id_not_found',
      hint: `No California Grants Portal record has PortalID "${portalId}". Run ca_search_grants with a keyword and use a PortalID from those results.`,
      portal_id: portalId,
    };
  }

  const deadline = parseDeadline(row.ApplicationDeadline);
  return {
    source: SOURCE,
    found: true,
    portal_id: txt(row.PortalID),
    grant_id: txt(row.GrantID),
    title: txt(row.Title),
    agency: txt(row.AgencyDept),
    status: txt(row.Status),
    type: txt(row.Type),
    last_updated: txt(row.LastUpdated),
    change_notes: txt(row.ChangeNotes),
    categories: splitList(row.Categories),
    categories_text: txt(row.Categories),
    category_suggestion: txt(row.CategorySuggestion),
    purpose: txt(row.Purpose),
    description: txt(row.Description),
    applicant_types: splitList(row.ApplicantType),
    applicant_type_notes: txt(row.ApplicantTypeNotes),
    geography: txt(row.Geography),
    letter_of_intent_required: txt(row.LOI),
    funding_source: txt(row.FundingSource),
    funding_source_notes: txt(row.FundingSourceNotes),
    matching_funds_required: txt(row.MatchingFunds),
    matching_funds_notes: txt(row.MatchingFundsNotes),
    est_available_funds: txt(row.EstAvailFunds),
    est_available_funds_approx: parseMoney(row.EstAvailFunds),
    est_awards: txt(row.EstAwards),
    est_award_amounts: txt(row.EstAmounts),
    funding_method: txt(row.FundingMethod),
    funding_method_notes: txt(row.FundingMethodNotes),
    open_date: txt(row.OpenDate),
    application_deadline: txt(row.ApplicationDeadline),
    deadline_kind: deadline.kind,
    deadline_iso: deadline.iso,
    award_period: txt(row.AwardPeriod),
    expected_award_date: txt(row.ExpAwardDate),
    electronic_submission: txt(row.ElecSubmission),
    grant_url: txt(row.GrantURL),
    agency_url: txt(row.AgencyURL),
    agency_subscribe_url: txt(row.AgencySubscribeURL),
    grant_events_url: txt(row.GrantEventsURL),
    contact_info: txt(row.ContactInfo),
    award_stats: txt(row.AwardStats),
  };
}

async function closingSoon(args: Record<string, unknown>): Promise<unknown> {
  const days = clampInt(args.days, 30, 1, 365);
  const limit = clampInt(args.limit, 25, 1, 100);
  const category = strArg(args.category);
  const applicantType = strArg(args.applicant_type);

  const page = await ckan({
    limit: String(SCAN_CAP),
    fields: LIST_FIELDS.join(','),
    filters: JSON.stringify({ Status: 'active' }),
  });

  let rows = page.records;
  if (category) rows = rows.filter((r) => listHas(r.Categories, category));
  if (applicantType) rows = rows.filter((r) => listHas(r.ApplicantType, applicantType));
  const activeConsidered = rows.length;

  // Recompute "now" per call — module-scope dates are frozen at epoch on Workers.
  const nowMs = Date.now();
  const cutoffMs = nowMs + days * 86_400_000;

  let ongoing = 0;
  let unparseable = 0;
  let alreadyPast = 0;
  const due: Array<{ row: Row; ms: number }> = [];

  for (const r of rows) {
    const d = parseDeadline(r.ApplicationDeadline);
    if (d.kind === 'ongoing') {
      ongoing++;
    } else if (d.kind === 'unknown' || d.ms == null) {
      unparseable++;
    } else if (d.ms < nowMs) {
      alreadyPast++;
    } else if (d.ms <= cutoffMs) {
      due.push({ row: r, ms: d.ms });
    }
  }

  due.sort((a, b) => a.ms - b.ms);

  if (due.length === 0) {
    return {
      source: SOURCE,
      found: false,
      reason: 'no_deadlines_in_window',
      hint: `No active California state grant has a fixed deadline in the next ${days} day(s). ${ongoing} active grant(s) accept applications on a rolling "Ongoing" basis with no due date — list those with ca_search_grants. Widen the window with a larger "days" value.`,
      window_days: days,
      active_considered: activeConsidered,
      ongoing_no_deadline: ongoing,
      deadline_already_passed: alreadyPast,
      skipped_unparseable_deadline: unparseable,
    };
  }

  return {
    source: SOURCE,
    found: true,
    window_days: days,
    category: category ?? null,
    applicant_type: applicantType ?? null,
    active_considered: activeConsidered,
    closing_in_window: due.length,
    ongoing_no_deadline: ongoing,
    deadline_already_passed: alreadyPast,
    skipped_unparseable_deadline: unparseable,
    count: Math.min(limit, due.length),
    grants: due.slice(0, limit).map(({ row, ms }) => ({
      ...shapeListRow(row),
      days_remaining: Math.max(0, Math.ceil((ms - nowMs) / 86_400_000)),
    })),
  };
}

async function byAgency(args: Record<string, unknown>): Promise<unknown> {
  const agency = strArg(args.agency);
  if (!agency) {
    throw new Error('Required argument "agency" is missing. Pass a California department name or fragment like "Recycling" or "Energy Commission".');
  }
  const status = statusArg(args.status, 'all');
  const limit = clampInt(args.limit, 25, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100_000);

  // Step 1: resolve the substring to the exact agency names present in the data, so
  // step 2 can filter server-side (CKAN filters are equality/IN only, never substring).
  const namesPage = await ckan({ limit: String(SCAN_CAP), fields: 'AgencyDept' });
  const distinct = new Map<string, number>();
  for (const r of namesPage.records) {
    const n = txt(r.AgencyDept);
    if (n) distinct.set(n, (distinct.get(n) ?? 0) + 1);
  }
  const needle = agency.toLowerCase();
  const matched = [...distinct.keys()].filter((n) => n.toLowerCase().includes(needle));

  if (matched.length === 0) {
    const sample = [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
    return {
      source: SOURCE,
      found: false,
      reason: 'agency_not_found',
      hint: `No California grant-making agency name contains "${agency}". Try a shorter fragment, or pick from these agencies that publish the most grants: ${sample.join('; ')}. ca_list_grant_categories returns the full agency list.`,
      agency_query: agency,
      distinct_agencies: distinct.size,
      sample_agencies: sample,
    };
  }

  // Step 2: pull the matched agencies' rows (IN filter), optionally narrowed by status.
  const filters: Record<string, unknown> = { AgencyDept: matched.length === 1 ? matched[0] : matched };
  if (status) filters.Status = status;
  const page = await ckan({ limit: String(SCAN_CAP), fields: LIST_FIELDS.join(','), filters: JSON.stringify(filters) });
  const rows = page.records;

  if (rows.length === 0) {
    return {
      source: SOURCE,
      found: false,
      reason: 'no_grants_for_status',
      hint: `${matched.join('; ')} matched, but has no grants with status "${status}". Retry with status "all" to see closed and forecasted opportunities.`,
      agency_query: agency,
      matched_agencies: matched,
      status: status ?? 'all',
    };
  }

  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    const s = txt(r.Status) ?? 'unknown';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  rows.sort((a, b) => deadlineRank(a.ApplicationDeadline) - deadlineRank(b.ApplicationDeadline));

  return {
    source: SOURCE,
    found: true,
    agency_query: agency,
    matched_agencies: matched,
    status: status ?? 'all',
    total_matching: rows.length,
    by_status: byStatus,
    limit,
    offset,
    count: Math.min(limit, Math.max(0, rows.length - offset)),
    grants: rows.slice(offset, offset + limit).map(shapeListRow),
  };
}

async function listCategories(args: Record<string, unknown>): Promise<unknown> {
  const status = statusArg(args.status, 'all');
  const params: Record<string, string> = {
    limit: String(SCAN_CAP),
    fields: 'Status,Categories,ApplicantType,AgencyDept',
  };
  if (status) params.filters = JSON.stringify({ Status: status });

  const page = await ckan(params);
  const rows = page.records;
  if (rows.length === 0) {
    return {
      source: SOURCE,
      found: false,
      reason: 'no_rows_for_status',
      hint: `No California Grants Portal rows carry status "${status}". Valid statuses: ${STATUS_VALUES.join(', ')}, or omit for all.`,
      status: status ?? 'all',
    };
  }

  const categories = new Map<string, number>();
  const applicantTypes = new Map<string, number>();
  const agencies = new Map<string, number>();
  const statuses = new Map<string, number>();
  for (const r of rows) {
    for (const c of splitList(r.Categories)) categories.set(c, (categories.get(c) ?? 0) + 1);
    for (const a of splitList(r.ApplicantType)) applicantTypes.set(a, (applicantTypes.get(a) ?? 0) + 1);
    const ag = txt(r.AgencyDept);
    if (ag) agencies.set(ag, (agencies.get(ag) ?? 0) + 1);
    const s = txt(r.Status);
    if (s) statuses.set(s, (statuses.get(s) ?? 0) + 1);
  }

  const tally = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, grants]) => ({ value, grants }));

  return {
    source: SOURCE,
    found: true,
    status: status ?? 'all',
    rows_counted: rows.length,
    note:
      'Categories and ApplicantType are stored as semicolon-joined lists on each grant and are split into individual values here, so the counts sum to more than rows_counted. Pass any "value" below to the category / applicant_type argument of ca_search_grants.',
    statuses: tally(statuses),
    categories: tally(categories),
    applicant_types: tally(applicantTypes),
    agencies: tally(agencies),
  };
}

// ── upstream ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

async function ckan(params: Record<string, string>): Promise<{ total: number; records: Row[] }> {
  const qs = new URLSearchParams({ resource_id: RESOURCE, ...params });
  let res: Response;
  try {
    res = await fetch(`${BASE}?${qs.toString()}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  } catch (e) {
    throw new Error(`California Grants Portal request failed (network): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 429) throw new Error('data.ca.gov rate-limited this request (HTTP 429). Retry in a few seconds.');
  if (res.status === 404) {
    throw new Error(`data.ca.gov returned HTTP 404 — the California Grants Portal resource ${RESOURCE} may have been replaced. Check https://data.ca.gov/dataset/california-grants-portal`);
  }
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
    throw new Error(`data.ca.gov error: HTTP ${res.status}${body ? ` — ${body}` : ''}`);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error('data.ca.gov returned a non-JSON response.');
  }
  if (data?.success === false) {
    const msg = data?.error?.message || JSON.stringify(data?.error ?? {}).slice(0, 200);
    throw new Error(`data.ca.gov rejected the query: ${msg}`);
  }
  const records: Row[] = Array.isArray(data?.result?.records) ? data.result.records : [];
  const total = typeof data?.result?.total === 'number' ? data.result.total : records.length;
  return { total, records };
}

// ── shaping ────────────────────────────────────────────────────────────────

function shapeListRow(r: Row) {
  const d = parseDeadline(r.ApplicationDeadline);
  return {
    portal_id: txt(r.PortalID),
    title: txt(r.Title),
    agency: txt(r.AgencyDept),
    status: txt(r.Status),
    categories: splitList(r.Categories),
    applicant_types: splitList(r.ApplicantType),
    est_available_funds: txt(r.EstAvailFunds),
    est_award_amounts: txt(r.EstAmounts),
    open_date: txt(r.OpenDate),
    application_deadline: txt(r.ApplicationDeadline),
    deadline_kind: d.kind,
    deadline_iso: d.iso,
    grant_url: txt(r.GrantURL),
  };
}

/** Empty string and null both mean "no value" in this dataset. */
function txt(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function splitList(v: unknown): string[] {
  const s = txt(v);
  if (!s) return [];
  return s
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Case-insensitive match of `needle` against one atom of a semicolon-joined list. */
function listHas(v: unknown, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return splitList(v).some((atom) => {
    const a = atom.toLowerCase();
    return a === n || a.includes(n);
  });
}

type Deadline = { kind: 'date' | 'ongoing' | 'unknown'; ms: number | null; iso: string | null };

/**
 * `ApplicationDeadline` is text. Usual form is "YYYY-MM-DD HH:MM:SS" (interpreted as
 * Pacific-portal local time but stored without a zone, so treated as UTC — accurate to
 * within a day, which is all a "closing soon" window needs). 127 of 177 active rows say
 * "Ongoing"; one row is null. Anything else is reported as unknown rather than guessed at.
 */
function parseDeadline(v: unknown): Deadline {
  const s = txt(v);
  if (!s) return { kind: 'unknown', ms: null, iso: null };
  if (/^ongoing$/i.test(s)) return { kind: 'ongoing', ms: null, iso: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return { kind: 'unknown', ms: null, iso: null };
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? '0'),
    Number(m[5] ?? '0'),
    Number(m[6] ?? '0'),
  );
  if (!Number.isFinite(ms)) return { kind: 'unknown', ms: null, iso: null };
  return { kind: 'date', ms, iso: new Date(ms).toISOString() };
}

/** Sort key: dated deadlines ascending, then rolling "Ongoing", then unknown. */
function deadlineRank(v: unknown): number {
  const d = parseDeadline(v);
  if (d.kind === 'date' && d.ms != null) return d.ms;
  return d.kind === 'ongoing' ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
}

/**
 * Approximate dollars from a display string like "$750,000". Ranges such as
 * "Between $1 and $375,000" yield the FIRST figure only, so this is advisory context
 * next to the verbatim text — it is never used for filtering.
 */
function parseMoney(v: unknown): number | null {
  const s = txt(v);
  if (!s) return null;
  const m = /\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function hintForEmpty(f: { query?: string; status?: string; category?: string; applicantType?: string }): string {
  const parts: string[] = [];
  if (f.category) parts.push(`category "${f.category}"`);
  if (f.applicantType) parts.push(`applicant_type "${f.applicantType}"`);
  if (parts.length) {
    return `No California state grant matched ${parts.join(' and ')}${f.query ? ` together with query "${f.query}"` : ''}. Call ca_list_grant_categories to see the exact category and applicant-type values present in the data, then retry with one of those.`;
  }
  if (f.query) {
    return `No California state grant matched "${f.query}"${f.status === 'active' ? ' among currently-open opportunities — retry with status "all" to include closed and forecasted grants' : ''}. Try a broader single keyword such as "water", "housing", or "education".`;
  }
  return 'No rows returned. Retry with status "all", or call ca_list_grant_categories to confirm the dataset is reachable.';
}

// ── argument coercion ──────────────────────────────────────────────────────

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Returns the Status value to filter on, or undefined for "all". */
function statusArg(v: unknown, def: 'active' | 'all'): string | undefined {
  const s = strArg(v)?.toLowerCase();
  if (!s) return def === 'all' ? undefined : def;
  if (s === 'all' || s === 'any') return undefined;
  const hit = STATUS_VALUES.find((k) => k === s);
  if (!hit) {
    throw new Error(`Unknown status "${s}". Use one of: ${STATUS_VALUES.join(', ')}, or "all".`);
  }
  return hit;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.floor(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.floor(Number(v));
  else return def;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
