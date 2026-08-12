# Contracts

Concrete shapes from the reference build, so an agent has something to
start from even when `lndawkins-site` itself isn't available to read.
Field names below (`testimonial_company`, `faq_question`, ...) are
site-specific — the *shape* (a fixed `action` discriminant, plain-text
old→new for edits, a `summary` for every state-changing action) is what
generalizes; rename/extend the per-action fields for the target site's
own content model (Step 1).

## The LLM interpretation contract

The model's entire job is producing one JSON object matching this shape
— it never calls storage or the git API itself:

```ts
type Interpretation = {
  action:
    | "edit_field"
    | "publish_testimonial"
    | "publish_team_member"
    | "publish_faq"
    | "publish_service"
    | "clarify"
    | "help";
  clarifying_question?: string; // set when action === "clarify"
  help_message?: string;        // set when action === "help"
  collection?: "services" | "team" | "testimonials" | "faq" | "pages" | "settings";
  slug?: string;                // a CLAIM — validate against real content (Step 1) before trusting it
  field?: string;                // e.g. "title", "sections[0].body", "social.instagram"
  is_image_field?: boolean;      // true => the field is an image path; requires an attached photo
  new_value?: string;
  // one block of these per "publish new item" action — extend/replace per site:
  testimonial_company?: string;
  testimonial_quote?: string;
  team_name?: string;
  team_role?: string;
  faq_question?: string;
  faq_answer?: string;
  summary?: string; // REQUIRED for every action except clarify/help — the owner-facing preview text
};
```

The matching JSON Schema (used only for prompting, not server-side
enforcement, in the reference build — see `references/gotchas.md` for
why structured-output enforcement was deliberately left off):

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "action": { "type": "string", "enum": ["edit_field", "publish_testimonial", "publish_team_member", "publish_faq", "publish_service", "clarify", "help"] },
    "clarifying_question": { "type": "string" },
    "help_message": { "type": "string" },
    "collection": { "type": "string", "enum": ["services", "team", "testimonials", "faq", "pages", "settings"] },
    "slug": { "type": "string" },
    "field": { "type": "string" },
    "is_image_field": { "type": "boolean" },
    "new_value": { "type": "string" },
    "testimonial_company": { "type": "string" },
    "testimonial_quote": { "type": "string" },
    "team_name": { "type": "string" },
    "team_role": { "type": "string" },
    "faq_question": { "type": "string" },
    "faq_answer": { "type": "string" },
    "summary": { "type": "string" }
  },
  "required": ["action"]
}
```

System-prompt rules that made this reliable in practice:

- If the request is ambiguous about *which* entry it refers to (multiple
  services, say), require `action: "clarify"` with a specific question
  listing the real options — never let the model guess.
- Every owner-facing string (`clarifying_question`, `help_message`,
  `summary`) must be in plain language — no "collection," "slug,"
  "frontmatter." Say it the way the owner would.
- Never invent a slug/collection/field that isn't in the whitelist
  (below) — fall back to `action: "help"` if nothing matches.

## The content whitelist / "what exists" digest

Sent as part of every request so the model can ground its answer against
real content, not guess. A compact per-collection text digest, not the
full file contents:

```
## services (collection: services)
- slug="machining" title="Machining" order=1 summary="..." heroImage=/assets/images/... sections=[Precision Work, Custom Fabrication]

## team members (collection: team)
- slug="lesgar-dawkins" name="Lesgar Dawkins" role="Managing Director" order=1 photo=/assets/images/...

## testimonials (collection: testimonials)
- slug="coldfield-manufacturing" company="Coldfield Manufacturing Ltd" order=1 shortQuote="..." fullQuote="..."
```

Truncate long fields (summary/quote text) to ~100-160 chars in the
digest — the model only needs enough to disambiguate and reference, not
the full text (it already has the *specific* old value once it commits
to an `edit_field` action, fetched fresh server-side before the diff is
shown).

## Server-side slug/field validation

Before treating any `Interpretation` as actionable: confirm
`collection` is in the whitelist, confirm `slug` actually exists in that
collection (re-fetch from the real content source, don't trust the
digest's snapshot), and reject `__proto__`/`constructor`/`prototype` as
any path segment (see `references/gotchas.md`). Fail closed — "I
couldn't find that on the site, could you double-check?" — not a
best-effort write to whatever the claimed path resolves to.

## Storage key shapes

Namespaced per email where two owners acting concurrently could
otherwise clobber each other; global where the thing being tracked is
shared:

| Key | Scope | Notes |
|---|---|---|
| `magiclink:{jti}` | global | single-use marker, delete on consume |
| `pending-preview:{email}` | per owner | 24h TTL, cleared on confirm/discard |
| `pending-clarification:{email}` | per owner | 24h TTL |
| `quota:{YYYY-MM}` | global | incremented only after a successful write |
| `conversations:{email}` | per owner | index: `{id, title, createdAt, updatedAt}[]`, most-recent first, capped (e.g. 50) |
| `conversation:{email}:{id}` | per owner | one thread's messages, capped (e.g. 300) |

## The deploy-status check response

The endpoint the client polls after confirming a change (Step 6):

```
GET /api/.../deploy-status?commit=<sha>
→ { "live": boolean }
```

Netlify-specific implementation (verified — see
`references/hosts.md`):

```ts
const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
  headers: { Authorization: `Bearer ${netlifyApiToken}` },
});
const site = await res.json();
const live = site.published_deploy?.commit_ref === commit
  && site.published_deploy?.state === "ready";
```

## The "changeUrl" mapping

A small, hand-maintained `collection → public path` table so the
"now live" response can point at the actual page, not just say "it's
live":

```ts
function siteUrlFor(collection: string, slug: string): string | null {
  switch (collection) {
    case "services": return `/services/${slug}`;
    case "team": return "/about-us#team";        // section of another page → anchor
    case "testimonials": return "/#testimonials"; // section of another page → anchor
    case "faq": return "/#faq";
    case "pages": return PAGE_SLUG_TO_URL[slug] ?? null;
    default: return null;
  }
}
```
