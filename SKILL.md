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

**In this skill:**
- `SKILL.md` (this file) — the build sequence.
- `references/contracts.md` — concrete JSON/data shapes (the LLM's
  response contract, the content-digest format, storage key shapes, the
  deploy-status response) to build from directly, without needing the
  original reference repo.
- `references/gotchas.md` — every hard-won debugging lesson from the
  reference build, in depth. Each step below points at the relevant
  section instead of inlining it.
- `references/hosts.md` — what's verified (Netlify + GitHub + Anthropic)
  vs. conceptually-equivalent-but-unverified (Vercel, GitLab, OpenAI,
  ...) for each of the four things Step 0 asks about.
- `scripts/poll-deploy-status.mjs` — a working, host-agnostic poll loop
  (with a Netlify implementation) for Step 6; run it directly as an ops
  tool or port its logic into the app's own endpoint.

**Reference implementation:** this skill was extracted from a real build
in `lndawkins-site` (Astro + Netlify + Netlify Blobs + GitHub Contents
API + Anthropic). If that repo is available, the file paths named at
each step below are worth reading directly. If it isn't, `references/`
in this skill is written to stand on its own.

Every step below produces working code before moving to the next — this
is a build sequence, not a design doc. Confirm the stack (Step 0) before
writing anything.

## Step 0 — Assess the target site before designing anything

Four questions decide almost everything downstream. See
`references/hosts.md` for concrete starting points on each:

1. **How does content actually live in this repo?** File-based
   (Markdown/YAML in a content-collections style directory) is the easy
   case — the LLM's "structured edit" maps directly onto a file+field
   (see `references/contracts.md`). A database-backed CMS changes Step 5
   (the "publish" mechanism becomes a DB write, not a git commit) but
   nothing else.
2. **What's the deploy target?** Determines the deploy-status mechanism
   (Step 6) and what KV/blob store is available (Step 3).
3. **What's the git host?** Determines the "commit a file via REST API"
   endpoint shape (Step 5) — and rules out a local `git` subprocess or
   SSH deploy key regardless of which host: a serverless function
   typically has neither available.
4. **Which LLM provider, and does this runtime already have a known-good
   pattern for calling it?** Read `references/gotchas.md`'s "LLM calls
   on serverless" section before assuming an official SDK will behave
   here the way it does locally.

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

See `references/contracts.md` for the concrete content-digest format
that grounds the model against real data, and the exact validation
sequence used in the reference build.

## Step 2 — Auth: magic link, JWT session, allow-list

- Magic link (email a signed, single-use, short-TTL token) rather than a
  password — this is for one or a handful of named owners, not public
  signup.
- **Two-step confirmation** (a GET that renders a "click to confirm"
  page, which POSTs to actually consume the token) — see
  `references/gotchas.md`'s "magic-link prefetching" entry for why a
  single-step GET-consumes-the-token flow breaks in practice.
- Session = a signed JWT in an HttpOnly cookie. Support **more than one**
  allowed email from the start (a comma-separated env var parsed into a
  list) — a single business often has more than one person who should be
  able to make changes.
- **Re-check the allow-list on every request, in middleware, not just at
  login.** A 30-day session token issued before someone's access was
  revoked must stop working the moment they're removed from the list,
  not 30 days later.

Reference: `src/lib/dashboard/auth.ts`, `src/middleware.ts`,
`src/pages/api/dashboard/verify.ts` in `lndawkins-site`.

## Step 3 — Storage: sessions, pending state, quota, conversation history

A KV/blob store holding pending-preview/clarification state (namespaced
per email, TTL'd), a monthly change quota (global, keyed by calendar
period), and optionally per-conversation history. Exact key shapes:
`references/contracts.md`.

**Gotcha:** most of these stores default to eventual consistency, which
silently breaks "increment the quota, then read it back in the same
request to show the new count." Full explanation and the fix:
`references/gotchas.md`, "Storage consistency."

