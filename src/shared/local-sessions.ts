export interface LocalMessage {
  role: 'user' | 'assistant';
  text: string;
  at?: string;
}

export interface LocalSession {
  key: string;
  id: string;
  provider: 'claude' | 'codex';
  title: string;
  project: string;
  cwd: string;
  updatedAt: number;
  status: 'working' | 'idle' | 'recent' | 'saved';
  /** True only when a live Claude process was verified; Codex status is transcript-derived. */
  live: boolean;
  urls: string[];
}

export interface LocalChat {
  messages: LocalMessage[];
  running: boolean;
  error?: string;
  continuationId?: string;
}

/** Navigation only, never fetched or proxied by the office server. */
export function previewUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function sessionUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"'`]+/g) ?? [])
    .map((s) => previewUrl(s.replace(/[),.;\]}]+$/, ''))).filter((s): s is string => !!s))]
    .sort((a, b) => Number(/localhost|127\.0\.0\.1/.test(b)) - Number(/localhost|127\.0\.0\.1/.test(a))).slice(0, 8);
}
