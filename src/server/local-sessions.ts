import { open, readdir, stat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { childEnv, resolveCommand } from './workers.js';
import { sessionUrls, type LocalChat, type LocalMessage, type LocalSession } from '../shared/local-sessions.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const WINDOW = 256 * 1024;
type Row = Record<string, any>;
function lines(text: string): Row[] {
  return text.split('\n').flatMap((line) => {
    try { const v = JSON.parse(line); return v && typeof v === 'object' ? [v] : []; } catch { return []; }
  });
}
function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((v) => ['text', 'input_text', 'output_text'].includes(v?.type) && typeof v.text === 'string').map((v) => v.text).join('\n');
}
function userText(text: string): string {
  return text.replace(/<(environment_context|external_codex_apps_open_page|system-reminder)>[\s\S]*?<\/\1>/g, '').trim();
}

/** Only public conversational text: never reasoning, tool payloads, or system/developer messages. */
export function parseTranscript(text: string, provider: LocalSession['provider']): { id?: string; cwd?: string; title?: string; messages: LocalMessage[]; status?: 'working' | 'idle'; hidden: boolean } {
  const result: ReturnType<typeof parseTranscript> = { messages: [], hidden: false };
  for (const row of lines(text)) {
    if (provider === 'codex') {
      const p = row.payload;
      if (row.type === 'session_meta' && p) {
        result.id = p.id ?? p.session_id;
        result.cwd = p.cwd;
        result.hidden = typeof p.source === 'object' && !!p.source?.subagent;
      }
      if (row.type === 'event_msg') {
        if (p?.type === 'task_started') result.status = 'working';
        if (['task_complete', 'task_completed', 'turn_aborted'].includes(p?.type)) result.status = 'idle';
      }
      if (row.type !== 'response_item' || p?.type !== 'message' || !['user', 'assistant'].includes(p.role) || p.channel === 'analysis') continue;
      const text = p.role === 'user' ? userText(content(p.content)) : content(p.content);
      if (text) result.messages.push({ role: p.role, text: text.slice(0, 12000), at: row.timestamp });
    } else {
      if (typeof row.sessionId === 'string') result.id = row.sessionId;
      if (typeof row.cwd === 'string') result.cwd = row.cwd;
      if (row.isSidechain) result.hidden = true;
      if (row.type === 'custom-title' && typeof row.customTitle === 'string') result.title = row.customTitle;
      if (!['user', 'assistant'].includes(row.type) || row.isMeta) continue;
      const text = row.type === 'user' ? userText(content(row.message?.content)) : content(row.message?.content);
      if (text && !text.startsWith('<local-command') && !text.startsWith('<command-name>')) result.messages.push({ role: row.type, text: text.slice(0, 12000), at: row.timestamp });
    }
  }
  return result;
}

/** Bounded reads handle large transcripts and a partially written final line. */
async function windows(file: string): Promise<{ head: string; tail: string; mtime: number }> {
  const f = await open(file, 'r');
  try {
    const s = await f.stat();
    if (!s.isFile()) throw new Error('Not a transcript');
    const head = Buffer.alloc(Math.min(WINDOW, s.size));
    await f.read(head, 0, head.length, 0);
    if (s.size <= WINDOW) return { head: head.toString(), tail: '', mtime: s.mtimeMs };
    const tail = Buffer.alloc(Math.min(WINDOW, s.size - WINDOW));
    await f.read(tail, 0, tail.length, s.size - tail.length);
    const text = tail.toString();
    return { head: head.toString(), tail: text.slice(text.indexOf('\n') + 1), mtime: s.mtimeMs };
  } finally { await f.close(); }
}

