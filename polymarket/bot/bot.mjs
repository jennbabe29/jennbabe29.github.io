// Polymarket paper-trading bot (fake money only; it never places real orders).
//
// Commands (state lives in a JSON file you pass with --state):
//   node bot.mjs run --state state.json --follows seen.json
//       Settles finished bets, copies new buys/sells from followed traders,
//       scans for arbitrage, marks positions to market, records a snapshot.
//   node bot.mjs candidates --state state.json
//       Prints open markets for the news step (JSON).
//   node bot.mjs bet --state state.json --market <id> --outcome <0|1> --prob <0..1> --reason "<why>"
//       Places a Kelly-sized paper bet from a news-based probability estimate.
//
// Fills walk the live order book and charge Polymarket's published taker fee:
//   fee = shares * rate * (p * (1 - p))^exponent
// Bet size = quarter Kelly, capped at 5% of account value per bet (10% per arbitrage set).
//
// Set NODE_USE_ENV_PROXY=1 where outbound traffic must go through an HTTPS proxy.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DATA = "https://data-api.polymarket.com/v2";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const START_CASH = 1000;
const KELLY_FRACTION = 0.25;
const MAX_BET_SHARE = 0.05;
const MAX_ARB_SHARE = 0.10;
const MIN_BET = 1;
const COPY_MAX_SLIPPAGE = 0.03;   // skip a copy if the price already moved more than 3 cents
const NEWS_MIN_GAP = 0.08;        // news bet only if our estimate differs from the price by 8+ points

// ---------- utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseArr = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || "[]"); } catch { return []; } };
const now = () => Date.now();
const r2 = (x) => Math.round(x * 100) / 100;

function args() {
  const a = { _: [] };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].startsWith("--")) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true;
    else a._.push(v[i]);
  }
  return a;
}

