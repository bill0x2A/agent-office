import type { LocalChat, LocalMessage, LocalSession } from '../../shared/local-sessions';
import { h, openModal, timeAgo, toast } from './dom';
import { openOfficeBrowser } from './browser';

interface Seating {
  choices(key: string): { id: string; label: string }[];
  seat(key: string): string | undefined;
  move(key: string, desk: string | null): string | undefined;
}
let seating: Seating | undefined;
export function configureLocalSeating(actions: Seating) { seating = actions; }

function openSeatPicker(key: string) {
  if (!seating) return;
  const chosen = seating.seat(key);
  const error = h('p.local-error', { role: 'status' });
  const grid = h('div.local-desk-grid');
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'Move coworker to a desk' },
    h('header', {}, h('h2', {}, '🪑 Pick their desk')),
    h('div.body', {}, h('p', {}, 'Choose a free desk on this floor. Their seat is remembered in this browser.'), grid, error),
    h('footer', {}, h('button.btn', { type: 'button', onclick: () => move(null) }, 'Back to coworker area'))));
  const move = (id: string | null) => {
    const problem = seating!.move(key, id);
    if (problem) { error.textContent = problem; return; }
    modal.close();
    toast(id ? `Your coworker is now at ${id.replace('desk-', 'Desk ')}.` : 'Your coworker is back in the coworker area.');
  };
  const choices = seating.choices(key);
  grid.replaceChildren(...choices.map((d) => h('button.btn', { type: 'button', class: chosen === d.id ? 'on' : '', 'aria-pressed': String(chosen === d.id), onclick: () => move(d.id) }, `🪑 ${d.label}${chosen === d.id ? ' · current' : ''}`)));
  if (!choices.length) grid.append(h('p', {}, 'No free desks on this floor. Choose an office floor or free up a desk.'));
}

