// node --test analytics/index.test.mjs
//
// The Lambda runs on the SDK built into the runtime and this repo has no
// package.json, so there is nothing to install. The AWS SDK is stubbed with an
// in-memory table instead, which lets the real handler be driven end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';

const STUB = `
  const table = () => globalThis.__table;
  export class DynamoDBClient {}
  export class UpdateCommand { constructor(input) { this.input = input; } }
  export class GetCommand { constructor(input) { this.input = input; } }
  export class BatchGetCommand { constructor(input) { this.input = input; } }
  export const DynamoDBDocumentClient = { from: () => ({
    async send(cmd) {
      const t = table();
      if (cmd instanceof UpdateCommand) {
        const pk = cmd.input.Key.pk;
        const attr = cmd.input.ExpressionAttributeNames['#e'];
        const row = t.get(pk) ?? { pk };
        row[attr] = (row[attr] ?? 0) + 1;
        t.set(pk, row);
        return {};
      }
      if (cmd instanceof GetCommand) return { Item: t.get(cmd.input.Key.pk) };
      if (cmd instanceof BatchGetCommand) {
        const [name, req] = Object.entries(cmd.input.RequestItems)[0];
        return { Responses: { [name]: req.Keys.map((k) => t.get(k.pk)).filter(Boolean) } };
      }
      return {};
    },
  }) };
`;
register('data:text/javascript,' + encodeURIComponent(`
  const STUB = ${JSON.stringify(STUB)};
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith('@aws-sdk/')) return { url: 'stub:' + spec, shortCircuit: true };
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.startsWith('stub:')) return { format: 'module', shortCircuit: true, source: STUB };
    return next(url, ctx);
  }
`));

process.env.STATS_KEY = 'correct horse';
const { handler, normalizeTag, adsDaily } = await import('./index.mjs');

const today = new Date().toISOString().slice(0, 10);
const post = (body, ua = 'Mozilla/5.0 (iPhone)') => handler({
  requestContext: { http: { method: 'POST' } },
  headers: { 'user-agent': ua, origin: 'https://www.medadvocate.net' },
  body: JSON.stringify(body),
});
const get = (days = 30, key = 'correct horse') => handler({
  requestContext: { http: { method: 'GET' } },
  headers: { 'x-stats-key': Buffer.from(key, 'utf8').toString('base64') },
  queryStringParameters: { days: String(days) },
});
const fresh = () => { globalThis.__table = new Map(); };

// ── the tag ──────────────────────────────────────────────────────────────────

test('an ad name becomes a tag: lowercase, spaces to hyphens', () => {
  assert.equal(normalizeTag('Bill Shock'), 'bill-shock');
  assert.equal(normalizeTag('  Video 3  '), 'video-3');
  assert.equal(normalizeTag('video3'), 'video3');
  assert.equal(normalizeTag('Bill Shock – Video #1!'), 'bill-shock-video-1');
  assert.equal(normalizeTag('a_b.c-d'), 'a_b.c-d');
});

test('a tag starts with a letter or digit, ends clean, and fits Apple\'s limit', () => {
  assert.equal(normalizeTag('--lead'), 'lead');
  assert.equal(normalizeTag('trail---'), 'trail');
  assert.equal(normalizeTag('x'.repeat(60)).length, 40);
  assert.equal(normalizeTag('a'.repeat(39) + ' b'), 'a'.repeat(39), 'no hyphen left dangling at the cut');
});

test('nothing usable is an empty tag, never a made-up one', () => {
  for (const bad of ['', '   ', '!!!', null, undefined, '---']) assert.equal(normalizeTag(bad), '');
});

test('the page and the Lambda turn the same name into the same tag', () => {
  // get/index.html carries its own copy of the rule, because the page has no
  // build step. The page's copy is what produces the tag; this one receives it.
  // If they drift, a click is counted under a name nothing else is looking for.
  const html = fs.readFileSync(new URL('../get/index.html', import.meta.url), 'utf8');
  const source = html.match(/function clean\(v\) \{[\s\S]*?\n {8}\}/);
  assert.ok(source, 'clean() not found in get/index.html');
  const pageClean = new Function(`${source[0]}; return clean;`)();
  for (const name of [
    'Bill Shock', 'video3', 'VIDEO 3', '  spaced  out  ', 'Bill Shock – Video #1!',
    'a_b.c-d', '--lead', 'trail---', 'x'.repeat(60), 'a'.repeat(39) + ' b', '', '!!!', 'café ad',
  ]) {
    assert.equal(normalizeTag(name), pageClean(name), `disagree on ${JSON.stringify(name)}`);
  }
});

