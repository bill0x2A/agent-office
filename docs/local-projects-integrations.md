# Local project floors, Linear, and Slack

## Local projects

Open the elevator (the floor name in the corner, or the elevator in the world).
Under **Local project**, choose **Open existing folder** or **Create new folder**,
enter a full path such as `~/code/my-project`, and submit. The parent folder must
already exist when creating a project. Existing files are left in place; creating
a folder refuses to overwrite an existing one. Git and a GitHub remote are optional.
The office keeps that floor's settings in its `.agent-office` folder.

Floors persist across restarts. Symlink aliases of an existing floor are detected.
Removing a floor leaves the project folder and its files on disk. **Add from GitHub**
is still available separately and only asks GitHub for repositories when opened.

These local filesystem controls and the integrations below are available to admins
when the office listens on localhost. They are not exposed in a network-bound office.

## Connect services once

Use **Linear** or **Slack** in the office toolbar, then **Connect**. The app verifies
the token before saving it. Enter tokens in that form, not in chat or source files.
Credentials stay in the office's ignored `.agent-office/integrations.json`, with
owner-only file permissions. They are never included in API status responses.
All local requests require authentication; changes require a same-origin request.

Alternatively start the server with `LINEAR_API_KEY` and/or `SLACK_BOT_TOKEN` in its
environment. A saved token overrides the corresponding environment token. **Connection
→ Remove saved token** falls back to an environment token if one exists; unset the
environment variable and restart to disconnect that one too. The Codex app's own
connected services do not automatically provide credentials to this standalone server.

## Linear task board

Create a personal API key in Linear's security settings with read access to the
teams you want. See [Linear's API guide](https://linear.app/developers/graphql).

Choose a team and/or project, then **Save floor view**. Each floor remembers its
own filters. The board shows up to 100 recently updated issues, with status,
assignee, priority, description, search, and an external link. The selectors show
up to 100 teams and 100 projects. Narrow the view or open Linear for anything beyond
those limits. Responses are cached for 30 seconds (catalogs for five minutes).

**Make coworker task** opens the existing task queue with the issue identifier,
URL, title, and description filled in. Review/edit the prompt, choose a provider,
then add it to the queue. Adding a task may start a worker immediately, depending
on queue capacity. Opening the draft does not start a worker or update Linear.
This integration reads issues; it does not change their status or post comments.
Discovered local sessions keep their existing separate conversation flow.

## Slack lounge

Create/install a Slack app and copy its bot token into the connection form. Start
with `channels:read` and `channels:history`, and invite the bot to channels you want
it to read. Add `groups:read` and `groups:history` for private channels, and optionally
`users:read` for author names. Reinstall the app after changing scopes. Follow the
[Slack quickstart](https://docs.slack.dev/quickstart/) and
[message access documentation](https://docs.slack.dev/reference/methods/conversations.history/).

Choose a channel and **Save channel** for this floor. **More channels** pages through
the channel list. The panel shows the newest 15 messages in chronological order;
**Refresh** checks at most once a minute and honors Slack's retry-after rate limits.
Author IDs are shown when display names aren't available (the name cache currently
covers the first 200 users). Text is rendered as plain text. File attachments and
threads have links to the full Slack app. **Open Slack** also works before connecting.
No messages are sent, channels joined, or remote content modified by this reader.

If a saved channel becomes inaccessible, its error appears while the channel picker
stays available. Select another channel or check the bot's membership and scopes.

## Validation

Automated tests use fake remote responses, never real issue mutations or Slack
messages. Browser checks use a temporary office and fixture data to cover local
floor creation, saved views, task drafts, missing permissions, and narrow screens.
Live provider access still requires your own connected tokens.
