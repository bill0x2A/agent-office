import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalSessions, chatCommand, parseTranscript } from '../src/server/local-sessions.js';
import { previewUrl, sessionUrls } from '../src/shared/local-sessions.js';

const id = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('Codex exposes conversation, not system messages, analysis or tool output', () => {
  const parsed = parseTranscript(jsonl(
    { type: 'session_meta', payload: { id, cwd: '/project' } },
    { type: 'response_item', payload: { type: 'message', role: 'system', content: 'secret' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: 'private reasoning' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'sensitive tool output' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>host data</environment_context>Build a garden' }] } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready at http://localhost:3000' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ) + '{"partial":', 'codex');
  assert.equal(parsed.id, id);
  assert.equal(parsed.status, 'idle');
  assert.deepEqual(parsed.messages.map((m) => m.text), ['Build a garden', 'Ready at http://localhost:3000']);
});

test('Claude ignores thinking, tool blocks and metadata', () => {
  const parsed = parseTranscript(jsonl(
    { type: 'user', sessionId: id, cwd: '/project', message: { content: 'Hello' } },
    { type: 'user', isMeta: true, message: { content: 'hidden instructions' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', input: 'private' }, { type: 'text', text: 'Hello back' }] } },
    { type: 'custom-title', customTitle: 'Our garden' },
  ), 'claude');
  assert.equal(parsed.title, 'Our garden');
  assert.deepEqual(parsed.messages.map((m) => m.text), ['Hello', 'Hello back']);
});

test('navigation rejects script and credential URLs and prioritizes local previews', () => {
  assert.equal(previewUrl('javascript:alert(1)'), null);
  assert.equal(previewUrl('file:///etc/passwd'), null);
  assert.equal(previewUrl('https://user:password@example.com'), null);
  assert.deepEqual(sessionUrls('See https://example.com/help and (http://localhost:3000/). http://localhost:3000/'), ['http://localhost:3000/', 'https://example.com/help']);
});

test('chat forks first, then resumes only the office continuation without shell interpolation', () => {
  const codex = chatCommand('codex', id);
  assert.ok(codex.args.includes('fork'));
  assert.ok(codex.args.includes('read-only'));
  assert.equal(codex.args.at(-1), '-');
  const continued = chatCommand('codex', id, second);
  assert.ok(continued.args.includes('resume'));
  assert.ok(continued.args.includes(second));
  assert.ok(!continued.args.includes(id));
  assert.ok(chatCommand('claude', id).args.includes('--fork-session'));
  assert.ok(!chatCommand('claude', id, second).args.includes('--fork-session'));
  assert.throws(() => chatCommand('codex', '--last; rm -rf /'), /Invalid session/);
});

test('discovers real formats, rejects arbitrary keys and excludes symlinked transcripts', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'office-sessions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codex = path.join(home, '.codex');
  const claude = path.join(home, '.claude');
  const cdir = path.join(codex, 'sessions/2026/09/30');
  const adir = path.join(claude, 'projects/project');
  await Promise.all([mkdir(cdir, { recursive: true }), mkdir(adir, { recursive: true })]);
  await writeFile(path.join(cdir, 'rollout.jsonl'), jsonl(
    { type: 'session_meta', payload: { id, cwd: home } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'A real session' } },
  ));
  await writeFile(path.join(codex, 'session_index.jsonl'), jsonl({ id, thread_name: 'Friendly title' }));
  await writeFile(path.join(adir, `${second}.jsonl`), jsonl({ type: 'user', sessionId: second, cwd: home, message: { content: 'Claude here' } }));
  const outside = path.join(home, 'outside.jsonl');
  await writeFile(outside, jsonl({ type: 'session_meta', payload: { id: '33333333-3333-4333-8333-333333333333', cwd: home } }));
  await symlink(outside, path.join(cdir, 'symlink.jsonl'));
  const reader = new LocalSessions(home, codex, claude);
  const sessions = await reader.list();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((s) => s.provider === 'codex')?.title, 'Friendly title');
  const detail = await reader.detail(`claude:${second}`);
  assert.equal(detail.messages[0].text, 'Claude here');
  await assert.rejects(() => reader.detail('../../etc/passwd'), /no longer available/);
  await assert.rejects(() => reader.send(`codex:${id}`, ' '), /Write a message/);
});

test('a transcript swapped to a symlink after discovery cannot escape its root', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'office-sessions-swap-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codex = path.join(home, '.codex');
  const dir = path.join(codex, 'sessions');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout.jsonl');
  await writeFile(file, jsonl({ type: 'session_meta', payload: { id, cwd: home } }));
  const reader = new LocalSessions(home, codex, path.join(home, '.claude'));
  await reader.list();
  const outside = path.join(home, 'outside');
  await writeFile(outside, 'private');
  await rm(file); await symlink(outside, file);
  await assert.rejects(() => reader.detail(`codex:${id}`), /Invalid transcript path/);
});

test('chat streams a mock CLI reply and resumes its continuation with literal stdin', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'office-chat-'));
  const previousPath = process.env.PATH;
  t.after(async () => { process.env.PATH = previousPath; await rm(home, { recursive: true, force: true }); });
  const codex = path.join(home, '.codex');
  await mkdir(path.join(codex, 'sessions'), { recursive: true });
  await writeFile(path.join(codex, 'sessions/rollout.jsonl'), jsonl({ type: 'session_meta', payload: { id, cwd: home } }));
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  const executable = path.join(bin, 'codex');
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(path.join(home, 'calls.jsonl'))},JSON.stringify({args:process.argv.slice(2),text})+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'${second}'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Hello from a test coworker'}}));});\n`);
  await chmod(executable, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const reader = new LocalSessions(home, codex, path.join(home, '.claude'));
  t.after(() => reader.shutdown());
  const key = `codex:${id}`;
  const attempts = await Promise.allSettled([reader.send(key, 'Hello $(this is literal text)'), reader.send(key, 'racing request')]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].status, 'rejected');
  if (attempts[0].status !== 'fulfilled') throw attempts[0].reason;
  const chat = attempts[0].value;
  await assert.rejects(() => reader.send(key, 'concurrent'), /still answering/);
  const wait = async () => {
    for (let i = 0; i < 200 && chat.running; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(chat.running, false);
    assert.equal(chat.error, undefined);
  };
  await wait();
  assert.equal(chat.continuationId, second);
  assert.equal(chat.messages.at(-1)?.text, 'Hello from a test coworker');
  await reader.send(key, 'And another');
  await wait();
  const calls = (await readFile(path.join(home, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls[0].text, 'Hello $(this is literal text)');
  assert.ok(calls[0].args.includes('fork'));
  assert.ok(calls[1].args.includes('resume'));
  assert.ok(calls[1].args.includes(second));
});