// ── counting ─────────────────────────────────────────────────────────────────

test('a click with an untidy name is counted under its tag, not dropped', async () => {
  fresh();
  // Posted straight to the endpoint, without the page to tidy it first.
  const res = await post({ event: 'ad_click', ad: 'Bill Shock', platform: 'ios' });
  assert.equal(res.statusCode, 204);
  assert.equal(globalThis.__table.get(`AD#${today}`)['bill-shock:ios'], 1);
  assert.equal(globalThis.__table.get('TOTAL').ad_click, 1);
});

test('a click with no usable name, or no real platform, counts nothing', async () => {
  fresh();
  assert.equal((await post({ event: 'ad_click', ad: '!!!', platform: 'ios' })).statusCode, 400);
  assert.equal((await post({ event: 'ad_click', ad: 'video3', platform: 'watch' })).statusCode, 400);
  assert.equal(globalThis.__table.size, 0);
});

test('bots are not counted', async () => {
  fresh();
  const res = await post({ event: 'ad_click', ad: 'video3', platform: 'ios' }, 'facebookexternalhit/1.1');
  assert.equal(res.statusCode, 204);
  assert.equal(globalThis.__table.size, 0);
});

// ── reading ──────────────────────────────────────────────────────────────────

test('ad clicks come back one day at a time, split by platform', async () => {
  fresh();
  globalThis.__table.set('AD#2020-01-01', { pk: 'AD#2020-01-01', 'old:ios': 9 }); // outside the window
  const d1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  globalThis.__table.set(`AD#${d1}`, { pk: `AD#${d1}`, 'video3:ios': 2, 'video3:android': 1, 'bill-shock:desktop': 4 });
  await post({ event: 'ad_click', ad: 'video3', platform: 'ios' });

  const body = JSON.parse((await get(30)).body);
  assert.deepEqual(body.ads_daily, [
    { date: d1, name: 'bill-shock', ios: 0, android: 0, desktop: 4, total: 4 },
    { date: d1, name: 'video3', ios: 2, android: 1, desktop: 0, total: 3 },
    { date: today, name: 'video3', ios: 1, android: 0, desktop: 0, total: 1 },
  ]);
});

test('the daily rows and the window total are the same clicks', async () => {
  fresh();
  const d1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  globalThis.__table.set(`AD#${d1}`, { pk: `AD#${d1}`, 'video3:ios': 2, 'video3:android': 1 });
  await post({ event: 'ad_click', ad: 'video3', platform: 'ios' });
  const body = JSON.parse((await get(30)).body);
  const fromDays = body.ads_daily.filter((r) => r.name === 'video3').reduce((n, r) => n + r.total, 0);
  assert.equal(fromDays, body.ads.find((r) => r.name === 'video3').total);
  assert.equal(fromDays, 4);
});

test('no ad clicks is an empty list, and the older fields are all still there', async () => {
  fresh();
  const body = JSON.parse((await get(7)).body);
  assert.deepEqual(body.ads_daily, []);
  for (const key of ['total', 'daily', 'sources', 'utm_sources', 'utm_mediums', 'ads']) assert.ok(key in body, key);
  assert.equal(body.daily.length, 7);
});

test('the stats still need the passphrase', async () => {
  fresh();
  assert.equal((await get(30, 'wrong')).statusCode, 401);
  assert.equal((await handler({ requestContext: { http: { method: 'GET' } }, headers: {} })).statusCode, 401);
});

test('a row that is not an ad day is ignored', () => {
  assert.deepEqual(adsDaily([{ pk: 'TOTAL', ad_click: 3 }, { pk: 'AD#nonsense', 'x:ios': 1 }]), []);
  assert.deepEqual(adsDaily(undefined), []);
});
