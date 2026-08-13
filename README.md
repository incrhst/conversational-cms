# conversational-cms

An agentic skill for adding a chat-based content dashboard to any website. It embeds a floating overlay where a non-technical site owner describes content changes in plain English, previews and confirms the diff, and the change is committed via the git host's API and verified live before the dashboard confirms.

No separate CMS backend (Sanity, Contentful, Payload) or database required — the website's repository is the single source of truth.

---

## Installation

Install into your AI coding agent (Claude Code, Antigravity, etc.) via [skills.sh](https://skills.sh):

```bash
npx skills add incrhst/conversational-cms
```

---

## How It Works

```text
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│   Site Owner    │ ────> │ Floating Widget │ ────> │    LLM Layer    │
│ (Plain English) │       │ (/dashboard)    │       │ (Structured)    │
└─────────────────┘       └─────────────────┘       └────────┬────────┘
                                                             │
┌─────────────────┐       ┌─────────────────┐       ┌────────▼────────┐
│  Live Website   │ <──── │  Git Host API   │ <──── │  Owner Preview  │
│ (Polled status) │       │ (Direct Commit) │       │ (Confirm Diff)  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

1. **Owner Authentication:** Secure, passwordless magic links with scanner-prefetch protection and per-request allow-list verification.
2. **Plain-English Requests:** The site owner describes edits in natural language (e.g., *"Update our machining service description to highlight precision aerospace parts"*).
3. **Grounded LLM Interpretation:** The LLM interprets the request against a lightweight content digest and outputs structured JSON conforming to an explicit field whitelist.
4. **Human-in-the-Loop Confirmation:** A plain-language preview shows the exact field and content changes. No commit happens without explicit owner approval.
5. **Direct Git API Commit:** Commits updated Markdown/YAML files directly via REST API (e.g., GitHub Contents API) — no local `git` binary or SSH keys needed on serverless.
6. **Real Deploy Verification:** Polls the hosting platform's deploy API (e.g., Netlify) to confirm the new commit is published and live before notifying the owner.

---

## Key Highlights & Hardened Gotchas

Extracted from real-world production builds and hardened against edge cases:

- **Indirect Prompt Injection Defense (W011):** Strict XML boundary encapsulation and defensive system prompt framing ensure pasted third-party content (e.g., customer quotes, emails) cannot hijack LLM instructions.
- **Serverless-Safe LLM Calls:** Built-in guidance for avoiding silent SDK hangs, feature-stacking bottlenecks, and runaway retry timeouts on serverless runtimes.
- **Strong Consistency Guarantees:** Solves KV/blob store read-after-write caching anomalies during quota and state updates.
- **Magic Link Prefetch Safety:** Two-step verification flow prevents corporate email scanners from consuming single-use login tokens on initial `GET` requests.
- **CSS Scoping & Specificity Fixes:** Resolves client-rendered DOM styling issues in scoped frameworks (like Astro/Vue) and fixes the `[hidden]` display specificity trap.

---

## What's Included

See [`SKILL.md`](./SKILL.md) for the complete, self-contained implementation sequence:

- **Step 0:** Target Site & Stack Assessment
- **Step 1:** Whitelist & Content Digest Specification
- **Step 2:** Auth & Session Middleware
- **Step 3:** Storage Key Shapes & Quota Management
- **Step 4:** LLM Interpretation Contracts & Injection Defenses
- **Step 5:** Preview, Confirmation, and Git API Commit Flow
- **Step 6:** Deploy-Status Verification & Polling
- **Step 7:** Chat UI Layout & Gotchas
- **Step 8:** Overlay Widget Embedding
- **Output Checklist:** End-to-end verification items
