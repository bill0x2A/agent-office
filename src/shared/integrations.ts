export interface IntegrationBinding { team?: string; project?: string; channel?: string }
export interface IntegrationStatus { linear: boolean; slack: boolean; linearEnv: boolean; slackEnv: boolean; binding: IntegrationBinding }
export interface IntegrationChoice { id: string; name: string }
export interface LinearIssue {
  id: string; identifier: string; title: string; description?: string; url: string;
  priority: number; updatedAt: string; state: { name: string; color: string };
  assignee?: { name: string }; project?: { name: string };
}
export interface SlackMessage { ts: string; text: string; author: string; replies: number; url: string }
