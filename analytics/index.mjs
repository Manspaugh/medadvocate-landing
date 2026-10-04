// landing-analytics Lambda — cookieless pageview + click counters for the
// MedAdvocate marketing site. Backed by a single DynamoDB table of atomic
// counters. Exposed via a Lambda Function URL:
//   POST  { "event": "pageview" | "click_app_store" | "click_google_play",
//           "ref"?: <referrer hostname>, "utm_source"?, "utm_medium"? }
//   POST  { "event": "ad_click", "ad": <ad name>,
//           "platform": "ios" | "android" | "desktop" }   (from /get?ad=)
//   GET   ?days=30  -> { total, daily, sources, utm_sources, utm_mediums, ads,
//                       ads_daily }
//         (read-only, used by /secret-stats and by anything that needs the ad
//         clicks one day at a time rather than summed over the window)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.TABLE || "landing-analytics";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Only these counters can be incremented — anything else is ignored so the
// endpoint can't be used to write arbitrary attributes.
const EVENTS = new Set(["pageview", "click_app_store", "click_google_play", "ad_click"]);
const PLATFORMS = new Set(["ios", "android", "desktop"]);

const ALLOWED_ORIGINS = new Set([
  "https://www.medadvocate.net",
  "https://medadvocate.net",
]);

const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|headless|monitor|preview|lighthouse|pagespeed|gtmetrix/i;

function cors(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.medadvocate.net";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Stats-Key",
    "Cache-Control": "no-store",
  };
}

// Constant-time-ish comparison so we don't leak length/prefix via timing.
function keyOk(provided) {
  const expected = process.env.STATS_KEY || "";
  if (!expected || !provided) return false; // fail closed if unset
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const todayUTC = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Reduce a client-supplied referrer to a bare hostname we can safely use as a
// DynamoDB attribute name. Strips any scheme/path/query and a leading "www.",
// lowercases, and allows only hostname characters. Anything else returns ""
// so the caller can fall back to "direct".
function cleanHost(v) {
  const h = String(v || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split("?")[0]
    .replace(/^www\./, "");
  return /^[a-z0-9.-]{1,120}$/.test(h) ? h : "";
}

// Sanitize a utm_source / utm_medium tag: lowercase, length capped, and
// limited to a safe charset. Returns "" for anything invalid so it is dropped.
function cleanTag(v) {
  const t = String(v || "").toLowerCase().trim().slice(0, 64);
  return /^[a-z0-9][a-z0-9._-]*$/.test(t) ? t : "";
}

// An ad name as a tag: lowercase, anything outside [a-z0-9._-] collapsed to a
// hyphen, must start with a letter or digit, capped at 40 (Apple's limit for
// ct), no trailing hyphens. The same rule as clean() in get/index.html, which
// is what actually produces the tag: "Bill Shock" arrives here as "bill-shock".
//
// It normalises rather than rejects. A tag that fails validation used to count
// nothing at all, so a click that did happen simply vanished, and the only
// symptom was an ad showing zero. A test holds this and the page's copy to the
// same answers. Returns "" only when nothing usable is left.
export function normalizeTag(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function lastNDates(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

async function bump(pk, event) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      UpdateExpression: "ADD #e :one",
      ExpressionAttributeNames: { "#e": event },
      ExpressionAttributeValues: { ":one": 1 },
    })
  );
}