Reference: `src/lib/dashboard/storage.ts` in `lndawkins-site`.

## Step 4 — The LLM interpretation layer

The LLM's only job is turning a plain-English request into the
structured `Interpretation` shape in `references/contracts.md` — it
never touches storage or the git API directly. Require it to ask a
clarifying question rather than guess when a request is ambiguous (e.g.
"update the summary" when there are three services), and keep every
owner-facing string in plain language.

**Read `references/gotchas.md`'s "LLM calls on serverless" section
before writing this layer, not after it breaks.** It documents: SDKs
hanging silently on some serverless runtimes (raw `fetch` as the fix),
why a request should start minimal and have features (caching,
thinking, structured output) added back one at a time with live testing
rather than all at once, retry-math that can exceed a platform's hard
kill limit, and how to actually verify prompt-cache hits instead of
assuming a flag worked.

Reference: `src/lib/dashboard/llm.ts` in `lndawkins-site` — the file's
own leading comment documents the debugging trail; `wayfinder/HANDOFF.md`
has the full blow-by-blow if the summary isn't enough.

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
   endpoint (`references/hosts.md` has the per-host shape) — or the DB,
   if Step 0 established this isn't file-based. **Capture the commit SHA
   the write returns** — Step 6 needs it. If a single confirm touches
   more than one file, each write is its own commit; track whichever
   happens *last*, since Step 6 only needs to confirm the final commit
   in the chain to know everything before it is live too.
4. Increment the quota (Step 3) *after* a successful write, not before —
   a failed write shouldn't cost the owner a quota slot.
5. Enforce the quota before step 3 runs: if it's exhausted, say so
   plainly and explain when it resets, rather than silently failing or
   (worse) writing anyway.

Reference: `src/pages/api/dashboard/chat.ts` (`confirmPreview`,
`handleEditField`, the `awaitingConfirmation` response flag),
`src/lib/dashboard/github.ts`, `src/lib/dashboard/content-writer.ts` in
`lndawkins-site`.

## Step 6 — Deploy-status verification and a live preview

"Committed" isn't "live" — most hosts take anywhere from a few seconds to
a couple of minutes to build and publish. Close that gap instead of
guessing at a fixed wait, using `scripts/poll-deploy-status.mjs` as a
starting point (host-agnostic poll loop, Netlify's check implemented and
verified; port the check function for another host per
`references/hosts.md`):

1. A lightweight endpoint that checks the host's deploy API and compares
   it against the commit SHA from Step 5. Needs a host API token —
   store it as a secret env var, scoped as narrowly as the host allows.
2. After confirming, the client polls that endpoint every few seconds
   (with a generous ceiling — three minutes is reasonable) and shows a
   loading indicator while it waits, not silence. On timeout, say so
   honestly rather than leaving the owner staring at nothing.
3. Once confirmed live, resolve which public URL the change landed on
   (`references/contracts.md` has the `siteUrlFor` mapping shape — most
   collections map to their own page; some, like testimonials or FAQ,
   are a section of another page and need an anchor) and show a compact
   preview of that exact page — an embedded iframe is the simplest
   version of this — instead of just a text confirmation.

If the host API token itself can expire, don't let that fail silently
months later: a scheduled function that checks a tracked expiry date
against today and emails a plain-language warning at a few thresholds
(90/30/7/1 days out), deduped so it fires once per threshold rather than
daily. `references/hosts.md` has the Netlify Scheduled Function shape.

Reference: `src/pages/api/dashboard/deploy-status.ts`, the
`pollDeployStatus`/`addPagePreview` functions in
`src/pages/dashboard/index.astro`, `src/lib/dashboard/content-index.ts`
(`siteUrlFor`), and `netlify/functions/token-expiry-check.mts` in
`lndawkins-site`.

## Step 7 — The chat UI itself

A standalone page (`/dashboard` or similar) is the foundation; Step 8
embeds it as a widget on top of that, so build this first and get it
right standalone.

