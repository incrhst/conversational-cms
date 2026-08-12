#!/usr/bin/env node
// Poll a host's deploy API until a specific commit SHA is the live, published
// deploy — or a timeout is reached. Two uses:
//
//   1. Run it directly as an ops tool while manually verifying a change went
//      live (this is the literal loop used throughout this skill's reference
//      build to confirm deploys during development):
//
//        NETLIFY_SITE_ID=... NETLIFY_API_TOKEN=... \
//          node poll-deploy-status.mjs <commit-sha>
//
//   2. Port the `checkNetlifyDeployStatus` function into the app's own
//      /api/.../deploy-status endpoint (Step 6) — same check, called from a
//      short-lived HTTP handler instead of a long-lived CLI loop, since a
//      serverless function can't hold a 3-minute poll open itself.
//
// Only Netlify is implemented here (verified against a real build — see
// references/hosts.md). Adapt checkDeployStatus for another host by
// replacing the body of that one function; everything else (the poll loop,
// the timeout/interval handling, the CLI wrapper) is host-agnostic.

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

async function checkNetlifyDeployStatus(commitSha, { siteId, apiToken }) {
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Netlify API returned ${res.status}: ${await res.text()}`);
  }
  const site = await res.json();
  return {
    live: site.published_deploy?.commit_ref === commitSha && site.published_deploy?.state === "ready",
    currentRef: site.published_deploy?.commit_ref,
    state: site.published_deploy?.state,
  };
}

/**
 * @param {string} commitSha - the commit that must become the published deploy
 * @param {() => Promise<{live: boolean, currentRef?: string, state?: string}>} checkFn
 * @param {{timeoutMs?: number, intervalMs?: number, onTick?: (status: object) => void}} [opts]
 * @returns {Promise<boolean>} true if it went live within the timeout
 */
export async function pollUntilLive(commitSha, checkFn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const status = await checkFn();
      opts.onTick?.(status);
      if (status.live) return true;
    } catch (err) {
      opts.onTick?.({ live: false, error: String(err) });
      // Transient — keep trying until the deadline, don't fail the whole
      // poll on one bad request.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// --- CLI wrapper — only runs when invoked directly, not when imported ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const commitSha = process.argv[2];
  if (!commitSha) {
    console.error("Usage: NETLIFY_SITE_ID=... NETLIFY_API_TOKEN=... node poll-deploy-status.mjs <commit-sha>");
    process.exit(2);
  }
  const siteId = process.env.NETLIFY_SITE_ID;
  const apiToken = process.env.NETLIFY_API_TOKEN;
  if (!siteId || !apiToken) {
    console.error("Set NETLIFY_SITE_ID and NETLIFY_API_TOKEN.");
    process.exit(2);
  }

  console.log(`Polling for ${commitSha} to become the published deploy...`);
  const live = await pollUntilLive(
    commitSha,
    () => checkNetlifyDeployStatus(commitSha, { siteId, apiToken }),
    {
      onTick: (status) =>
        console.log(
          status.error
            ? `  check failed: ${status.error}`
            : `  current published: ${status.currentRef ?? "(none)"} [${status.state ?? "?"}] — ${status.live ? "LIVE" : "not yet"}`,
        ),
    },
  );

  if (live) {
    console.log(`✓ ${commitSha} is live.`);
    process.exit(0);
  } else {
    console.error(`✗ Timed out waiting for ${commitSha} to go live.`);
    process.exit(1);
  }
}