export const handler = async (event) => {
  const http = event.requestContext?.http || {};
  const method = http.method || "GET";
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || "";
  const baseHeaders = { "Content-Type": "application/json", ...cors(origin) };

  if (method === "OPTIONS") return { statusCode: 204, headers: cors(origin) };

  if (method === "POST") {
    // Never count obvious bots/link-preview fetchers.
    const ua = headers["user-agent"] || headers["User-Agent"] || "";
    if (BOT_RE.test(ua)) return { statusCode: 204, headers: cors(origin) };

    let body = {};
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf8")
        : event.body || "{}";
      body = JSON.parse(raw);
    } catch {
      return { statusCode: 400, headers: baseHeaders, body: '{"error":"bad json"}' };
    }
    const name = String(body.event || "");
    if (!EVENTS.has(name))
      return { statusCode: 400, headers: baseHeaders, body: '{"error":"unknown event"}' };

    // An ad click must name an ad and a valid platform, else nothing is counted.
    // The name is normalised, not validated: see normalizeTag.
    const ad = normalizeTag(body.ad);
    const platform = String(body.platform || "");
    if (name === "ad_click" && (!ad || !PLATFORMS.has(platform)))
      return { statusCode: 400, headers: baseHeaders, body: '{"error":"bad ad_click"}' };

    // One counter for all-time, one for the day, so we get totals + a trend.
    const day = todayUTC();
    const writes = [bump("TOTAL", name), bump(day, name)];

    // Per-ad clicks: one item per day whose attributes are "<ad>:<platform>".
    // normalizeTag never emits ":", so the split on read is unambiguous.
    if (name === "ad_click") writes.push(bump(`AD#${day}`, `${ad}:${platform}`));

    // On a pageview, also record where the visit came from. Referrer hostname
    // is stored as an attribute on a per-day SRC item ("direct" when absent),
    // and utm_source / utm_medium on parallel per-day items. All values are
    // sanitized server side and never trusted from the client. This runs after
    // the bot check above, so bot traffic is excluded from source counts too.
    if (name === "pageview") {
      writes.push(bump(`SRC#${day}`, cleanHost(body.ref) || "direct"));
      const us = cleanTag(body.utm_source);
      const um = cleanTag(body.utm_medium);
      if (us) writes.push(bump(`UTM_SRC#${day}`, us));
      if (um) writes.push(bump(`UTM_MED#${day}`, um));
    }

    await Promise.all(writes);
    return { statusCode: 204, headers: cors(origin) };
  }

  // GET -> stats for the dashboard. Requires the shared passphrase in the
  // X-Stats-Key header, base64-encoded (HTTP headers can't carry non-Latin1
  // characters, so the browser sends btoa(utf8(passphrase))).
  const rawKey = headers["x-stats-key"] || headers["X-Stats-Key"] || "";
  let provided = "";
  try {
    provided = Buffer.from(rawKey, "base64").toString("utf8");
  } catch {
    provided = "";
  }
  if (!keyOk(provided))
    return { statusCode: 401, headers: baseHeaders, body: '{"error":"unauthorized"}' };

  const days = Math.min(Math.max(parseInt(event.queryStringParameters?.days || "30", 10) || 30, 1), 90);
  const dates = lastNDates(days);

  const totalRes = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: "TOTAL" } }));
  const total = strip(totalRes.Item);

  // BatchGet is capped at 100 keys; days is <=90 so a single batch is fine.
  const batch = await ddb.send(
    new BatchGetCommand({
      RequestItems: { [TABLE]: { Keys: dates.map((pk) => ({ pk })) } },
    })
  );
  const byDate = Object.fromEntries(
    (batch.Responses?.[TABLE] || []).map((it) => [it.pk, strip(it)])
  );
  const daily = dates.map((date) => ({ date, ...zero(), ...(byDate[date] || {}) }));

  // Referrer + campaign sources for the same window. Each is stored as one
  // item per day whose attributes are the hostnames / tags. Fetch each prefix
  // in its own batch (so we stay under the 100-key BatchGet cap even at 90
  // days), merge the per-day counts, and return the totals sorted by count.
  const [srcMap, utmSrcMap, utmMedMap, adItems] = await Promise.all([
    fetchMerged(dates.map((d) => `SRC#${d}`)),
    fetchMerged(dates.map((d) => `UTM_SRC#${d}`)),
    fetchMerged(dates.map((d) => `UTM_MED#${d}`)),
    fetchItems(dates.map((d) => `AD#${d}`)),
  ]);
  // The window's total per ad, as before, and the same clicks one day at a
  // time. Both come from the same items, so they cannot disagree.
  const adMap = mergeCounters(adItems);

  return {
    statusCode: 200,
    headers: baseHeaders,
    body: JSON.stringify({
      total: { ...zero(), ...total },
      daily,
      sources: topList(srcMap, 50),
      utm_sources: topList(utmSrcMap, 50),
      utm_mediums: topList(utmMedMap, 50),
      ads: adList(adMap, 50),
      ads_daily: adsDaily(adItems),
    }),
  };
};

// BatchGet a set of pks and return the items as they are.
async function fetchItems(pks) {
  if (!pks.length) return [];
  const res = await ddb.send(
    new BatchGetCommand({
      RequestItems: { [TABLE]: { Keys: pks.map((pk) => ({ pk })) } },
    })
  );
  return res.Responses?.[TABLE] || [];
}

// Sum every non-pk (counter) attribute across items into one { name: count }.
function mergeCounters(items) {
  const out = {};
  for (const it of items) {
    for (const [k, v] of Object.entries(it)) {
      if (k === "pk") continue;
      out[k] = (out[k] || 0) + (typeof v === "number" ? v : Number(v) || 0);
    }
  }
  return out;
}

// BatchGet a set of pks and sum their counters into a single { name: count }.
async function fetchMerged(pks) {
  return mergeCounters(await fetchItems(pks));
}

// "AD#<day>" items -> [{ date, name, ios, android, desktop, total }], one row
// per ad per day, oldest day first. The per-day form of adList: a reader that
// keeps its own history needs days, because a sum over "the last 30 days"
// means a different thirty days every time it is asked.
export function adsDaily(items) {
  const rows = [];
  for (const it of items || []) {
    const date = String(it.pk || "").slice(3);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const { pk, ...counters } = it;
    for (const r of adList(counters, Infinity)) rows.push({ date, ...r });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || b.total - a.total);
}

// { name: count } map -> array sorted by count desc, positive counts only,
// capped at n entries.
function topList(map, n) {
  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// { "<ad>:<platform>": count } map -> [{ name, ios, android, desktop, total }]
// sorted by total desc, capped at n ads.
function adList(map, n) {
  const byAd = {};
  for (const [k, count] of Object.entries(map)) {
    const i = k.lastIndexOf(":");
    const name = k.slice(0, i);
    const platform = k.slice(i + 1);
    if (!name || !PLATFORMS.has(platform)) continue;
    const r = (byAd[name] ||= { name, ios: 0, android: 0, desktop: 0, total: 0 });
    r[platform] += count;
    r.total += count;
  }
  return Object.values(byAd)
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

const zero = () => ({ pageview: 0, click_app_store: 0, click_google_play: 0 });
function strip(item) {
  if (!item) return {};
  const { pk, ...rest } = item;
  return rest;
}
