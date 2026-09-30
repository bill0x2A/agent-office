import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Integrations } from '../src/server/integrations.js';

function fixture(t: { after(fn: () => void): void }, handler: (url: string, init: RequestInit) => Response | Promise<Response>, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-integrations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: { url: string; init: RequestInit }[] = [];
  const request = (async (input, init) => { const url = String(input); calls.push({ url, init: init! }); return handler(url, init!); }) as typeof fetch;
  return { dir, calls, request, app: new Integrations(dir, request, env) };
}
const json = (data: unknown) => Response.json(data);

test('tokens are verified, saved privately, never returned, and removed without losing floor bindings', async (t) => {
  const { app, dir, request } = fixture(t, () => json({ data: { viewer: { id: 'me' } } }));
  await app.connect('linear', 'test-secret-key');
  app.bind('garden', { team: 'team-1', project: 'project-1', channel: 'C123' });
  assert.equal(statSync(path.join(dir, 'integrations.json')).mode & 0o777, 0o600);
  const restarted = new Integrations(dir, request, {});
  assert.equal(restarted.status('garden').linear, true);
  assert.equal(JSON.stringify(restarted.status('garden')).includes('test-secret-key'), false);
  assert.equal(restarted.status('garden').binding.channel, 'C123');
  restarted.disconnect('linear');
  assert.equal(restarted.status('garden').linear, false);
  assert.equal(readFileSync(path.join(dir, 'integrations.json'), 'utf8').includes('test-secret-key'), false);
  assert.equal(restarted.status('garden').binding.team, 'team-1');
});

test('failed authentication does not overwrite a good token; remote failures do not echo secrets', async (t) => {
  const { app, dir } = fixture(t, (_url, init) => (init.headers as Record<string, string>).Authorization === 'good-key' ? json({ data: { viewer: { id: 'me' } } }) : json({ errors: [{ message: 'secret-key should not appear' }] }));
  await app.connect('linear', 'good-key');
  await assert.rejects(() => app.connect('linear', 'bad-key'), /Check your API key/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'integrations.json'), 'utf8')).linear, 'good-key');
  await assert.rejects(() => app.connect('slack', 'contains\nnewline'), /valid API token/);
});

test('Linear queries use per-floor filters and cached read-only requests', async (t) => {
  const { app, calls } = fixture(t, () => json({ data: { issues: { nodes: [{ identifier: 'ABC-1', title: 'Build garden' }], pageInfo: { hasNextPage: true } } } }), { LINEAR_API_KEY: 'key' });
  app.bind('garden', { team: 'team-1', project: 'project-2' });
  const result = await app.issues('garden');
  await app.issues('garden');
  assert.equal(result.issues[0].identifier, 'ABC-1');
  assert.equal(result.more, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(body.variables.filter, { team: { id: { eq: 'team-1' } }, project: { id: { eq: 'project-2' } } });
  assert.ok(!body.query.includes('mutation'));
  await app.issues('other');
  assert.deepEqual(JSON.parse(calls[1].init.body as string).variables.filter, {});
  assert.throws(() => app.bind('garden', { channel: '../secret' }), /Invalid/);
});

test('Slack supports channel pagination, display names, cached history and source links without writes', async (t) => {
  const { app, calls } = fixture(t, (url) => {
    if (url.includes('auth.test')) return json({ ok: true, team_id: 'T123' });
    if (url.includes('users.list')) return json({ ok: true, members: [{ id: 'U123', profile: { display_name: 'Alex' } }] });
    if (url.includes('conversations.list')) return json({ ok: true, channels: [{ id: 'C123', name: 'garden' }], response_metadata: { next_cursor: 'next==' } });
    return json({ ok: true, has_more: true, messages: [{ ts: '10.001', text: '<hello>', user: 'U123', reply_count: 2 }, { ts: '9.001', files: [{}] }] });
  }, { SLACK_BOT_TOKEN: 'slack-key' });
  const channels = await app.channels('previous==');
  assert.equal(channels.cursor, 'next==');
  assert.equal(new URL(calls[0].url).searchParams.get('cursor'), 'previous==');
  app.bind('garden', { channel: 'C123' });
  const history = await app.messages('garden');
  assert.equal(history.messages[1].author, 'Alex');
  assert.equal(history.messages[1].text, '<hello>');
  assert.match(history.messages[1].url, /T123\/C123\/thread\/C123-10.001/);
  assert.match(history.messages[0].text, /File attachment/);
  await app.messages('garden');
  assert.equal(calls.filter((c) => c.url.includes('conversations.history')).length, 1);
  assert.ok(calls.every((c) => !c.init.method || c.init.method === 'GET'));
});

test('Slack rate limits are respected instead of repeatedly hitting the API', async (t) => {
  const { app, calls } = fixture(t, () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }), { SLACK_BOT_TOKEN: 'key' });
  await assert.rejects(() => app.channels(), /120 seconds/);
  await assert.rejects(() => app.channels(), /rate limited/);
  assert.equal(calls.length, 1);
});

test('Slack public-channel fallback works without private-channel scopes', async (t) => {
  const { app, calls } = fixture(t, (url) => new URL(url).searchParams.get('types')!.includes('private') ? json({ ok: false, error: 'missing_scope' }) : json({ ok: true, channels: [{ id: 'C123', name: 'general' }] }), { SLACK_BOT_TOKEN: 'key' });
  assert.equal((await app.channels()).channels[0].name, 'general');
  assert.equal(calls.length, 2);
});

test('environment token remains explicit when a saved token is removed', async (t) => {
  const { app } = fixture(t, () => json({ data: { viewer: { id: 'me' } } }), { LINEAR_API_KEY: 'environment-key' });
  await app.connect('linear', 'saved-key');
  app.disconnect('linear');
  assert.equal(app.status('any').linear, true);
  assert.equal(app.status('any').linearEnv, true);
});
