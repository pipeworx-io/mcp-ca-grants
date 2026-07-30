# @pipeworx/ca-grants

California Grants Portal MCP — open State of California grant funding opportunities: who administers them, who may apply, how much money is available, and when applications are due. Keyless.

## Tools

- `ca_search_grants(query?, status?, category?, applicant_type?, limit?, offset?)` — free-text search over California state grant opportunities, filterable by status, category, and eligible applicant type. Defaults to `status="active"`.
- `ca_get_grant(portal_id)` — the full record for one grant: purpose, description, eligibility notes, geography, funding source, matching-funds requirement, award amounts, funding method, contact info, and links.
- `ca_grants_closing_soon(days?, category?, applicant_type?, limit?)` — active grants with a fixed deadline in the next N days (default 30), soonest first, plus a count of rolling `Ongoing` opportunities.
- `ca_grants_by_agency(agency, status?, limit?, offset?)` — grants from one California department/agency, matched as a forgiving case-insensitive substring, with a status breakdown.
- `ca_list_grant_categories(status?)` — the category, applicant-type, agency, and status values actually present in the data, each with a grant count, so filter values can be read off real data.

## Auth

Keyless. No API key, no BYO credentials.

## Data sources

- Dataset: `https://data.ca.gov/dataset/california-grants-portal`
- Endpoint: `https://data.ca.gov/api/3/action/datastore_search`
- Resource id: `111c8c88-21f6-453c-ae2c-b4785a0624f5` (~1,974 rows, refreshed daily)
- Human portal: `https://www.grants.ca.gov/`

### Gotchas

Field ids are TitleCase (`AgencyDept`, `ApplicationDeadline`, `EstAvailFunds`) and getting the case wrong makes CKAN silently return nothing rather than erroring, so every field name in this pack is spelled from the live `fields` list. Every value is stored as **text**, which has three consequences. `EstAvailFunds` is a display string like `"$750,000"` and `EstAmounts` is often a range like `"Between $1 and $375,000"` — this pack deliberately exposes no numeric minimum-amount filter, because any such filter would have to guess at ranges; `est_available_funds_approx` parses the leading figure as advisory context only and is never filtered on. `Categories` and `ApplicantType` are semicolon-joined lists (`"Nonprofit; Public Agency; Tribal Government"`), so they are split per-atom and matched case-insensitively client-side rather than through CKAN `filters`, which only does equality/IN. And `ApplicationDeadline` is text: usually `"YYYY-MM-DD HH:MM:SS"`, but **127 of the 177 currently-active rows hold the literal string `"Ongoing"`** (rolling intake, no due date) with one row null — so deadline math happens client-side and `ca_grants_closing_soon` reports `ongoing_no_deadline` as its own bucket rather than dropping two-thirds of the open grants on the floor. Deadline timestamps carry no timezone and are treated as UTC, which is accurate to within a day. `Status` takes exactly three values (`active` 177, `closed` 1,796, `forecasted` 1), so unfiltered searches are dominated by expired opportunities and `ca_search_grants` defaults to `active`. Because CKAN cannot do substring matching, `ca_grants_by_agency` resolves the caller's fragment against the 73 distinct `AgencyDept` values in one projected scan, then filters server-side on the exact names it matched.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ca-grants": {
      "url": "https://gateway.pipeworx.io/ca-grants/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1375+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Ca Grants data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