export function chatCommand(provider: LocalSession['provider'], id: string, continuation?: string): { cmd: string; args: string[] } {
  if (!UUID.test(id) || (continuation && !UUID.test(continuation))) throw new Error('Invalid session');
  return provider === 'codex'
    ? { cmd: 'codex', args: ['exec', '--sandbox', 'read-only', continuation ? 'resume' : 'fork', '--json', '--skip-git-repo-check', continuation ?? id, '-'] }
    : { cmd: 'claude', args: ['--print', '--resume', continuation ?? id, ...(!continuation ? ['--fork-session'] : []), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'] };
}

export class LocalSessions {
  private files = new Map<string, string>();
  private sessions: LocalSession[] = [];
  private scanned = 0;
  private scanning?: Promise<LocalSession[]>;
  private chats = new Map<string, LocalChat>();
  private children = new Map<string, ChildProcess>();
  private pending = new Set<string>();
  private parsed = new Map<string, { mtime: number; head: ReturnType<typeof parseTranscript>; tail: ReturnType<typeof parseTranscript> }>();
  private roots: { dir: string; provider: LocalSession['provider']; depth: number }[];
  constructor(private home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'), private claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')) {
    this.roots = [{ dir: path.join(codexHome, 'sessions'), provider: 'codex', depth: 4 }, { dir: path.join(claudeHome, 'projects'), provider: 'claude', depth: 1 }];
  }

  async list(): Promise<LocalSession[]> {
    if (Date.now() - this.scanned < 5000) return this.sessions;
    return this.scanning ??= this.scan().finally(() => { this.scanning = undefined; });
  }

  private async scan(): Promise<LocalSession[]> {
    const found: { file: string; provider: LocalSession['provider']; mtime: number }[] = [];
    for (const root of this.roots) {
      const walk = async (dir: string, depth: number): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (found.length >= 4000) return;
          const file = path.join(dir, entry.name);
          if (entry.isDirectory() && depth > 0) await walk(file, depth - 1);
          if (entry.isFile() && entry.name.endsWith('.jsonl') && (root.provider === 'codex' || UUID.test(entry.name.slice(0, -6)))) {
            const s = await stat(file).catch(() => null);
            if (s) found.push({ file, provider: root.provider, mtime: s.mtimeMs });
          }
        }
      };
      await walk(root.dir, root.depth);
    }
    const names = new Map<string, string>();
    const index = await windows(path.join(this.roots[0].dir, '..', 'session_index.jsonl')).catch(() => null);
    if (index) for (const r of lines(index.head + '\n' + index.tail)) if (typeof r.thread_name === 'string') names.set(r.id, r.thread_name);
    const live = new Map<string, Row>();
    for (const f of await readdir(path.join(this.claudeHome, 'sessions'), { withFileTypes: true }).catch(() => [])) {
      if (!f.isFile() || !/^\d+\.json$/.test(f.name)) continue;
      try {
        const r = JSON.parse(await readFile(path.join(this.claudeHome, 'sessions', f.name), 'utf8'));
        if (!Number.isSafeInteger(r.pid) || r.pid <= 0) continue;
        process.kill(r.pid, 0);
        if (typeof r.sessionId === 'string') live.set(r.sessionId, r);
      } catch { /* Exited processes and torn records are not live sessions. */ }
    }
    const sessions: LocalSession[] = [];
    const files = new Map<string, string>();
    for (const f of found.sort((a, b) => b.mtime - a.mtime).slice(0, 120)) {
      try {
        let cached = this.parsed.get(f.file);
        if (!cached || cached.mtime !== f.mtime) {
          const w = await windows(f.file);
          cached = { mtime: f.mtime, head: parseTranscript(w.head, f.provider), tail: parseTranscript(w.tail, f.provider) };
          this.parsed.set(f.file, cached);
        }
        const { head, tail } = cached;
        const id = head.id ?? tail.id;
        const cwd = head.cwd ?? tail.cwd;
        if (!id || !UUID.test(id) || !cwd || !path.isAbsolute(cwd) || head.hidden) continue;
        // Continuations made by this office already have a home in their parent's chat.
        if ([...this.chats.values()].some((c) => c.continuationId === id)) continue;
        const key = `${f.provider}:${id}`;
        if (files.has(key)) continue;
        const messages = [...head.messages, ...tail.messages];
        const running = live.get(id);
        const age = Date.now() - f.mtime;
        const inferred = tail.status ?? head.status;
        const status = running ? (running.status === 'busy' ? 'working' : 'idle') : f.provider === 'codex' && inferred === 'working' && age < 120_000 ? 'working' : age < 3600_000 ? 'recent' : 'saved';
        const title = names.get(id) ?? tail.title ?? head.title ?? messages.find((m) => m.role === 'user')?.text.replace(/<[^>]*>/g, '').trim().split('\n')[0] ?? `${f.provider} session`;
        sessions.push({ key, id, provider: f.provider, title: title.slice(0, 140), cwd, project: path.basename(cwd), updatedAt: f.mtime, status, live: !!running, urls: sessionUrls(messages.slice(-12).map((m) => m.text).join('\n')) });
        files.set(key, f.file);
      } catch { /* A deleted, unavailable or malformed transcript cannot break the office. */ }
    }
    const retained = new Set(files.values());
    for (const file of this.parsed.keys()) if (!retained.has(file)) this.parsed.delete(file);
    this.files = files;
    this.sessions = sessions.sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt).slice(0, 60);
    this.scanned = Date.now();
    return this.sessions;
  }

  async detail(key: string) {
    const session = (await this.list()).find((s) => s.key === key);
    const file = this.files.get(key);
    if (!session || !file) throw new Error('Session no longer available');
    // Recheck containment immediately before opening: keys never become filesystem paths.
    const root = this.roots.find((r) => r.provider === session.provider)!;
    const [actual, base] = await Promise.all([realpath(file), realpath(root.dir)]);
    if (!actual.startsWith(base + path.sep)) throw new Error('Invalid transcript path');
    const w = await windows(actual);
    const messages = parseTranscript(w.tail || w.head, session.provider).messages.slice(-40);
    return { session, messages, chat: this.chats.get(key) ?? { messages: [], running: false } as LocalChat };
  }

  async send(key: string, prompt: string): Promise<LocalChat> {
    if (!prompt.trim() || prompt.length > 12000) throw new Error('Write a message of 1–12,000 characters');
    if (this.children.size + this.pending.size >= 3) throw new Error('Three coworkers are answering already. Try again shortly.');
    if (this.pending.has(key) || this.chats.get(key)?.running) throw new Error('This coworker is still answering');
    this.pending.add(key);
    try {
      const { session } = await this.detail(key);
      const chat = this.chats.get(key) ?? { messages: [], running: false };
      if (chat.running) throw new Error('This coworker is still answering');
      const { cmd, args } = chatCommand(session.provider, session.id, chat.continuationId);
      const executable = resolveCommand(cmd);
      if (!executable) throw new Error(`${cmd} is not installed on PATH`);
      if (!(await stat(session.cwd).catch(() => null))?.isDirectory()) throw new Error('The project folder is no longer available');
      chat.running = true;
      delete chat.error;
      chat.messages.push({ role: 'user', text: prompt, at: new Date().toISOString() });
      chat.messages = chat.messages.slice(-80);
      this.chats.set(key, chat);
      const child = spawn(executable, args, { cwd: session.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.children.set(key, child);
      let buffer = '', stderr = '', bytes = 0, answered = false;
      const timer = setTimeout(() => { chat.error = 'The reply timed out after five minutes.'; child.kill(); }, 300_000);
      timer.unref();
      const finish = () => { clearTimeout(timer); chat.running = false; this.children.delete(key); this.scanned = 0; };
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { chat.error = 'Reply exceeded the output limit.'; child.kill(); return; }
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          for (const event of lines(line)) {
            const id = event.thread_id ?? event.session_id;
            if (typeof id === 'string' && UUID.test(id) && id !== session.id) chat.continuationId = id;
            const text = event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text
              : event.type === 'assistant' ? content(event.message?.content)
              : event.type === 'result' && !answered && !event.is_error ? event.result : undefined;
            if (typeof text === 'string' && text.trim()) { chat.messages.push({ role: 'assistant', text: text.slice(0, 24000), at: new Date().toISOString() }); answered = true; }
            if (event.type === 'error' || event.type === 'turn.failed' || event.is_error) chat.error = String(event.message ?? event.error?.message ?? event.result ?? 'The agent could not complete its reply').slice(0, 1000);
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on('error', (e) => { chat.error = e.message; finish(); });
      child.on('close', (code) => {
        if (code !== 0 && !chat.error) chat.error = stderr.trim() || `Agent exited with code ${code}`;
        if (!answered && !chat.error) chat.error = 'No reply was returned. Check the CLI sign-in and session compatibility.';
        finish();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      return chat;
    } catch (error) {
      const chat = this.chats.get(key);
      if (chat && !this.children.has(key)) chat.running = false;
      throw error;
    } finally { this.pending.delete(key); }
  }

  shutdown() { for (const child of this.children.values()) child.kill(); }
}
