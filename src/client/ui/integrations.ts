import type { IntegrationBinding, IntegrationChoice, IntegrationStatus, LinearIssue, SlackMessage } from '../../shared/integrations';
import { store } from '../state';
import { h, openModal } from './dom';

type Provider = 'linear' | 'slack';
async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/integrations/${route}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not reach the integration');
  return data;
}
function link(label: string, raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { return h('span', {}, label); }
  return url.protocol === 'https:' ? h('a.btn', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, label) : h('span', {}, label);
}
function select(label: string, choices: IntegrationChoice[], chosen?: string, empty = 'All') {
  const el = h('select', { 'aria-label': label }, h('option', { value: '' }, empty), ...choices.map((x) => h('option', { value: x.id }, x.name)));
  if (chosen && !choices.some((x) => x.id === chosen)) el.append(h('option', { value: chosen }, 'Saved selection'));
  el.value = chosen ?? '';
  return el;
}

/** Both integrations stay inside the office, with an external link for the full source app. */
export function openIntegration(provider: Provider, draftTask: (issue: LinearIssue) => void) {
  const floor = store.floor;
  const floorName = store.floors.find((f) => f.id === floor)?.name;
  const name = provider === 'linear' ? 'Linear' : 'Slack';
  const body = h('div.body.integration-body');
  const status = h('p.setting-note', { role: 'status' });
  const controls = h('div.integration-controls');
  let closed = false;
  let loading = false;
  let state: IntegrationStatus;
  const refresh = h('button.btn', { type: 'button', onclick: () => void load() }, 'Refresh');
  const settings = h('button.btn', { type: 'button', onclick: () => connection() }, 'Connection');
  const modal = openModal(h('div.modal.integration-panel', { role: 'dialog', 'aria-label': `${name} office panel` },
    h('header', {}, h('h2', {}, provider === 'linear' ? '◈ Linear task board' : '💬 Slack lounge'), refresh, settings),
    h('div.integration-intro', {}, h('strong', {}, floorName ?? 'Choose a project floor'),
      h('span', {}, provider === 'linear' ? 'Issues to share with your coworkers' : 'A little window into your team’s day')),
    controls, status, body), { onClose: () => { closed = true; } });

  function connection() {
    const token = h('input', { type: 'password', 'aria-label': `${name} token`, placeholder: provider === 'linear' ? 'Linear personal API key' : 'Slack bot token (xoxb-…)', autocomplete: 'off', required: true });
    const note = h('p.setting-note', { role: 'status' }, 'The token is stored on this machine and is never sent back to your browser.');
    const submit = h('button.btn.primary', { type: 'submit' }, `Connect ${name}`);
    const disconnect = h('button.btn', { type: 'button', disabled: !state?.[provider], onclick: async () => {
      disconnect.disabled = true;
      try { await api('disconnect', { provider }); dialog.close(); void load(); }
      catch (error) { note.textContent = (error as Error).message; disconnect.disabled = false; }
    } }, 'Remove saved token');
    const form = h('form.integration-connect', {}, h('label', {}, `${name} token`, token),
      h('p', {}, provider === 'linear'
        ? 'Create a read-only personal API key in Linear → Settings → Security & access → Personal API keys. Give it access to the teams you want here.'
        : 'Install a Slack app with channels:read and channels:history, then invite its bot to the channels you want to read. Add groups:read and groups:history for private channels; users:read shows names.'),
      link(provider === 'linear' ? 'Linear API key guide ↗' : 'Slack app setup ↗', provider === 'linear' ? 'https://linear.app/developers/graphql' : 'https://docs.slack.dev/quickstart/'),
      state?.[provider === 'linear' ? 'linearEnv' : 'slackEnv'] ? h('p', {}, 'An environment token is also configured. Removing the saved token falls back to that token; unset it on the server to disconnect fully.') : null,
      note, h('div.integration-actions', {}, submit, disconnect));
    const dialog = openModal(h('div.modal', { role: 'dialog', 'aria-label': `Connect ${name}` }, h('header', {}, h('h2', {}, `Connect ${name}`)), h('div.body', {}, form)));
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (submit.disabled) return;
      submit.disabled = true; note.textContent = 'Checking the connection…';
      try { await api('connect', { provider, token: token.value }); token.value = ''; dialog.close(); void load(); }
      catch (error) { note.textContent = (error as Error).message; submit.disabled = false; }
    });
  }

  async function bind(binding: IntegrationBinding) {
    await api('binding', { floor, binding: { ...state.binding, ...binding } });
    await load();
  }

  async function linear() {
    let issueError = '';
    const [catalog, data] = await Promise.all([
      api<{ teams: IntegrationChoice[]; projects: IntegrationChoice[] }>('linear/catalog'),
      api<{ issues: LinearIssue[]; more: boolean }>(`linear/issues?floor=${encodeURIComponent(floor!)}`).catch((error) => { issueError = (error as Error).message; return { issues: [], more: false }; }),
    ]);
    if (closed) return;
    const team = select('Linear team', catalog.teams, state.binding.team, 'All teams');
    const project = select('Linear project', catalog.projects, state.binding.project, 'All projects');
    const save = h('button.btn', { type: 'button', onclick: async () => {
      save.disabled = true;
      try { await bind({ team: team.value, project: project.value }); }
      catch (error) { status.textContent = (error as Error).message; save.disabled = false; }
    } }, 'Save floor view');
    const search = h('input', { type: 'search', 'aria-label': 'Search Linear issues', placeholder: 'Find an issue in this view…' });
    controls.replaceChildren(team, project, save, search);
    const render = () => {
      const q = search.value.toLowerCase();
      const issues = data.issues.filter((x) => `${x.identifier} ${x.title} ${x.assignee?.name ?? ''} ${x.state.name}`.toLowerCase().includes(q));
      body.replaceChildren(...issues.map((issue) => {
        const makeTask = h('button.btn.primary', { type: 'button', onclick: () => {
          if (store.floor !== floor) { status.textContent = 'The floor changed. Reopen Linear on the project you want.'; return; }
          modal.close(); draftTask(issue);
        } }, 'Make coworker task');
        const details = h('details', {}, h('summary', {}, 'Issue details'), h('p.integration-description', {}, issue.description || 'No description.'));
        return h('article.integration-card', {}, h('div.integration-meta', {}, issue.identifier, h('span.pill', {}, issue.state.name)),
          h('h3', {}, issue.title), h('p.setting-note', {}, [issue.project?.name, issue.assignee?.name ?? 'Unassigned', ['No priority', 'Urgent', 'High', 'Normal', 'Low'][issue.priority]].filter(Boolean).join(' · ')),
          details, h('div.integration-actions', {}, makeTask, link('Open in Linear ↗', issue.url)));
      }));
      if (!issues.length) body.append(h('p.empty', {}, q ? 'No issues match your search.' : 'No issues in this view. Try another team or project.'));
    };
    search.addEventListener('input', render); render();
    status.textContent = issueError || `${data.issues.length} recently updated issues${data.more ? ' · newest 100 shown; narrow by team or project' : ''}. Tasks open as drafts for this floor. Refresh checks at most every 30 seconds.`;
  }

  async function slack() {
    let historyError = '';
    const [data, history] = await Promise.all([
      api<{ channels: IntegrationChoice[]; cursor: string }>('slack/channels'),
      api<{ messages: SlackMessage[]; url: string; more: boolean }>(`slack/messages?floor=${encodeURIComponent(floor!)}`).catch((error) => { historyError = (error as Error).message; return { messages: [], url: 'https://app.slack.com', more: false }; }),
    ]);
    if (closed) return;
    const channel = select('Slack channel', data.channels, state.binding.channel, 'Choose a channel');
    const more = h('button.btn', { type: 'button', disabled: !data.cursor, onclick: async () => {
      more.disabled = true;
      try {
        const next = await api<{ channels: IntegrationChoice[]; cursor: string }>(`slack/channels?cursor=${encodeURIComponent(data.cursor)}`);
        if (closed) return;
        for (const c of next.channels) if (![...channel.options].some((o) => o.value === c.id)) channel.append(h('option', { value: c.id }, c.name));
        data.cursor = next.cursor; more.disabled = !next.cursor;
      } catch (error) { status.textContent = (error as Error).message; more.disabled = false; }
    } }, 'More channels');
    const save = h('button.btn', { type: 'button', onclick: async () => {
      save.disabled = true;
      try { await bind({ channel: channel.value }); }
      catch (error) { status.textContent = (error as Error).message; save.disabled = false; }
    } }, 'Save channel');
    controls.replaceChildren(channel, save, more, link('Open Slack ↗', history.url));
    body.replaceChildren(...history.messages.map((message) => h('article.integration-card.slack-message', {},
      h('div.integration-meta', {}, h('strong', {}, message.author), new Date(Number(message.ts) * 1000).toLocaleString()),
      h('p.integration-description', {}, message.text.replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')),
      link(message.replies ? `${message.replies} replies · Open thread ↗` : 'Open message ↗', message.url))));
    if (!history.messages.length) body.append(h('p.empty', {}, state.binding.channel ? 'No recent messages here.' : 'Choose a channel to bring your team into the lounge.'));
    status.textContent = historyError || 'Read-only channel view · newest 15 messages · refreshes at most once a minute. Open Slack for older messages, threads, and replies.';
  }

  async function load() {
    if (closed || loading) return;
    loading = true; refresh.disabled = true; settings.disabled = true;
    status.textContent = `Loading ${name}…`;
    try {
      state = await api<IntegrationStatus>(`status?floor=${encodeURIComponent(floor ?? '')}`);
      if (closed) return;
      body.replaceChildren(); controls.replaceChildren();
      if (!state[provider]) {
        body.append(h('div.integration-empty', {}, h('h3', {}, provider === 'linear' ? 'A home for your team’s next ideas' : 'Pull up a chair with your team'),
          h('p', {}, `Connect ${name} once, then choose a view for each project floor.`), h('button.btn.primary', { type: 'button', onclick: connection }, `Connect ${name}`),
          link(`Open ${name} ↗`, provider === 'linear' ? 'https://linear.app' : 'https://app.slack.com')));
        status.textContent = 'Not connected yet';
      } else if (!floorName) { status.textContent = 'Ride to a project floor to choose its view.'; }
      else if (provider === 'linear') await linear();
      else await slack();
    } catch (error) { if (!closed) status.textContent = (error as Error).message; }
    finally { loading = false; if (!closed) { refresh.disabled = false; settings.disabled = false; } }
  }
  void load();
}