export async function localApi<T>(suffix = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/local-sessions${suffix}`, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Could not reach local sessions');
  return value as T;
}

export const localStatus = (s: LocalSession) => s.live ? `Live · ${s.status === 'working' ? 'working' : 'ready'}` : s.status === 'working' ? 'Recent activity' : s.status === 'recent' ? 'Recently used' : 'Saved session';
const provider = (s: LocalSession) => s.provider === 'claude' ? 'Claude Code' : 'Codex';

export function openLocalDirectory() {
  const list = h('div.local-session-list');
  const search = h('input', { type: 'search', placeholder: 'Find a project or conversation…', 'aria-label': 'Find a local session' });
  const state = h('p.setting-note', { role: 'status' }, 'Looking for your coworkers…');
  let sessions: LocalSession[] = [];
  let closed = false;
  const render = () => {
    const query = search.value.toLowerCase();
    const matches = sessions.filter((s) => `${s.title} ${s.project} ${s.provider}`.toLowerCase().includes(query));
    list.replaceChildren(...matches.map((s) => h('button.local-session-row', { type: 'button', onclick: () => openLocalSession(s.key) },
      h('span.local-face', { class: s.provider, 'aria-hidden': true }, s.provider === 'claude' ? '✳' : '◉'),
      h('span.local-session-label', {}, h('strong', {}, s.title), h('span', {}, `${provider(s)} · ${s.project}`)),
      h('span.local-session-state', {}, localStatus(s), h('small', {}, timeAgo(s.updatedAt))),
    )));
    if (!matches.length) list.append(h('p', {}, sessions.length ? 'No coworkers match that search.' : 'No local sessions found. Start a conversation in Claude Code or Codex, then refresh.'));
  };
  const refresh = async () => {
    try { const data = await localApi<{ sessions: LocalSession[] }>(); if (closed) return; sessions = data.sessions; state.textContent = `${sessions.length} local conversations · choose a coworker to chat or move them to a desk`; render(); }
    catch (e) { if (!closed) state.textContent = (e as Error).message; }
  };
  const modal = openModal(h('div.modal.local-directory', { role: 'dialog', 'aria-label': 'Local coworkers' },
    h('header', {}, h('h2', {}, '👋 Local coworkers'), h('button.btn', { type: 'button', onclick: () => void refresh() }, 'Refresh')),
    h('div.body', {}, h('p', {}, 'Your Claude Code and Codex conversations, right here in the office.'), search, state, list)), { onClose: () => { closed = true; } });
  search.addEventListener('input', render);
  void refresh();
  return modal;
}

export function openLocalSession(key: string) {
  const title = h('h2', {}, 'Saying hello…');
  const meta = h('p.setting-note');
  const history = h('div.local-transcript', { role: 'log', 'aria-label': 'Session conversation' });
  const links = h('div.local-preview-links');
  const error = h('p.local-error', { role: 'status' });
  const tabs = h('div.seg');
  const input = h('textarea', { rows: 2, placeholder: 'Ask what they’re working on…', 'aria-label': 'Message coworker', maxlength: 12000 });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Send');
  const note = h('p.setting-note', {}, 'Chat continues a copy of this session in read-only / plan mode. Your original session stays in its own app.');
  const form = h('form.local-chat-form', {}, input, submit);
  let closed = false, pending = false, mode: 'original' | 'chat' = 'original', signature = '';
  let detail: { session: LocalSession; messages: LocalMessage[]; chat: LocalChat } | undefined;
  const modal = openModal(h('div.modal.local-conversation', { role: 'dialog', 'aria-label': 'Local coworker conversation' },
    h('header', {}, title, h('button.btn', { type: 'button', onclick: () => openSeatPicker(key) }, '🪑 Move to desk'), h('button.btn', { type: 'button', onclick: () => openOfficeBrowser(detail?.session.urls[0]) }, '🌐 Browser')),
    meta, tabs, links, history, error, note, form), { onClose: () => { closed = true; clearTimeout(timer); } });
  let timer: ReturnType<typeof setTimeout>;
  const render = () => {
    if (!detail) return;
    const s = detail.session;
    title.textContent = `${s.provider === 'claude' ? '✳' : '◉'} ${s.project}`;
    meta.textContent = `${s.title} · ${localStatus(s)} · ${timeAgo(s.updatedAt)}`;
    meta.title = s.cwd;
    tabs.replaceChildren(...(['original', 'chat'] as const).map((tab) => h('button.btn', { type: 'button', class: mode === tab ? 'on' : '', onclick: () => { mode = tab; signature = ''; render(); } }, tab === 'original' ? 'Original session' : 'Our conversation')));
    links.replaceChildren(...s.urls.slice(0, 4).map((url) => h('button.btn', { type: 'button', title: url, onclick: () => openOfficeBrowser(url) }, `🌐 ${new URL(url).host}`)));
    const messages = mode === 'original' ? detail.messages : detail.chat.messages;
    const next = JSON.stringify([mode, messages]);
    if (next !== signature) {
      const atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 90 || !signature;
      history.replaceChildren(...messages.map((m) => h('article.local-message', { class: m.role }, h('strong', {}, m.role === 'user' ? 'You' : provider(s)), h('p', {}, m.text))));
      if (!messages.length) history.append(h('div.local-empty', {}, mode === 'chat' ? 'Say hello. Your coworker brings the original conversation’s context with them.' : 'No conversational text in the recent transcript yet.'));
      if (atBottom) history.scrollTop = history.scrollHeight;
      signature = next;
    }
    submit.disabled = pending || detail.chat.running;
    submit.textContent = detail.chat.running ? 'Thinking…' : 'Send';
    error.textContent = detail.chat.error ?? (detail.chat.running ? 'Your coworker is thinking. You can close this window and come back.' : '');
  };
  const refresh = async () => {
    try { const result = await localApi<typeof detail>(`?key=${encodeURIComponent(key)}`); if (closed) return; detail = result; render(); }
    catch (e) { if (!closed) error.textContent = (e as Error).message; }
    if (!closed) timer = setTimeout(refresh, 2500);
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || pending || detail?.chat.running) return;
    pending = true; submit.disabled = true;
    try {
      const chat = await localApi<LocalChat>('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, message }) });
      if (closed) return;
      if (detail) detail.chat = chat;
      input.value = ''; mode = 'chat'; signature = '';
    } catch (e) { if (!closed) error.textContent = (e as Error).message; }
    finally { pending = false; if (!closed) { submit.disabled = !!detail?.chat.running; if (detail?.chat.running) render(); } }
  });
  void refresh();
  return modal;
}
