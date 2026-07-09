// landing-analytics Lambda — cookieless pageview + click counters for the
// MedAdvocate marketing site. Backed by a single DynamoDB table of atomic
// counters. Exposed via a Lambda Function URL:
//   POST  { "event": "pageview" | "click_app_store" | "click_google_play" }
//   GET   ?days=30  -> { total, daily: [...] }  (read-only, used by /secret-stats)
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
const EVENTS = new Set(["pageview", "click_app_store", "click_google_play"]);

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

    // One counter for all-time, one for the day, so we get totals + a trend.
    await Promise.all([bump("TOTAL", name), bump(todayUTC(), name)]);
    return { statusCode: 204, headers: cors(origin) };
  }

  // GET -> stats for the dashboard. Requires the shared passphrase in the
  // X-Stats-Key header; the data is never returned without it.
  const provided = headers["x-stats-key"] || headers["X-Stats-Key"] || "";
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

  return {
    statusCode: 200,
    headers: baseHeaders,
    body: JSON.stringify({ total: { ...zero(), ...total }, daily }),
  };
};

const zero = () => ({ pageview: 0, click_app_store: 0, click_google_play: 0 });
function strip(item) {
  if (!item) return {};
  const { pk, ...rest } = item;
  return rest;
}
