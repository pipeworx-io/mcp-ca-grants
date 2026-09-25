# @pipeworx/ca-grants

California Grants Portal MCP — open State of California grant funding opportunities: who administers them, who may apply, how much money is available, and when applications are due. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ca-grants/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ca_search_grants \
  -H 'Content-Type: application/json' \
  -d '{"query":"wildfire resilience","status":"active","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ca_search_grants`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ca-grants": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ca-grants"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ca-grants
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ca Grants data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
