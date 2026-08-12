# conversational-cms

A [Claude Code](https://claude.com/claude-code) skill: add a chat-based content dashboard to a website — a floating overlay where a non-technical site owner describes content changes in plain English, confirms a preview, and the change gets committed via the git host's API and verified live before the dashboard says so.

Extracted from a real build (Astro + Netlify + Netlify Blobs + GitHub Contents API + Anthropic), including the hard-won lessons from debugging it: an SDK that hung silently on serverless, a full-featured LLM request that hung until stripped to bare minimum, eventual-consistency bugs, CSS scoping/specificity traps, and iframe-embedding gotchas — all documented inline so they don't have to be rediscovered on the next build.

Install via [skills.sh](https://skills.sh):

```bash
npx skills add incrhst/conversational-cms
```

See [`SKILL.md`](./SKILL.md) for the full build sequence.
