# Local coworkers

This independent fork adds the Claude Code and Codex conversations already on your computer to the office. It retains the upstream MIT license and attribution.

Run from the source checkout:

```sh
npm ci
npm start -- --no-open
```

The office listens on `127.0.0.1:4600`. Sign in with the password shown in the terminal. Use `npm start -- /path/to/project` to add a project floor. The original 3D office, bean characters, movement, desk terminals, and services board remain available.

## Meet your existing sessions

**Local coworkers** in the top bar lists up to 60 recent conversations from `~/.codex/sessions` and `~/.claude/projects`. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` override these locations. The eight most recent (verified live Claude sessions first) appear as orange Claude and teal Codex characters on stools beside the desk area. Click a character, or walk up and press **E**. The directory also searches conversations not represented in the room.

The original-session tab shows up to 40 recent conversational messages and refreshes while open. It omits system/developer messages, reasoning, and tool payloads. Reads are bounded to the head and tail of each file, so very large transcripts may omit intermediate messages or a single oversized record. Discovery refreshes every ten seconds; new files and exited sessions are reflected on the next refresh. Agent Office does not alter the original transcript.

Claude's **Live** label requires a session registry entry and an existing process. Codex status is inferred from recent transcript events: **Recent activity** does not prove that a process is still running. **Saved session** is historical, not an active agent.

## Move a coworker to a desk

Open a coworker and choose **Move to desk**, then pick a free desk. They sit in the existing office chair, and clicking them or their desk (or pressing **E** nearby) opens their conversation. Use **Back to coworker area** to return them to a stool.

Seats are personal to this browser and remembered separately for each floor. Other local coworkers and office-owned agents cannot be selected as occupied destinations. If an office-owned agent later takes the desk, it has priority: the local coworker returns to the coworker area until the desk is free again. Seated coworkers remain visible even when they leave the eight most recent conversations, provided they are still in the discovered session list. The office map's sixteen main desks are supported.

## Talk to a coworker

Sending the first message forks a continuation using the installed CLI (`codex exec fork`, or `claude --resume --fork-session`). Later messages resume that continuation. This carries context into the office without concurrently writing to an original session that may still be open in another app. It is not a live terminal attachment to that process.

Codex chat runs with the read-only sandbox; Claude chat runs in plan permission mode. For coding actions and interactive approvals, use the existing hire-a-worker desk terminals. Chat uses your existing CLI sign-in and plan. No additional API key is needed. CLI versions must support these continuation commands; an unsupported version or missing sign-in is reported in the conversation.

Replies keep running when the window closes. Continuation associations and the office chat view are retained for the server's lifetime; restarting the server clears that association, but the CLI's saved continuation remains discoverable. Three simultaneous replies, a five-minute timeout, and bounded message/output sizes keep this small local bridge manageable.

Local session APIs require an admin login and are disabled when the office binds to a non-loopback address. They never read credential files. No transcript is uploaded to a hosting service; sending a chat uses the chosen provider through its CLI as usual.

## Open their work

**Browser** is always available in the toolbar and each agent terminal. A desk terminal opens its detected service URL when available. A local coworker's recent messages also expose up to eight HTTP(S) links, with local previews first.

The office browser accepts an address and displays it in a sandboxed iframe. Some applications require cookies, same-origin storage, or forbid embedding; use **Open in tab** for those. Framed pages cannot access the office's session APIs or top-level navigation. The browser does not proxy external pages or bypass framing restrictions.

Movement and camera controls are unchanged: WASD/arrows to walk, mouse to look, **E** to interact, and **Esc** or the top-right **✕** to close a window. Third-person view is available in Settings.

## Local project floors and team panels

Use **Elevator → Local project** to open an existing folder or create a new one.
The **Linear** and **Slack** toolbar buttons open views saved for the current floor.
Linear's **Make coworker task** opens a queue draft; it doesn't send a message to
one of your discovered local sessions. Review the task and select an agent before
adding it to the queue. See [setup and behavior](local-projects-integrations.md).
