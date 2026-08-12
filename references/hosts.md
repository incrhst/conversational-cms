# Host/git/LLM matrix

Step 0 asks four questions (content model, deploy host, git host, LLM
provider). This file gives concrete starting points for each answer.

**Honesty note:** the Netlify section below is verified against a real
production build — exact endpoints, response shapes, and failure modes
that were actually hit and fixed. The other hosts' sections describe the
*conceptually equivalent* mechanism (every major host has something like
this) but their exact endpoint paths/response shapes have not been
verified against a real build in this skill's history — confirm them
against current provider docs before relying on them, and expect to
adjust field names.

## Deploy target

### Netlify — verified

- **Deploy status:** `GET https://api.netlify.com/api/v1/sites/{site_id}`
  with `Authorization: Bearer <personal access token>`. Response
  includes `published_deploy.commit_ref` (the SHA currently live) and
  `published_deploy.state` (`"ready"` when fully published). Compare
  `commit_ref` against the SHA a commit returned and `state === "ready"`
  before calling something live.
- **KV/blob store:** `@netlify/blobs`, `getStore({ name, consistency:
  "strong" })` — see `references/gotchas.md` for why the consistency
  option matters.
- **Scheduled functions** (for the optional credential-expiry warning in
  Step 6): a plain function file under `netlify/functions/`, `export
  const config = { schedule: "@daily" }` (cron syntax also works). Runs
  independently of the main app — no dashboard visit required to trigger
  it. Reads env vars via `process.env`, not `import.meta.env` (that's a
  Vite/framework-build-time thing; a scheduled function isn't part of
  that build).
- **Site ID:** `netlify status` (CLI) or the site's own Netlify
  dashboard URL shows it; not secret, safe to reference directly in code
  even though it's usually still worth an env var for portability.

### Vercel — conceptual, not verified here

- **Deploy status:** Vercel's REST API exposes deployment state via
  `GET https://api.vercel.com/v13/deployments/{id}` or by listing
  deployments filtered by git SHA — confirm the exact query shape
  against current Vercel API docs; this skill hasn't verified it
  end-to-end.
- **KV/blob store:** Vercel KV (Redis-compatible) or Vercel Blob —
  check current consistency guarantees explicitly rather than assuming
  strong-by-default.
- **Scheduled jobs:** Vercel Cron Jobs, configured in `vercel.json`
  rather than a per-function export.

### Other static hosts (Cloudflare Pages, Render, etc.)

Same three questions apply — does the host expose a deploy-status API
keyed by commit SHA, what's the KV/store option and its consistency
model, and does it support scheduled/cron functions independent of the
main app. If any answer is "no," that piece needs a different
mechanism (e.g. no deploy-status API at all → fall back to a fixed,
clearly-labeled "usually live within N minutes" estimate instead of
Step 6's real polling, and say so honestly to the owner rather than
faking a confirmation).

## Git host

All three major hosts expose a "commit a file via REST API" endpoint
that returns the new commit's SHA — the general shape ("send path +
new content + branch + optional expected-sha-for-updates, get back a
commit object") is consistent across them, but request/response field
names differ:

- **GitHub:** Contents API, `PUT
  /repos/{owner}/{repo}/contents/{path}` — verified in the reference
  build. Response's `commit.sha` is the SHA to poll for in Step 6.
  Requires a fine-grained PAT scoped to the one repo, `contents: write`
  permission only.
- **GitLab:** Repository Files API, similar shape
  (`POST/PUT /projects/:id/repository/files/:file_path`) — not verified
  here, confirm exact response field for the resulting commit SHA.
- **Bitbucket:** has an equivalent Source API — not verified here.

Whichever host: a serverless function has no local `git` binary or SSH
agent, so this must be a plain HTTPS REST call, not a `git` subprocess
or an SSH deploy key (the reference build tried the deploy-key approach
first and abandoned it for exactly this reason — see
`wayfinder/tickets/007-hosting-and-git-access.md` in `lndawkins-site` if
available).

## LLM provider

- **Anthropic (Claude)** — verified in the reference build, including
  every gotcha in `references/gotchas.md`'s "LLM calls on serverless"
  section. Messages API, raw `fetch`, response text in
  `content[0].text`.
- **OpenAI-compatible (OpenAI, and most "OpenAI-compatible" hosted
  models)** — different response shape
  (`choices[0].message.content`), and this skill has not verified
  whether the same serverless-hang pattern applies to the OpenAI SDK
  specifically. Treat the "start bare, test live, add features back one
  at a time" methodology as the thing to bring over, not an assumption
  that OpenAI's SDK has the identical bug.
- **BYO-provider (letting the site owner pick):** abstract the call
  behind a small interface (`interpret(prompt, contentSummary): Promise<Interpretation>`)
  with one adapter per provider, rather than branching provider-specific
  parsing throughout the request-handling code. Worth doing only if
  there's a concrete reason (cost comparison, redundancy, owner
  preference) — otherwise it's a permanent maintenance surface (two
  prompt-engineering targets, two failure modes) for a feature that's
  typically used a handful of times a month.
