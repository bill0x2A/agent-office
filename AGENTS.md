# Little Office

This is an independent fork of AgentSystemLabs/agent-office, owned at
https://github.com/bill0x2A/agent-office. Develop this fork as its own product.
Branches, pushes, and pull requests target `bill0x2A/agent-office`, never the
upstream project unless the user explicitly asks. Preserve the MIT license and
upstream attribution.

- Follow the worktree and validation workflow in `CLAUDE.md`.
- Use `codex/` for new Codex branches.
- Local coworker discovery must not modify original session transcripts or
  expose them to unauthenticated users. Keep the local session API restricted
  to admin users and loopback-bound offices.
- Test chat integration with fake CLIs. Do not send real prompts or incur model
  usage just to validate an implementation.
- Document changes to controls or session behavior in `docs/local-coworkers.md`.
- Keep the office playful and model assets simple; reuse the existing bean
  characters and 3D world before introducing another rendering system.
