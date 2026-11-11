# Team knowledge

Team sharing is an opt-in Cloud API Gateway feature. The local personal Wiki
keeps its existing access boundary. Team sharing uses the authenticated
principal, their active tenant membership and explicit company membership.

## Set up a pilot

1. Apply migration `0049_team_knowledge.sql` in the pilot D1 database.
2. Using the deployment's operator access, add one row to
   `team_knowledge_tenants(tenant_id, company_id)` for each existing tenant
   in the pilot company. Choose an opaque stable company ID and use the exact
   tenant IDs. A tenant is in at most one company. Company membership is
   independent of the tenant display name and email domain.
3. Register the initial company administrator in
   `team_knowledge_admins(company_id, tenant_id, principal)`. The principal
   must already be active in `user_profiles` in that tenant. Tenant admin
   privileges do not create a company administrator. Subsequent role changes
   are available in Console → Team knowledge → Manage sharing roles.
4. Set `TEAM_KNOWLEDGE_ENABLED=true` on the pilot Gateway. Leave it unset
   or set it to `false` to turn off team results and mutations. The existing
   Decision Console setting must allow access-policy reads and writes for the
   Knowledge → Access panel.

Members have rank 1 unless assigned rank 2 (manager), rank 3 (executive), or
company administrator. For a role share, first set the source's existing
access policy to Private. This also narrows the legacy readers. Then select a
minimum role, optional recipient tenants and optional expiry in Knowledge →
Access. The preview describes the audience before and after the save. Only an
authorized owner or tenant admin with share permission can save the policy.
Sharing to another tenant also requires manager rank and an explicit recipient.

A manager with share permission can submit the current revision for All.
The company administrator can approve the exact submitted contents from the
team page. The approved text stays searchable when its source is edited.
Revoking the publication, deleting the source or changing its access policy
removes the shared link. A new approval is required to expose an edited version.
Attachments and original files use their own access rules.

## Search

Shared search splits the query into up to 12 distinct terms on spaces,
punctuation and symbols. Common English function words (such as "the", "how"
or "with") are dropped, as are ASCII terms shorter than 3 characters and other
terms shorter than 2 characters. A term contained in a longer term is dropped.
A query without separators, such as most Japanese phrases, stays one term. If
no term remains, the whole query is matched as one string. With one or two
terms, a result must contain all of them in its title or text; with more, it
must contain at least a third of them (minimum two). Results are ranked by the
number of matched terms, with title matches counted twice, and then by
recency. Each excerpt is up to 600 characters around the first match, and
`content_truncated` marks a partial excerpt. Matching never widens the
audience: only results the viewer can already read are considered.

The `shared_knowledge` field added to memory search holds at most 3 results,
or fewer when the request sets a lower `limit` (a `limit` of 0 returns none).
Its title and text stay within 25% of `token_budget`. The REST
`POST /v1/memories/search` body and the MCP `orgbrain_memories_search` tool
(integer, 512 to 16000) both accept it. On these search routes the budget
currently bounds only the appended team knowledge. A missing or non-numeric REST
value falls back to about 450 estimated tokens, and a numeric REST value outside
512 to 16000 is treated as the nearest bound. Lower-ranked results are
dropped first, then the remaining excerpt is shortened, and
`shared_knowledge_truncated` is set. The direct `GET /v1/team-knowledge/search`
route keeps its own result limit.

Tokens are estimated without a tokenizer. Each non-ASCII character (Japanese,
Korean, emoji and other scripts) counts as one token, and ASCII text counts
as one token per four characters. Japanese text is therefore not under-counted
the way a plain characters-divided-by-four rule would.

Each result returned by memory search (REST or MCP) or by the direct search
route is recorded in `team_knowledge_deliveries`. A row holds the share, source
and revision, the viewer, the path, the rank and the token estimate, plus a
SHA-256 of the trimmed, lowercased query. Query text and content are not
stored. Recording is best effort and never fails a search. On all three paths
the write runs after the response through the request's execution context; a
runtime without one awaits it before responding. Rows remain after a
share is revoked and are removed when the source is permanently deleted.

## Verify and roll back

- Test with a source manager, a selected recipient manager, an ordinary
  recipient, an unselected tenant, and a second company. Run both broad
  searches and direct-link requests. Repeat after demotion, role-share expiry,
  permission changes, and company publication revocation.
- Review the pre-existing access policy shadow comparison for the private
  source policy. A stale or broadly readable legacy origin cannot activate a
  role share. The team result itself is exposed in a separate
  `shared_knowledge` field of the broad memory search API and MCP tool.
  Use `GET /v1/team-knowledge/item/:id` or
  `orgbrain_shared_knowledge_get` to read one shared result.
- Check app inboxes after edits and approved All releases. A change is visible
  only to a watcher who can still read it. The inbox supports marking items as
  read and comparing approved All versions or accessible owner history.
- If the rollout has to stop, turn the flag off before changing data or
  deployments. Existing source access policies and approval history are
  retained. Verify the absence of team results in API, MCP, and Console,
  including already copied share links.
