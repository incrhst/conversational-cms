# Gotchas

Every entry here cost real debugging time in the reference build. The
LLM-request and consistency gotchas are Netlify + Anthropic specific in
their concrete detail (see `references/hosts.md` for what's verified vs.
conceptual on other stacks) — but the *shape* of each ("an SDK behaving
differently in serverless than locally," "a store defaulting to eventual
consistency," "scoped styles not reaching client-created DOM") is a
pattern worth checking for regardless of stack.

## LLM calls on serverless

**If a request from the official SDK hangs with zero error surfaced** —
not a timeout, not a caught exception, just never resolves until the
platform's own hard-kill ends the function — try a raw `fetch` to the
same REST endpoint before anything else. This fixed it completely in the
reference build (Netlify Functions + `@anthropic-ai/sdk`); the root
cause in the SDK's HTTP client construction on that specific runtime was
never conclusively identified, and didn't need to be once fetch worked
reliably. Diagnostic sequence that got there, in case a different hang
needs the same treatment: add timestamped logs around the call to
confirm it's the LLM request specifically (not something upstream)
→ rule out retry-math bugs (below) → try a raw bodyless GET to the same
host to rule out generic network/DNS failure → try a raw POST with the
full real body via plain `fetch` → if that succeeds where the SDK call
hangs, the SDK is the variable, not the network or the request content.

**Start the request as bare as possible, add features back one at a
time, test live after each.** Plain string system/user content, no
prompt caching, no extended-thinking mode, no structured-output schema.
A request combining caching + thinking + structured output hung
reliably in the reference build; caching alone, added back later in
isolation, was completely fine. The full-featured *combination* was the
actual problem, not any single piece of it — but there's no way to know
which piece without testing them separately. If not using
structured-output enforcement, prompt for raw JSON explicitly ("respond
with ONLY a single raw JSON object matching this shape...") and strip
markdown code fences defensively when parsing the response — models
occasionally wrap JSON in a fence despite being told not to.

**A single capped attempt, no retry, with a timeout comfortably under
the platform's hard-kill limit.** A retry can double the worst-case
latency and get killed mid-retry with no error surfaced at all — one
attempt guarantees the function always resolves to *something*, success
or a real caught error, well inside the platform's own ceiling. (The
reference build's first real bug here: `{timeout: 18_000, maxRetries:
1}` could total 36s against a ~30s hard kill — fixed to `{timeout:
12_000, maxRetries: 0}`, which is what first surfaced a real caught
error instead of a silent kill.)

**If using prompt caching, verify actual cache hits from the response's
usage/token fields** (`cache_creation_input_tokens` /
`cache_read_input_tokens` on Anthropic's Messages API) — don't just
trust that setting a `cache_control` breakpoint worked. Log it, at least
while confirming the change, since "the request succeeded" and "the
request is actually using the cache" are different claims. A cache
breakpoint needs a minimum prompt length to actually engage (roughly
1024 tokens for most current models) — a short system prompt can set
`cache_control` and simply never produce a cache write, silently.

## Storage consistency

Most KV/blob stores (Netlify Blobs included) default to **eventual
consistency**. Anything read back *in the same request* that just wrote
it — the classic case: incrementing a quota counter, then immediately
reading it back to show "X of Y left" — can see the stale pre-write
value. Request strong / read-after-write consistency explicitly for
this store (Netlify Blobs: `getStore({ name, consistency: "strong" })`),
even though it costs a little latency — infrequent-use tooling like this
doesn't feel it.

## CSS: scoped styles and client-created DOM

If the framework has component-scoped CSS (Astro's `<style>` blocks,
Vue SFCs, CSS Modules with a runtime scoping step) — scoped styles
typically only stamp their selector-scoping attribute/class onto
elements written directly in the *template*, at build/render time. Any
element a `<script>` creates afterward (`document.createElement`,
appended chat bubbles, dynamically-built dropdown menus) silently
doesn't match the scoped rules, no matter what's declared for that
selector. The failure mode is quiet: the styles "exist," the class names
match, nothing errors — the elements just never actually receive the
background/border/whatever was declared. If the page's DOM is
substantially client-JS-driven (a chat log is), mark its styles global
(Astro: `<style is:global>`) rather than fighting the scoping mechanism
element-by-element — safe when the page is a standalone document, not a
shared layout component other pages also render through.

## CSS: the `hidden` + `display` specificity trap

An element toggled via the HTML `hidden` attribute relies on the
browser's built-in `[hidden] { display: none }` rule. If that same
element's own ID or class selector *also* declares a `display` value
(`#panel { display: flex; ... }`), the ID/class selector outranks the
attribute selector on specificity — so the element's `display` stays
whatever that rule says, and `hidden` has no visible effect, even though
the attribute is genuinely present in the DOM. Consequences aren't just
cosmetic: a "closed" panel that's actually still `display: flex` and
`position: fixed` covers its normal footprint and **blocks clicks on
whatever's supposed to be behind it**. Fix: scope the `display`
declaration to `:not([hidden])` instead of the bare selector —
`#panel:not([hidden]) { display: flex; }` — so the browser's own hidden
behavior wins until the script explicitly overrides it.

## Iframe embedding: two documents can't coordinate layout

If the chat dashboard is embedded both standalone (its own route) and
inside an iframe/overlay on the main site (Step 8), don't give the
overlay wrapper its own floating close button positioned on top of the
iframe's content. The embedded page has its own header/controls, and
they're two entirely separate documents — there's no shared layout
context, so a close button floating at (say) top-right of the wrapper
will eventually land in the exact same corner as whatever the embedded
page puts there, with no way for either side to know about the other.
Give the wrapper a slim, dedicated bar *above* the iframe instead — same
background color as the embedded page's own header, so the two read as
one continuous bar rather than a second header stacked on the first.

Also: a `position: fixed` element declared *inside* the iframe's own
page establishes its fixed positioning relative to the iframe's own
viewport (its allocated width/height as an element on the parent page),
not the outer browser window — this is usually what's wanted (a status
badge that stays pinned within the panel), but is worth confirming
explicitly if a "floating" element inside the embedded page seems to be
positioning against the wrong box.

## Layout: constrain height, don't just set a minimum

For a header-pinned-top / composer-pinned-bottom / only-the-log-scrolls
chat layout, constrain the page's root element to the actual viewport
height (`height: 100dvh; overflow: hidden;`) rather than `min-height`. A
`min-height` lets the whole page grow past the viewport once content
overflows, and then the *whole page* scrolls instead of just the
message log — taking the header and composer with it. This is easy to
miss on a full browser window (there's usually enough vertical space
that it doesn't visibly break) and much more visible inside an iframe
panel, where the "viewport" is a short, fixed height to begin with.

## Auth: magic-link prefetching

Email clients and some browsers prefetch links in an email body before
the human clicks anything (link-scanning for safety/preview purposes).
A magic link that's consumed on first `GET` gets silently burned by this
prefetch, and the real click then fails with "link expired" for no
visible reason. Fix: make the `GET` render a "click to confirm" page
with its own button, and only *consume* the token on the resulting
`POST` — the prefetch loads the confirm page (harmless, doesn't consume
anything) but never submits the form.