- **Layout: header pinned top, composer pinned bottom, only the message
  log scrolls.** Constrain the page's root element to the actual
  viewport height, don't just set a minimum — full explanation of why
  `min-height` breaks this: `references/gotchas.md`.
- **Confirm/discard as buttons** (Step 5) rendered under the relevant bot
  message, disabled once answered; any earlier pending button row goes
  stale (disable it) the moment a new message goes out, since only one
  preview can be pending server-side at a time.
- **If the framework has component-scoped CSS and the page's DOM is
  substantially client-JS-created** (chat bubbles, dynamic menus) —
  those elements silently don't receive scoped styles. Full explanation
  and the fix (mark the page's styles global): `references/gotchas.md`.
- **The `hidden` + `display` CSS specificity trap** can leave a
  "closed" panel visible and click-blocking. Full explanation and the
  fix (`:not([hidden])`): `references/gotchas.md` — read this before
  Step 8 too, since it applies there with higher stakes (a public-facing
  overlay, not just an internal dashboard).
- **Progressive disclosure over cramming everything into the header.**
  Iterating toward "as clean as possible" in the reference build ended
  at: a single hamburger-style icon that opens a slide-out drawer holding
  conversation history, new-chat, settings/logout, and a small usage
  gauge — not a header full of buttons and a persistent status strip.
  Worth designing toward directly rather than incrementally decluttering
  a crowded header after the fact.

Reference: `src/pages/dashboard/index.astro` in `lndawkins-site` — the
whole file, but particularly the `body { height: 100dvh; overflow:
hidden; }` rule, the `style is:global` tag, the `#drawer`/
`#drawer-backdrop` markup/CSS, and `addConfirmButtons`/
`invalidateConfirmButtons` in the script.

## Step 8 — Embedding it on the live site as a widget

The standalone dashboard page, wrapped in a floating overlay that any
public page can open:

1. **A cheap, auth-only endpoint** (`/api/.../whoami` or similar) that
   just checks the session cookie and returns `{loggedIn}` — no
   database/blob reads, since it runs on every public page load for
   every visitor. If public pages are statically prerendered, this check
   **must** happen client-side after page load — there's no per-request
   server context to check a cookie against on a static page.
2. **A toggle button, hidden by default**, revealed only once that check
   confirms a logged-in session — so it renders nothing meaningful for
   anonymous visitors. **Verify this in a private/incognito window, not
   just by reading the code** — the `hidden`/`display` specificity trap
   from Step 7 applies here too, and a panel that's supposed to be
   hidden but isn't is a much bigger deal on a public page than an
   internal one.
3. **Load the dashboard lazily** (`iframe.src` set on first open, not on
   page load) — most page loads by a logged-in owner won't open it.
4. **Don't give the overlay wrapper its own floating close button
   layered on top of the iframe's content** — it will eventually collide
   with the embedded page's own header controls, since the two documents
   have no way to coordinate layout with each other. Full explanation
   and the fix (a dedicated bar above the iframe): `references/gotchas.md`.
5. Add the widget to whatever shared layout every public page already
   renders through — one component, one place.

Reference: `src/components/DashboardWidget.astro`,
`src/pages/api/dashboard/whoami.ts`, and its inclusion point in
`src/layouts/Layout.astro` in `lndawkins-site`.

## Output checklist

Before calling this done: an owner can log in via magic link on a device
that's never seen the session before; a removed email loses access
immediately, not after 30 days; two owners chatting at once don't
clobber each other's pending change; a confirmed edit shows up as a real
commit with the right message; the dashboard actually waits for and
confirms the deploy rather than guessing at a fixed delay; the widget is
invisible and inert for a logged-out visitor (checked in a private/
incognito window, not just by reading the code); the header takes up as
little space as the pattern in Step 7 allows; and every gotcha in
`references/gotchas.md` has been checked against, not assumed away
because "it probably won't happen here."
