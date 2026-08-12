---
name: conversational-cms
description: >-
  Add a chat-based content dashboard to a website — a floating overlay
  where a non-technical site owner describes content changes in plain
  English, confirms a preview, and the change gets committed via the git
  host's API and verified live before the dashboard says so. Use when
  asked to "add a conversational CMS", "let the owner edit the site via
  chat", "add an AI content dashboard", "make the site chat-editable", or
  similar. Not for building a general-purpose admin panel/CRUD backend
  unrelated to a specific site's content, and not for integrating a
  headless CMS (Sanity/Contentful/Payload) — this skill's whole point is
  *no* separate CMS, the site's own repo is the source of truth and the
  chat interprets requests against it directly.
---

# Conversational CMS

A floating chat overlay, embedded on the live public site, that lets an
allow-listed owner describe a content change in plain English, see a
plain-language preview, confirm or discard it, and get told (accurately,
via a real deploy check) once it's live. No separate admin URL is the
point — the owner opens it from wherever they're already looking at the
site.

**Reference implementation:** this skill was extracted from a real build
in `lndawkins-site` (Astro + Netlify + Netlify Blobs + GitHub Contents
API + Anthropic). If that repo is available, read the files named at each
step below rather than reinventing the shape — the patterns generalize to
other frameworks/hosts, but the file layout and the gotchas are concrete,
not theoretical. If it isn't available, this document is self-contained.

Every step below produces working code before moving to the next —
this is a build sequence, not a design doc. Confirm the stack (Step 0)
before writing anything.

## Step 0 — Assess the target site before designing anything

Four questions decide almost everything downstream:

1. **How does content actually live in this repo?** File-based (Markdown/YAML
   in a content-collections style directory, like Astro/Next MDX) is the
   easy case — the LLM's "structured edit" maps directly onto a
   file+field. A database-backed CMS changes Step 5 (the "publish"
   mechanism becomes a DB write, not a git commit) but nothing else.
2. **What's the deploy target?** Netlify, Vercel, and similar all expose a
   deploy-status API (Step 6 needs it) and a KV/blob store (Step 3 needs
   it, or bring your own — Redis, a database table, whatever's already
   in the stack).
3. **What's the git host?** GitHub/GitLab/Bitbucket all have a
   "commit a file via REST API" endpoint that returns the new commit's
   SHA — that SHA is what Step 6 polls for. A **serverless function has
   no local `git` binary or SSH agent**, so this has to be a plain HTTPS
   REST call, not a `git` subprocess or an SSH deploy key.
4. **Which LLM provider, and does the target runtime already have a
   working pattern for calling it?** See Step 4's lessons before
   assuming the official SDK will behave the same way here as it does
   locally.

Reference: `wayfinder/tickets/007-hosting-and-git-access.md` in
`lndawkins-site` records the actual reasoning for choosing the GitHub
Contents API over an SSH deploy key on this stack.

## Step 1 — Decide the editable surface, as an explicit whitelist

List every collection/field the owner should be able to touch, and
nothing else. This whitelist lives in two places that must agree:

