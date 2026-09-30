import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IntegrationBinding, IntegrationStatus, LinearIssue, IntegrationChoice, SlackMessage } from '../shared/integrations.js';

type Provider = 'linear' | 'slack';
interface Saved { linear?: string; slack?: string; floors: Record<string, IntegrationBinding> }

/** Read-only remote adapters. Credentials never leave the server or appear in status responses. */
export class Integrations {
  private saved: Saved = { floors: {} };
  private file: string;
  private cache = new Map<string, { until: number; value: Promise<any> }>();
  private cooldown = new Map<Provider, number>();
  constructor(dataDir: string, private request: typeof fetch = fetch, private env: NodeJS.ProcessEnv = process.env) {
    this.file = path.join(dataDir, 'integrations.json');
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      this.saved = { linear: typeof data.linear === 'string' ? data.linear : undefined, slack: typeof data.slack === 'string' ? data.slack : undefined, floors: data.floors ?? {} };
      chmodSync(this.file, 0o600);
    }
  }
  private token(provider: Provider) { return this.saved[provider] || this.env[provider === 'linear' ? 'LINEAR_API_KEY' : 'SLACK_BOT_TOKEN']; }
  status(floor: string): IntegrationStatus {
    return { linear: !!this.token('linear'), slack: !!this.token('slack'), linearEnv: !!this.env.LINEAR_API_KEY, slackEnv: !!this.env.SLACK_BOT_TOKEN, binding: this.saved.floors[floor] ?? {} };
  }
  private save() {
    const tmp = this.file + `.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.cache.clear();
  }
  async connect(provider: Provider, token: string) {
    if (!token || token.length > 4096 || /\s/.test(token)) throw new Error('Enter a valid API token');
    if (provider === 'linear') await this.linear('{ viewer { id } }', {}, token);
    else await this.slack('auth.test', {}, token);
    this.saved[provider] = token;
    this.save();
  }
  disconnect(provider: Provider) { delete this.saved[provider]; this.save(); }
  bind(floor: string, input: IntegrationBinding) {
    const binding: IntegrationBinding = {};
    for (const key of ['team', 'project', 'channel'] as const) {
      const value = input[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 100 || !/^[\w-]*$/.test(value))) throw new Error('Invalid project or channel');
      if (value) binding[key] = value;
    }
    this.saved.floors[floor] = binding;
    this.save();
  }
  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const old = this.cache.get(key);
    if (old && old.until > Date.now()) return old.value;
    const value = load();
    this.cache.set(key, { until: Date.now() + ttl, value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }
  private async remote(provider: Provider, url: string, init: RequestInit) {
    const wait = this.cooldown.get(provider) ?? 0;
    if (wait > Date.now()) throw new Error(`${provider} is rate limited. Try again in ${Math.ceil((wait - Date.now()) / 1000)} seconds.`);
    let response: Response;
    try { response = await this.request(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new Error(`Could not reach ${provider}. Check your connection and try again.`); }
    if (response.status === 429) {
      const seconds = Math.max(1, Number(response.headers.get('retry-after')) || 60);
      this.cooldown.set(provider, Date.now() + seconds * 1000);
      throw new Error(`${provider} is rate limited. Try again in ${seconds} seconds.`);
    }
    if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}. Check your token and permissions.`);
    return response.json();
  }
  private async linear(query: string, variables: object = {}, token = this.token('linear')) {
    if (!token) throw new Error('Connect Linear first');
    const result = await this.remote('linear', 'https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (result.errors?.length || !result.data) throw new Error('Linear could not complete this request. Check your API key and team access.');
    return result.data;
  }
  private async slack(method: string, params: Record<string, string> = {}, token = this.token('slack')) {
    if (!token) throw new Error('Connect Slack first');
    const result = await this.remote('slack', `https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!result.ok) {
      const code = typeof result.error === 'string' && /^[a-z_]+$/.test(result.error) ? result.error : 'request_failed';
      throw new Error(`Slack: ${code}. Check the app's scopes and invite it to the channel.`);
    }
    return result;
  }
  async linearCatalog(): Promise<{ teams: IntegrationChoice[]; projects: IntegrationChoice[] }> {
    return this.cached('linear:catalog', 300000, async () => {
      const data = await this.linear('{ teams(first: 100) { nodes { id name } } projects(first: 100) { nodes { id name } } }');
      return { teams: data.teams.nodes, projects: data.projects.nodes };
    });
  }
  async issues(floor: string): Promise<{ issues: LinearIssue[]; more: boolean }> {
    const { team, project } = this.status(floor).binding;
    return this.cached(`linear:issues:${team ?? ''}:${project ?? ''}`, 30000, async () => {
      const filter = { ...(team ? { team: { id: { eq: team } } } : {}), ...(project ? { project: { id: { eq: project } } } : {}) };
      const data = await this.linear('query OfficeIssues($filter: IssueFilter) { issues(first: 100, orderBy: updatedAt, filter: $filter) { nodes { id identifier title description url priority updatedAt state { name color } assignee { name } project { name } } pageInfo { hasNextPage } } }', { filter });
      return { issues: data.issues.nodes, more: data.issues.pageInfo.hasNextPage };
    });
  }
  async channels(cursor = ''): Promise<{ channels: IntegrationChoice[]; cursor: string }> {
    if (cursor.length > 1000) throw new Error('Invalid channel cursor');
    return this.cached(`slack:channels:${cursor}`, 60000, async () => {
      // Public channels work with channels:read alone. Private channels need groups:read too.
      let data;
      try { data = await this.slack('conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', cursor }); }
      catch (error) {
        if (!(error as Error).message.includes('missing_scope')) throw error;
        data = await this.slack('conversations.list', { types: 'public_channel', exclude_archived: 'true', limit: '200', cursor });
      }
      return { channels: data.channels.map((c: any) => ({ id: c.id, name: c.name })), cursor: data.response_metadata?.next_cursor ?? '' };
    });
  }
  async messages(floor: string): Promise<{ messages: SlackMessage[]; url: string; more: boolean }> {
    const channel = this.status(floor).binding.channel;
    if (!channel) return { messages: [], url: 'https://app.slack.com', more: false };
    return this.cached(`slack:history:${channel}`, 60000, async () => {
      const auth = await this.cached('slack:auth', 300000, () => this.slack('auth.test'));
      const data = await this.slack('conversations.history', { channel, limit: '15' });
      // Display names are optional: users:read may not have been granted.
      const names = await this.cached('slack:names', 300000, async () => {
        try { const users = await this.slack('users.list', { limit: '200' }); return new Map<string, string>(users.members.map((u: any) => [u.id, u.profile?.display_name || u.real_name || u.name])); }
        catch { return new Map<string, string>(); }
      });
      const url = `https://app.slack.com/client/${encodeURIComponent(auth.team_id)}/${encodeURIComponent(channel)}`;
      return { url, more: !!data.has_more, messages: data.messages.map((m: any) => ({ ts: m.ts, text: m.text || (m.files?.length ? '[File attachment — open in Slack]' : '[Message — open in Slack]'), author: names.get(m.user) || m.username || m.user || 'Slack', replies: m.reply_count || 0, url: `${url}/thread/${encodeURIComponent(channel)}-${encodeURIComponent(m.ts)}` })).reverse() };
    });
  }
}