async function get(url, attempt = 0) {
  let res;
  try { res = await fetch(url); }
  catch (e) { if (attempt < 4) { await sleep(2 ** attempt * 1000); return get(url, attempt + 1); } throw e; }
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const ra = Number(res.headers.get("Retry-After"));
    await sleep((isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
    return get(url, attempt + 1);
  }
  if (!res.ok) { const e = new Error(url + " -> HTTP " + res.status); e.status = res.status; throw e; }
  return res.json();
}

function tokenIds(m) {
  const pos = parseArr(m.positionIds);
  if (m.version === "v2" && pos.length) return pos.map(String);
  const clob = parseArr(m.clobTokenIds);
  return (clob.length ? clob : pos).map(String);
}
function feeOf(m) {
  if (!m || !m.feesEnabled || !m.feeSchedule) return { rate: 0, exp: 1 };
  return { rate: Number(m.feeSchedule.rate) || 0, exp: Number(m.feeSchedule.exponent) || 1 };
}
const feePerShare = (p, f) => f.rate * Math.pow(p * (1 - p), f.exp);

async function book(token) {
  const b = await get(CLOB + "/book?token_id=" + encodeURIComponent(token));
  const lv = (arr) => (arr || []).map((x) => ({ p: Number(x.price), s: Number(x.size) })).filter((x) => x.p > 0 && x.s > 0);
  return { asks: lv(b.asks).sort((a, b) => a.p - b.p), bids: lv(b.bids).sort((a, b) => b.p - a.p) };
}
function fillBuy(asks, dollars, f) {
  let left = dollars, shares = 0, cost = 0, fee = 0;
  for (const { p, s } of asks) {
    const per = p + feePerShare(p, f);
    const take = Math.min(s, left / per);
    if (take <= 0) break;
    shares += take; cost += take * p; fee += take * feePerShare(p, f); left -= take * per;
    if (left <= 1e-9) break;
  }
  return { shares, cost, fee, spent: cost + fee, avg: shares ? cost / shares : null };
}
function fillSell(bids, shares, f) {
  let left = shares, gross = 0, fee = 0, sold = 0;
  for (const { p, s } of bids) {
    const take = Math.min(s, left);
    if (take <= 0) break;
    gross += take * p; fee += take * feePerShare(p, f); sold += take; left -= take;
    if (left <= 1e-9) break;
  }
  return { sold, gross, fee, net: gross - fee, avg: sold ? gross / sold : null };
}

const marketCache = new Map();
async function marketById(id) {
  if (!marketCache.has(id)) marketCache.set(id, await get(GAMMA + "/markets/" + encodeURIComponent(id)));
  return marketCache.get(id);
}
async function marketBySlug(slug) {
  const m = await get(GAMMA + "/markets/slug/" + encodeURIComponent(slug));
  marketCache.set(String(m.id), m);
  return m;
}
function finalPrice(m, idx) {
  if (!m.closed) return null;
  const prices = parseArr(m.outcomePrices).map(Number);
  const settled = prices.length >= 2 && prices.every((x) => x === 0 || x === 0.5 || x === 1) && Math.abs(prices.reduce((a, b) => a + b, 0) - 1) < 1e-9;
  if (m.umaResolutionStatus ? m.umaResolutionStatus === "resolved" && settled : settled) return prices[idx];
  return null;
}
const tradable = (m) => m && m.active && !m.closed && m.acceptingOrders;

// ---------- state ----------
function loadState(path) {
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  return {
    v: 1, start_cash: START_CASH, cash: START_CASH, created_at: now(), last_run: null,
    positions: {}, closed: [], trades: [], snapshots: [], follows: {}, last_seen_trade: {}, log: [],
  };
}
function saveState(path, S) {
  S.trades = S.trades.slice(0, 1000);
  S.log = S.log.slice(0, 300);
  if (S.snapshots.length > 3000) S.snapshots = S.snapshots.slice(-3000);
  writeFileSync(path, JSON.stringify(S, null, 1));
}
const accountValue = (S) => S.cash + Object.values(S.positions).reduce((a, p) => a + (p.value ?? p.cost_ex), 0);
function note(S, msg) { S.log.unshift({ t: now(), msg }); console.log(msg); }

// Quarter Kelly for buying one share at price a (plus fee) that pays $1 with probability p.
function kellyDollars(S, p, a, f, cap = MAX_BET_SHARE) {
  const c = a + feePerShare(a, f);
  if (!(p > c) || c >= 1) return 0;
  const full = (p - c) / (1 - c);
  const bank = accountValue(S);
  return Math.min(S.cash, bank * Math.min(full * KELLY_FRACTION, cap));
}

function recordBuy(S, m, idx, r, source, reason, extra = {}) {
  const token = tokenIds(m)[idx];
  const label = parseArr(m.outcomes)[idx];
  S.cash -= r.spent;
  const p = S.positions[token] || {
    token, market_id: String(m.id), slug: m.slug, question: m.question, outcome: label, idx,
    shares: 0, cost_ex: 0, fees: 0, opened_at: now(), source, reason, fee: feeOf(m), ...extra,
  };
  p.shares += r.shares; p.cost_ex += r.cost; p.fees += r.fee;
  p.value = p.shares * r.avg;
  S.positions[token] = p;
  S.trades.unshift({ t: now(), type: "BUY", source, question: m.question, outcome: label, shares: r2(r.shares), price: r.avg, fee: r2(r.fee), amount: -r2(r.spent), reason });
}

// ---------- steps ----------
async function settleAndMark(S) {
  for (const p of Object.values(S.positions)) {
    try {
      marketCache.delete(p.market_id);
      const m = await marketById(p.market_id);
      const fp = finalPrice(m, p.idx);
      if (fp != null) {
        const payout = p.shares * fp;
        S.cash += payout;
        const pnl = payout - p.cost_ex - p.fees;
        S.closed.unshift({ t: now(), question: p.question, outcome: p.outcome, source: p.source, reason: p.reason, shares: r2(p.shares), avg: p.cost_ex / p.shares, final: fp, cost: r2(p.cost_ex + p.fees), payout: r2(payout), pnl: r2(pnl), result: fp === 1 ? "won" : fp === 0 ? "lost" : "split", group: p.group || null });
        S.trades.unshift({ t: now(), type: "SETTLE", source: p.source, question: p.question, outcome: p.outcome, shares: r2(p.shares), price: fp, fee: 0, amount: r2(payout) });
        note(S, "Settled: " + p.outcome + " on \"" + p.question + "\" -> " + (fp === 1 ? "won" : fp === 0 ? "lost" : "50/50") + " (" + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + ")");
        delete S.positions[p.token];
        continue;
      }
      p.status = m.closed ? "waiting for result" : m.acceptingOrders === false ? "trading paused" : null;
      const bid = p.idx === 0 ? Number(m.bestBid) : 1 - Number(m.bestAsk);
      const fallback = Number(parseArr(m.outcomePrices)[p.idx]);
      const px = isFinite(bid) && bid > 0 && !m.closed ? bid : fallback;
      if (isFinite(px)) p.value = p.shares * px;
    } catch (e) {
      console.log("mark failed for " + p.question + ": " + e.message);
    }
  }
}

// Same skill test as the wallet check page.
function isClean(p) {
  const f = p.current_price;
  if (f !== 0 && f !== 1) return false;
  const expected = p.total_size * (f - p.avg_price);
  return Math.abs(p.total_pnl - expected) <= 0.02 * p.total_size * Math.max(p.avg_price, 1 - p.avg_price) + 1;
}
async function traderStats(wallet) {
  const rows = new Map();
  for (const [status, pages] of [["CLOSED", 4], ["REDEEMABLE", 2], ["REDEEMABLE_LOST", 2]]) {
    let cursor = null;
    for (let i = 0; i < pages; i++) {
      const r = await get(DATA + "/positions?user=" + wallet + "&status=" + status + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "&limit=500&sort_by=TIMESTAMP&sort_direction=DESC"));
      for (const p of r.data || []) rows.set(p.token_id, p);
      cursor = r.pagination && r.pagination.next_cursor;
      if (!cursor) break;
    }
  }
  const clean = [...rows.values()].filter((p) => p.avg_price > 0 && p.avg_price < 1 && p.total_size > 0 && isClean(p));
  let wins = 0, exp = 0, pnl = 0, v = 0;
  for (const p of clean) {
    if (p.current_price === 1) wins++;
    exp += p.avg_price; pnl += p.total_pnl; v += p.total_size * p.total_size * p.avg_price * (1 - p.avg_price);
  }
  return { clean_bets: clean.length, win_rate: clean.length ? wins / clean.length : null, expected_win_rate: clean.length ? exp / clean.length : null, edge_score: v > 0 ? pnl / Math.sqrt(v) : null };
}