- The system prompt the LLM sees (Step 4) — tell it *only* about the
  fields on this list, in plain-English terms ("the summary text," "the
  hero photo"), never internal names like "frontmatter" or "slug."
- Server-side validation (Step 5) — **never trust the LLM's claimed
  slug/collection/field as fact.** Validate it against what actually
  exists in the content before writing anything — a hallucinated slug
  should silently fail closed, not write to whatever path it named.
  **Security requirement: reject `__proto__`, `constructor`, and
  `prototype` as field-name segments before using any LLM-supplied
  path** — an unvalidated path string is exactly where a
  prototype-pollution vulnerability hides, so this check exists to
  close that off, not to describe how to exploit it.

Reference: `src/lib/dashboard/field-path.ts` (`FORBIDDEN_KEYS` guard) and
`src/lib/dashboard/content-index.ts` (`slugExists`, `buildContentSummary`)
in `lndawkins-site`.

## Step 2 — Auth: magic link, JWT session, allow-list

- Magic link (email a signed, single-use, short-TTL token) rather than a
  password — this is for one or a handful of named owners, not public
  signup.
- **Two-step confirmation** (a GET that renders a "click to confirm"
  page, which POSTs to actually consume the token) avoids the token
  being silently consumed by an email client's link-prefetcher before
  the human ever clicks it.
- Session = a signed JWT in an HttpOnly cookie. Support **more than one**
  allowed email from the start (a comma-separated env var parsed into a
  list) — a single business often has more than one person who should be
  able to make changes.
- **Re-check the allow-list on every request, in middleware, not just at
  login.** A 30-day session token issued before someone's access was
  revoked must stop working the moment they're removed from the list,
  not 30 days later.

Reference: `src/lib/dashboard/auth.ts` (`createMagicLinkToken`,
`verifySessionToken`, `getAllowedEmails`/`isAllowedEmail`),
`src/middleware.ts`, `src/pages/api/dashboard/verify.ts`.

## Step 3 — Storage: sessions, pending state, quota, conversation history

A KV/blob store (Netlify Blobs, or whatever the host provides) holding:

- **Magic-link jti tracking** — single-use enforcement.
- **Pending preview / pending clarification**, namespaced per email (two
  owners chatting concurrently shouldn't clobber each other's draft).
  Give it a TTL (24h is reasonable) so an abandoned draft doesn't linger
  forever.
- **A monthly change quota**, shared across all owners (it's metering the
  business's usage, not one person's) — a deliberate friction/safety
  layer, not just a cost control. Reset it by computing the current
  calendar period (`YYYY-MM`) as part of the storage key, not with a
  cron job.
- **Conversation history**, if going with the "separate named
  conversations" UX (Step 7) rather than one continuous log: an index
  blob per email (`{id, title, createdAt, updatedAt}[]`, most-recent
  first) plus one messages-blob per conversation. Cap both (e.g. 50
  conversations, 300 messages each) so nothing grows unbounded.

**Gotcha:** most of these stores default to **eventual consistency**.
Anything read back *in the same request* that just wrote it (the classic
case: incrementing the quota, then immediately reading it back to show
"X of Y left") can see the stale pre-write value. Request strong /
read-after-write consistency explicitly for this store, even though it
costs a little latency — infrequent-use tooling like this doesn't feel
it.

Reference: `src/lib/dashboard/storage.ts` — note the `consistency:
"strong"` option on the store, and the comment explaining why.

## Step 4 — The LLM interpretation layer

The LLM's only job is turning "update the machining summary to mention
our new CNC lathe" into a structured description of the edit — it never
touches storage or the git API directly. Design the contract as a fixed
JSON shape with an `action` discriminant (`edit_field`,
`publish_<new-item-type>`, `clarify`, `help`, ...) and require the model
to ask a clarifying question rather than guess when a request is
ambiguous (e.g. "update the summary" when there are three services).

**Every owner-facing string the model writes must be in plain language —
no "collection," "slug," "frontmatter," or other internal vocabulary.**
Say it the way the owner would ("the Machining service page"), not the
way the code does.

### The hard-won lessons — apply these before debugging a hang from scratch

These came from a real, multi-hour debugging arc on Netlify Functions +
Anthropic. They may not all transfer literally to a different host/
provider, but the *pattern* — "start minimal, verify each addition live,
don't assume the SDK behaves the same in serverless as it does locally" —
generalizes regardless of stack.

- **If a request from the official SDK hangs with zero error surfaced**
  (not a timeout, not a caught exception — just never resolves, until
  the platform's own hard-kill ends the function), try a raw `fetch` to
  the same REST endpoint before anything else. This fixed it completely
  in the reference build; the root cause in the SDK's HTTP client
  construction on that specific runtime was never conclusively
  identified, and didn't need to be once fetch worked reliably.
- **Start the request as bare as possible and add features back one at a
  time, testing live after each.** Plain string system/user content, no
  prompt caching, no extended-thinking mode, no structured-output
  schema. A request combining caching + thinking + structured output
  hung reliably in the reference build; caching alone, added back later
  in isolation, was completely fine. The full-featured combination was
  the actual problem, not any single piece of it — but you can't know
  which piece without testing them separately.
- **If not using structured-output enforcement, prompt for raw JSON
  explicitly** ("respond with ONLY a single raw JSON object matching
  this shape...") and strip markdown code fences defensively when
  parsing the response — models occasionally wrap JSON in a fence
  despite being told not to.
- **A single capped attempt, no retry, with a timeout comfortably under
  the platform's hard-kill limit.** A retry can double the worst-case
  latency and get killed mid-retry with no error surfaced at all — one
  attempt guarantees the function always resolves to *something*,
  success or a real caught error.
- **If using prompt caching, verify actual cache hits from the
  response's usage/token fields** (`cache_creation_input_tokens` /
  `cache_read_input_tokens` on Anthropic's Messages API) — don't just
  trust that setting a `cache_control` breakpoint worked. Log it, at
  least while confirming the change, since "the request succeeded" and
  "the request is actually using the cache" are different claims.

Reference: `src/lib/dashboard/llm.ts` in `lndawkins-site` — the file's own
leading comment documents the debugging trail; `wayfinder/HANDOFF.md`
has the full blow-by-blow if the summary here isn't enough.

## Step 5 — The publish flow: preview, confirm/discard, commit

1. LLM returns a structured edit → validate it against real content
   (Step 1) → build the new file content → store it as a **pending
   preview** (Step 3) with a plain-language summary — don't write
   anything yet.
2. Show the owner the summary and ask for confirmation. **Use tappable
   Yes/No buttons, not "reply yes or no" text parsing** — but wire the
   buttons to submit through the *exact same code path* as a typed
   reply (factor the send-logic into one function both call), don't fork
   the logic. A stray "ok thanks" while a preview is pending should
   discard it *with an explanation*, not silently drop it or silently
   ignore the new message.
3. On confirm: write the file(s) via the git host's Contents-API-style
   endpoint (or the DB, if Step 0 established this isn't file-based).
   **Capture the commit SHA the write returns** — Step 6 needs it. If a
   single confirm touches more than one file (an image plus its
   referencing content file, say), each write is its own commit; track
   whichever happens *last*, since Step 6 only needs to confirm the
   final commit in the chain to know everything before it is live too.
4. Increment the quota (Step 3) *after* a successful write, not before —
   a failed write shouldn't cost the owner a quota slot.
5. Enforce the quota before step 3 runs: if it's exhausted, say so
   plainly and explain when it resets, rather than silently failing or
   (worse) writing anyway.

Reference: `src/pages/api/dashboard/chat.ts` (`confirmPreview`,
`handleEditField`, the `awaitingConfirmation` response flag),
`src/lib/dashboard/github.ts` (`putTextFile`/`putBinaryFile` returning
the commit SHA), `src/lib/dashboard/content-writer.ts`.

## Step 6 — Deploy-status verification and a live preview

"Committed" isn't "live" — most hosts take anywhere from a few seconds to
a couple of minutes to build and publish. Close that gap instead of
guessing at a fixed wait:

1. A lightweight endpoint that checks the host's deploy API (Netlify:
   `GET /api/v1/sites/{site_id}`, `published_deploy.commit_ref` +
   `.state`) and compares it against the commit SHA from Step 5. Needs a
   host API token — store it as a secret env var, scoped as narrowly as
   the host allows.
2. After confirming, the client polls that endpoint every few seconds
   (with a generous ceiling — three minutes is reasonable) and shows a
   loading indicator while it waits, not silence. On timeout, say so
   honestly ("that's taking longer than usual — it's likely still live,
   check back shortly") rather than leaving the owner staring at nothing.
3. Once confirmed live, resolve which public URL the change landed on
   (a small `collection → path` mapping — most collections map to their
   own page; some, like testimonials or FAQ, are a section of another
   page and need an anchor) and show a compact preview of that exact
   page — an embedded iframe is the simplest version of this — instead
   of just a text confirmation.

If the host API token itself can expire, don't let that fail silently
months later: a scheduled function that checks a tracked expiry date
against today and emails a plain-language warning at a few thresholds
(90/30/7/1 days out) before it happens, deduped so it fires once per
threshold rather than daily.

Reference: `src/pages/api/dashboard/deploy-status.ts`, the
`pollDeployStatus`/`addPagePreview` functions in
`src/pages/dashboard/index.astro`, `siteUrlFor` in
`src/lib/dashboard/content-index.ts`, and
`netlify/functions/token-expiry-check.mts` for the optional expiry
warning (a plain Netlify Scheduled Function, `export const config = {
schedule: "@daily" }` — independent of the Astro app, runs whether or not
anyone visits the dashboard).

## Step 7 — The chat UI itself

A standalone page (`/dashboard` or similar) is the foundation; Step 8
embeds it as a widget on top of that, so build this first and get it
right standalone.

- **Layout: header pinned top, composer pinned bottom, only the message
  log scrolls.** The reliable way to get this is constraining the page's
  root element to the actual viewport height (`height: 100dvh; overflow:
  hidden;`) rather than `min-height` — a `min-height` lets the whole page
  grow past the viewport once content overflows, and then the *whole
  page* scrolls instead of just the log, taking the header and composer
  with it. This matters even more inside Step 8's iframe, where the
  "viewport" is a short, fixed-height panel.
- **Confirm/discard as buttons** (Step 5) rendered under the relevant bot
  message, disabled once answered; any earlier pending button row goes
  stale (disable it) the moment a new message goes out, since only one
  preview can be pending server-side at a time.
- **If the framework has component-scoped CSS (Astro, Vue SFCs, etc.),
  and any of the page's DOM is created by client-side JS** (chat bubbles
  appended via `document.createElement`, dynamically-built dropdown
  menus) — scoped styles typically only stamp their selector-scoping
  attribute onto elements written directly in the template at
  build/render time, **not** onto anything a `<script>` creates
  afterward. Those dynamically-created elements silently don't match the
  scoped rules, no matter what styles are declared. If this page's DOM
  is substantially client-JS-driven, mark its styles global instead of
  fighting the scoping mechanism per-element (safe when the page is a
  standalone document, not a shared layout component other pages
  render).
- **CSS specificity trap with `hidden` + `display`:** if an element is
  toggled via the `hidden` attribute *and* also has a `display: <value>`
  declared directly on its own ID/class selector, that declaration can
  beat the browser's built-in `[hidden] { display: none }` on
  specificity (an ID/class selector outranks an attribute selector) —
  the element stays visible, and can block clicks on the page behind it,
  even while `hidden` is set. Scope any such `display` declaration to
  `:not([hidden])` instead of the bare selector.
- **Progressive disclosure over cramming everything into the header.**
  Iterating toward "as clean as possible" in the reference build ended
  at: a single hamburger-style icon that opens a slide-out drawer holding
  conversation history, new-chat, settings/logout, and a small usage
  gauge — not a header full of buttons and a persistent status strip.
  Worth designing toward directly rather than incrementally decluttering
  a crowded header after the fact.

Reference: `src/pages/dashboard/index.astro` — the whole file, but
particularly the `body { height: 100dvh; overflow: hidden; }` rule and
its comment, the `style is:global` on the page's `<style>` tag, the
`#drawer`/`#drawer-backdrop` markup and CSS, and
`addConfirmButtons`/`invalidateConfirmButtons` in the script.

## Step 8 — Embedding it on the live site as a widget

The standalone dashboard page, wrapped in a floating overlay that any
public page can open:

1. **A cheap, auth-only endpoint** (`/api/.../whoami` or similar) that
   just checks the session cookie and returns `{loggedIn}` — no
   database/blob reads, since it runs on every public page load for
   every visitor. If public pages are statically prerendered (common for
   marketing sites), this check **must** happen client-side after page
   load, not server-side per request — there's no per-request server
   context to check a cookie against on a static page.
2. **A toggle button, hidden by default**, revealed only once that check
   confirms a logged-in session — so it renders nothing at all for
   anonymous visitors, not even in the DOM meaningfully (verify this: a
   panel that's supposed to be hidden but isn't is a real, embarrassing
   bug class — see the `hidden`/`display` specificity trap in Step 7,
   which applies doubly here since this panel sits on every public page).
3. **Load the dashboard lazily** (`iframe.src` set on first open, not on
   page load) — most page loads by a logged-in owner won't open it, no
   reason to fetch the whole dashboard bundle every time.
4. **Don't give the overlay wrapper its own floating close button
   layered on top of the iframe's content.** The embedded dashboard has
   its own header controls, and the two are separate documents with no
   way to coordinate layout with each other — a close button floating
   over the iframe will eventually collide with whatever the embedded
   page puts in that same corner. Give the wrapper a slim dedicated bar
   *above* the iframe instead (same background color as the embedded
   page's own header, so it reads as one continuous bar, not a second
   header stacked on the first).
5. Add the widget to whatever shared layout every public page already
   renders through — one component, one place.

Reference: `src/components/DashboardWidget.astro`,
`src/pages/api/dashboard/whoami.ts`, and its inclusion point in
`src/layouts/Layout.astro`.

## Output checklist

Before calling this done: an owner can log in via magic link on a device
that's never seen the session before; a removed email loses access
immediately, not after 30 days; two owners chatting at once don't
clobber each other's pending change; a confirmed edit shows up as a real
commit with the right message; the dashboard actually waits for and
confirms the deploy rather than guessing at a fixed delay; the widget is
invisible and inert for a logged-out visitor (check this by loading a
public page in a private/incognito window, not just by reading the
code); the header takes up as little space as the pattern in Step 7
allows; and every one of the gotchas in Steps 4 and 7 has been checked
against, not assumed away because "it probably won't happen here."
