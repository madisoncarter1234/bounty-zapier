import { readFileSync, writeFileSync, existsSync } from "fs";

const BOUNTY_API = process.env.BOUNTY_API || "https://bounty.owockibot.xyz";
const WEBHOOK_URLS = (process.env.WEBHOOK_URLS || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "60", 10) * 1000;
const FILTER_TAGS = (process.env.FILTER_TAGS || "")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);
const FILTER_MIN_REWARD = parseFloat(process.env.FILTER_MIN_REWARD || "0");
const PORT = parseInt(process.env.PORT || "3001", 10);

const STATE_FILE = new URL("./state.json", import.meta.url).pathname;

interface Bounty {
  id: string;
  title: string;
  description: string;
  tags: string[];
  reward: string;
  rewardFormatted: string;
  status: string;
  creator: string;
  createdAt: number;
  updatedAt: number;
  claimedBy?: string;
  completedAt?: number;
  requirements?: string[];
}

interface State {
  bounties: Record<string, string>; // id -> status
}

type EventType =
  | "bounty.created"
  | "bounty.claimed"
  | "bounty.submitted"
  | "bounty.completed"
  | "bounty.payment_failed";

interface WebhookPayload {
  event: EventType;
  bounty: Bounty;
  timestamp: string;
}

function loadState(): State {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      console.warn("Corrupted state file, starting fresh");
    }
  }
  return { bounties: {} };
}

function saveState(state: State) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function matchesFilters(bounty: Bounty): boolean {
  if (FILTER_TAGS.length > 0) {
    if (!bounty.tags.some((t) => FILTER_TAGS.includes(t.toLowerCase()))) return false;
  }
  if (FILTER_MIN_REWARD > 0) {
    const usdc = Number(bounty.reward) / 1e6;
    if (usdc < FILTER_MIN_REWARD) return false;
  }
  return true;
}

const STATUS_TO_EVENT: Record<string, EventType> = {
  open: "bounty.created",
  claimed: "bounty.claimed",
  submitted: "bounty.submitted",
  completed: "bounty.completed",
  payment_failed: "bounty.payment_failed",
};

async function fireWebhook(payload: WebhookPayload) {
  const body = JSON.stringify(payload);
  for (const url of WEBHOOK_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      console.log(
        `[${payload.event}] #${payload.bounty.id} "${payload.bounty.title}" -> ${url} (${res.status})`
      );
    } catch (err) {
      console.error(`[ERROR] Webhook ${url}:`, err);
    }
  }
}

async function fetchBounties(): Promise<Bounty[]> {
  const res = await fetch(`${BOUNTY_API}/bounties`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function poll(): Promise<{ created: number; changed: number; errors: number }> {
  const state = loadState();
  let created = 0,
    changed = 0,
    errors = 0;

  try {
    const bounties = await fetchBounties();

    for (const bounty of bounties) {
      if (!matchesFilters(bounty)) continue;

      const prevStatus = state.bounties[bounty.id];

      if (!prevStatus) {
        // New bounty
        state.bounties[bounty.id] = bounty.status;
        if (WEBHOOK_URLS.length > 0) {
          await fireWebhook({
            event: "bounty.created",
            bounty,
            timestamp: new Date().toISOString(),
          });
        }
        created++;
      } else if (prevStatus !== bounty.status) {
        // Status changed
        const event = STATUS_TO_EVENT[bounty.status];
        if (event && WEBHOOK_URLS.length > 0) {
          await fireWebhook({
            event,
            bounty,
            timestamp: new Date().toISOString(),
          });
        }
        state.bounties[bounty.id] = bounty.status;
        changed++;
      }
    }

    saveState(state);
  } catch (err) {
    console.error("[POLL ERROR]", err);
    errors++;
  }

  return { created, changed, errors };
}

// HTTP server for health checks and manual bounty creation proxy
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        webhooks: WEBHOOK_URLS.length,
        filterTags: FILTER_TAGS,
        pollInterval: POLL_INTERVAL / 1000,
      });
    }

    if (url.pathname === "/bounties" && req.method === "POST") {
      // Proxy bounty creation to the API
      try {
        const body = await req.text();
        const res = await fetch(`${BOUNTY_API}/bounties`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const data = await res.json();
        return Response.json(data, { status: res.status });
      } catch (err) {
        return Response.json({ error: "Failed to proxy bounty creation" }, { status: 502 });
      }
    }

    if (url.pathname === "/poll" && req.method === "POST") {
      // Manual poll trigger
      const stats = await poll();
      return Response.json(stats);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log("=".repeat(50));
console.log("  Bounty Board Zapier/Make Integration");
console.log("=".repeat(50));
console.log(`  Server:     http://localhost:${PORT}`);
console.log(`  Webhooks:   ${WEBHOOK_URLS.length > 0 ? WEBHOOK_URLS.join(", ") : "(none configured)"}`);
console.log(`  Tags:       ${FILTER_TAGS.length > 0 ? FILTER_TAGS.join(", ") : "(all)"}`);
console.log(`  Min reward: ${FILTER_MIN_REWARD > 0 ? FILTER_MIN_REWARD + " USDC" : "(any)"}`);
console.log(`  Interval:   ${POLL_INTERVAL / 1000}s`);
console.log("=".repeat(50));

// Initial poll
const initStats = await poll();
console.log(
  `Initial poll: ${initStats.created} bounties indexed, ${initStats.changed} changes`
);

// Recurring poll
setInterval(() => {
  poll().then((stats) => {
    if (stats.created > 0 || stats.changed > 0 || stats.errors > 0) {
      console.log(
        `Poll: +${stats.created} new, ${stats.changed} changed, ${stats.errors} errors`
      );
    }
  });
}, POLL_INTERVAL);