async function refreshFollows(S, followsPath) {
  if (!followsPath || !existsSync(followsPath)) { console.log("No follows file; skipping copy trading."); return; }
  const seen = JSON.parse(readFileSync(followsPath, "utf8")).seen || {};
  for (const [wallet, info] of Object.entries(seen)) {
    const f = S.follows[wallet] || { wallet, name: info.name };
    if (!f.updated_at || now() - f.updated_at > 24 * 3600e3) {
      try { Object.assign(f, await traderStats(wallet), { updated_at: now() }); }
      catch (e) { console.log("stats failed for " + f.name + ": " + e.message); }
    }
    S.follows[wallet] = f;
  }
  for (const w of Object.keys(S.follows)) if (!seen[w]) delete S.follows[w];
}

async function copyTrades(S) {
  for (const f of Object.values(S.follows)) {
    if (!(f.edge_score >= 3) || f.win_rate == null) continue;
    const since = S.last_seen_trade[f.wallet] || Math.floor((now() - 3 * 3600e3) / 1000);
    let trades;
    try { trades = (await get(DATA + "/trades?user=" + f.wallet + "&start=" + (since + 1) + "&limit=200")).data || []; }
    catch (e) { console.log("trades failed for " + f.name + ": " + e.message); continue; }
    trades.sort((a, b) => a.timestamp - b.timestamp);
    if (trades.length) S.last_seen_trade[f.wallet] = trades[trades.length - 1].timestamp;
    else if (!S.last_seen_trade[f.wallet]) S.last_seen_trade[f.wallet] = since;
    const handled = new Set();
    for (const t of trades) {
      const key = t.side + ":" + t.token_id;
      if (handled.has(key)) continue;
      handled.add(key);
      try {
        if (t.side === "SELL") {
          const p = S.positions[t.token_id];
          if (!p || p.source !== "copy") continue;
          const m = await marketById(p.market_id);
          if (!tradable(m)) continue;
          const ob = await book(p.token);
          const r = fillSell(ob.bids, p.shares, p.fee);
          if (!(r.sold > 0)) continue;
          const frac = r.sold / p.shares, costPart = (p.cost_ex + p.fees) * frac;
          S.cash += r.net;
          S.closed.unshift({ t: now(), question: p.question, outcome: p.outcome, source: "copy", reason: p.reason, shares: r2(r.sold), avg: p.cost_ex / p.shares, final: null, cost: r2(costPart), payout: r2(r.net), pnl: r2(r.net - costPart), result: "sold" });
          S.trades.unshift({ t: now(), type: "SELL", source: "copy", question: p.question, outcome: p.outcome, shares: r2(r.sold), price: r.avg, fee: r2(r.fee), amount: r2(r.net), reason: f.name + " sold" });
          p.shares -= r.sold; p.cost_ex *= 1 - frac; p.fees *= 1 - frac;
          if (p.shares < 1e-6) delete S.positions[p.token];
          note(S, "Copied a sell from " + f.name + ": " + p.outcome + " on \"" + p.question + "\"");
          continue;
        }
        if (S.positions[t.token_id]) continue;
        const m = await marketBySlug(t.slug);
        if (!tradable(m)) continue;
        const idx = tokenIds(m).indexOf(String(t.token_id));
        if (idx < 0) continue;
        const ob = await book(t.token_id);
        if (!ob.asks.length) continue;
        const ask = ob.asks[0].p;
        if (ask > t.price + COPY_MAX_SLIPPAGE) { note(S, "Skipped copying " + f.name + " on \"" + t.title + "\": price moved from " + t.price + " to " + ask); continue; }
        // Their measured edge: how much more often they win than prices predict. Halved to be cautious.
        const p = Math.min(0.97, ask + Math.max(0, f.win_rate - f.expected_win_rate) / 2);
        const fee = feeOf(m);
        const dollars = kellyDollars(S, p, ask, fee);
        if (dollars < MIN_BET) continue;
        const r = fillBuy(ob.asks, dollars, fee);
        if (!(r.shares > 0) || r.shares < (Number(m.orderMinSize) || 0)) continue;
        recordBuy(S, m, idx, r, "copy", "Copied " + f.name + " (edge score " + f.edge_score.toFixed(1) + ", they paid " + t.price + ")");
        note(S, "Copied " + f.name + ": bought " + r.shares.toFixed(1) + " " + parseArr(m.outcomes)[idx] + " on \"" + m.question + "\" for $" + r.spent.toFixed(2));
      } catch (e) {
        console.log("copy failed (" + t.title + "): " + e.message);
      }
    }
  }
}

