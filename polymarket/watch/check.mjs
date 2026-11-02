// Daily watch for Polymarket traders whose results look like more than luck.
// Same test as polymarket/index.html: only "clean" bets (held to resolution,
// with profit = shares x (payout - avg price)) are judged, and the edge score is
// profit / sqrt(sum(shares^2 * p * (1 - p))). A trader qualifies at score >= 3
// with at least 30 clean bets.
//
// Run: NODE_USE_ENV_PROXY=1 node polymarket/watch/check.mjs   (the env var is only
// needed where outbound traffic must go through an HTTPS proxy)
// Prints a human summary, then a final line "RESULT_JSON <json>".

const API = "https://data-api.polymarket.com/v2";
const PERIODS = ["day", "week", "month", "all"];
const PER_BOARD = Number(process.env.PER_BOARD) || 50;
const MIN_BETS = 30;
const THRESHOLD = 3;
const PAGE = 500;
const MAX_PAGES = { CLOSED: 4, REDEEMABLE: 2, REDEEMABLE_LOST: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, attempt = 0) {
  let res;
  try {
    res = await fetch(API + path);
  } catch (e) {
    if (attempt < 4) { await sleep(2 ** attempt * 1000); return api(path, attempt + 1); }
    throw e;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const ra = Number(res.headers.get("Retry-After"));
    await sleep((isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
    return api(path, attempt + 1);
  }
  if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
  return res.json();
}

async function positions(wallet, status) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < MAX_PAGES[status]; i++) {
    const q = "/positions?user=" + wallet + "&status=" + status +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "&limit=" + PAGE + "&sort_by=TIMESTAMP&sort_direction=DESC");
    const r = await api(q);
    out.push(...(r.data || []));
    cursor = r.pagination && r.pagination.next_cursor;
    if (!cursor) break;
  }
  return out;
}

function isClean(p) {
  const f = p.current_price;
  if (f !== 0 && f !== 1) return false;
  const expected = p.total_size * (f - p.avg_price);
  const tol = 0.02 * p.total_size * Math.max(p.avg_price, 1 - p.avg_price) + 1;
  return Math.abs(p.total_pnl - expected) <= tol;
}

function analyze(list) {
  const seen = new Map();
  for (const p of list) seen.set(p.token_id, p);
  const all = [...seen.values()].filter((p) => p.avg_price > 0 && p.avg_price < 1 && p.total_size > 0);
  const clean = all.filter(isClean);
  let wins = 0, expectedWins = 0, staked = 0, profit = 0, moneyVar = 0;
  for (const p of clean) {
    if (p.current_price === 1) wins++;
    expectedWins += p.avg_price;
    staked += p.total_size * p.avg_price;
    profit += p.total_pnl;
    moneyVar += p.total_size * p.total_size * p.avg_price * (1 - p.avg_price);
  }
  const gains = clean.map((p) => p.total_pnl).filter((x) => x > 0).sort((a, b) => b - a);
  const grossWin = gains.reduce((a, b) => a + b, 0);
  return {
    clean_bets: clean.length,
    total_bets: all.length,
    win_rate: clean.length ? wins / clean.length : null,
    expected_win_rate: clean.length ? expectedWins / clean.length : null,
    edge_score: moneyVar > 0 ? profit / Math.sqrt(moneyVar) : null,
    clean_profit: profit,
    return_on_money: staked > 0 ? profit / staked : null,
    top3_share: grossWin > 0 ? gains.slice(0, 3).reduce((a, b) => a + b, 0) / grossWin : null,
  };
}

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

const fmt$ = (v) => (v < 0 ? "-" : "+") + "$" + Math.round(Math.abs(v)).toLocaleString("en-US");
const pct = (v) => (v == null ? "n/a" : Math.round(v * 100) + "%");

const traders = new Map();
for (const period of PERIODS) {
  const r = await api("/leaderboard?time_period=" + period + "&sort_by=PNL&limit=" + PER_BOARD);
  for (const u of r.data || []) {
    const t = traders.get(u.user_id) || { wallet: u.user_id, name: u.user_name || u.user_id, boards: [] };
    t.boards.push({ period, rank: u.rank, pnl: u.pnl });
    traders.set(u.user_id, t);
  }
}

const list = [...traders.values()];
const errors = [];
await pool(list, 4, async (t) => {
  try {
    const all = [];
    for (const s of ["CLOSED", "REDEEMABLE", "REDEEMABLE_LOST"]) all.push(...(await positions(t.wallet, s)));
    t.a = analyze(all);
  } catch (e) {
    errors.push(t.name + ": " + e.message);
  }
});

const judged = list.filter((t) => t.a && t.a.clean_bets >= MIN_BETS);
const qualifying = judged.filter((t) => t.a.edge_score >= THRESHOLD).sort((x, y) => y.a.edge_score - x.a.edge_score);
const near = judged.filter((t) => t.a.edge_score >= 2 && t.a.edge_score < THRESHOLD).sort((x, y) => y.a.edge_score - x.a.edge_score);

console.log("Checked " + list.length + " traders from the day/week/month/all-time top " + PER_BOARD + " boards.");
console.log(judged.length + " had at least " + MIN_BETS + " clean bets; " + qualifying.length + " scored " + THRESHOLD + "+; " + near.length + " scored 2 to 3.");
if (errors.length) console.log(errors.length + " could not be loaded: " + errors.slice(0, 5).join("; "));
for (const t of [...qualifying, ...near]) {
  const a = t.a;
  console.log("\n" + (a.edge_score >= THRESHOLD ? "[QUALIFIES] " : "[close] ") + t.name + " (" + t.wallet + ")");
  console.log("  edge score " + a.edge_score.toFixed(1) + " | clean bets " + a.clean_bets + " of " + a.total_bets +
    " | win rate " + pct(a.win_rate) + " vs " + pct(a.expected_win_rate) + " expected | clean profit " + fmt$(a.clean_profit) +
    " | return " + pct(a.return_on_money) + " | top 3 wins = " + pct(a.top3_share) + " of winnings");
  console.log("  boards: " + t.boards.map((b) => b.period + " #" + b.rank + " " + fmt$(b.pnl)).join(", "));
  console.log("  https://polymarket.com/profile/" + t.wallet);
}

console.log("RESULT_JSON " + JSON.stringify({
  checked: list.length,
  judged: judged.length,
  errors: errors.length,
  qualifying: qualifying.map((t) => ({ name: t.name, wallet: t.wallet, boards: t.boards, ...t.a })),
  near: near.map((t) => ({ name: t.name, wallet: t.wallet, edge_score: t.a.edge_score, clean_bets: t.a.clean_bets })),
}));