// Arbitrage in multi-outcome events where only one outcome can win (negRisk):
//  - "No on every outcome" pays at least n-1 dollars per set (safe if outcomes are exclusive).
//  - "Yes on every outcome" pays 1 dollar per set only if one of the listed outcomes wins.
async function arbitrage(S) {
  let events;
  try { events = (await get(GAMMA + "/events/keyset?closed=false&limit=60&order=volume24hr&ascending=false")).events || []; }
  catch (e) { console.log("arb scan failed: " + e.message); return; }
  const heldGroups = new Set(Object.values(S.positions).map((p) => p.group).filter(Boolean));
  for (const e of events) {
    if (!e.negRisk || e.negRiskAugmented || heldGroups.has(e.id)) continue;
    const ms = e.markets || [];
    if (ms.length < 2 || ms.length > 30 || !ms.every(tradable)) continue;
    const bids = ms.map((m) => Number(m.bestBid)), asks = ms.map((m) => Number(m.bestAsk));
    if (![...bids, ...asks].every((x) => isFinite(x) && x > 0)) continue;
    const n = ms.length;
    const sumAsk = asks.reduce((a, b) => a + b, 0), sumBid = bids.reduce((a, b) => a + b, 0);
    let kind = null;
    if (sumBid > 1.015) kind = "no";
    else if (sumAsk < 0.985) kind = "yes";
    if (!kind) continue;
    try {
      const legs = [];
      for (const m of ms) {
        const idx = kind === "yes" ? 0 : 1;
        const ob = await book(tokenIds(m)[idx]);
        if (!ob.asks.length) throw new Error("empty book");
        legs.push({ m, idx, ask: ob.asks[0].p, depth: ob.asks[0].s, fee: feeOf(m) });
      }
      const perSet = legs.reduce((a, l) => a + l.ask + feePerShare(l.ask, l.fee), 0);
      const payout = kind === "yes" ? 1 : n - 1;
      const edge = payout - perSet;
      if (edge < 0.01) continue;
      const maxSets = Math.min(...legs.map((l) => l.depth), (accountValue(S) * MAX_ARB_SHARE) / perSet, S.cash / perSet);
      if (!(maxSets * edge >= 0.5)) continue;
      const label = kind === "yes" ? "Bought Yes on all " + n + " outcomes (pays $1 if one of them wins)" : "Bought No on all " + n + " outcomes (pays at least $" + (n - 1) + " per set)";
      for (const l of legs) {
        const r = { shares: maxSets, cost: maxSets * l.ask, fee: maxSets * feePerShare(l.ask, l.fee), avg: l.ask };
        r.spent = r.cost + r.fee;
        recordBuy(S, l.m, l.idx, r, "arb", label + " in \"" + e.title + "\"", { group: e.id });
      }
      note(S, "Arbitrage in \"" + e.title + "\": " + maxSets.toFixed(1) + " sets, expected profit about $" + (maxSets * edge).toFixed(2));
    } catch (err) {
      console.log("arb check failed for " + e.title + ": " + err.message);
    }
  }
}

async function candidates(S) {
  const r = await get(GAMMA + "/events/keyset?closed=false&limit=60&order=volume24hr&ascending=false");
  const out = [];
  const t = now();
  for (const e of r.events || []) {
    const tags = (e.tags || []).map((x) => (x.label || "").toLowerCase());
    if (tags.some((x) => x === "sports" || x === "esports" || x === "crypto prices" || x === "up or down")) continue;
    for (const m of e.markets || []) {
      if (!tradable(m)) continue;
      const end = Date.parse(m.endDate || e.endDate || "");
      if (!(end - t > 12 * 3600e3 && end - t < 21 * 24 * 3600e3)) continue;
      const price = Number(parseArr(m.outcomePrices)[0]);
      if (!(price >= 0.1 && price <= 0.9)) continue;
      if (Object.values(S.positions).some((p) => p.market_id === String(m.id))) continue;
      out.push({ market_id: String(m.id), event: e.title, question: m.question, outcomes: parseArr(m.outcomes), yes_price: price, best_ask_yes: Number(m.bestAsk), best_bid_yes: Number(m.bestBid), ends: m.endDate, volume_24h: Math.round(Number(m.volume24hr) || 0), rules: (m.description || "").slice(0, 700), url: "https://polymarket.com/event/" + e.slug });
    }
  }
  // At most one market per event, so the news step covers different topics.
  out.sort((a, b) => b.volume_24h - a.volume_24h);
  const perEvent = new Set();
  return out.filter((c) => !perEvent.has(c.event) && perEvent.add(c.event)).slice(0, 6);
}

async function newsBet(S, a) {
  const prob = Number(a.prob), idx = Number(a.outcome);
  if (!(prob > 0 && prob < 1) || !(idx === 0 || idx === 1)) throw new Error("--prob must be between 0 and 1 and --outcome 0 or 1");
  const m = await marketById(String(a.market));
  if (!tradable(m)) throw new Error("market not open for trading");
  const token = tokenIds(m)[idx];
  if (S.positions[token]) { console.log("Already holding this outcome; no new bet."); return; }
  const ob = await book(token);
  if (!ob.asks.length) throw new Error("no sellers");
  const ask = ob.asks[0].p;
  if (prob - ask < NEWS_MIN_GAP) { console.log("Estimate " + prob + " is not at least " + NEWS_MIN_GAP + " above the price " + ask + "; no bet."); return; }
  const fee = feeOf(m);
  const dollars = kellyDollars(S, prob, ask, fee);
  if (dollars < MIN_BET) { console.log("Kelly size below $1; no bet."); return; }
  const r = fillBuy(ob.asks, dollars, fee);
  if (!(r.shares > 0) || r.shares < (Number(m.orderMinSize) || 0)) { console.log("Fill too small; no bet."); return; }
  recordBuy(S, m, idx, r, "news", String(a.reason || "").slice(0, 400), { estimate: prob });
  note(S, "News bet: bought " + r.shares.toFixed(1) + " " + parseArr(m.outcomes)[idx] + " on \"" + m.question + "\" at " + r.avg.toFixed(3) + " (bot's estimate " + prob + ") for $" + r.spent.toFixed(2));
}

// ---------- main ----------
const a = args();
const cmd = a._[0];
if (!a.state) { console.error("--state <file> is required"); process.exit(2); }
const S = loadState(a.state);

if (cmd === "run") {
  await settleAndMark(S);
  await refreshFollows(S, a.follows);
  await copyTrades(S);
  await arbitrage(S);
  await settleAndMark(S);
  S.last_run = now();
  S.snapshots.push({ t: now(), value: r2(accountValue(S)), cash: r2(S.cash) });
  saveState(a.state, S);
  console.log("Account value $" + accountValue(S).toFixed(2) + " (cash $" + S.cash.toFixed(2) + ", " + Object.keys(S.positions).length + " open bets)");
} else if (cmd === "candidates") {
  console.log(JSON.stringify(await candidates(S), null, 1));
} else if (cmd === "bet") {
  await newsBet(S, a);
  saveState(a.state, S);
} else {
  console.error("Usage: node bot.mjs run|candidates|bet --state state.json [...]");
  process.exit(2);
}
