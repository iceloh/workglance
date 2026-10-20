# Security

Workglance runs a local HTTP server and adds hooks to Claude Code, so it is part of your development
environment's attack surface. What it does to stay small:

- The server binds to `127.0.0.1` only, answers only `Host: 127.0.0.1` or `localhost` (against DNS
  rebinding) and refuses requests from other origins. Every state-changing call is a JSON `POST`, which a
  cross-site form cannot send without a preflight the server never answers.
- Hooks never block a tab for long (short timeouts) and never fail it: an error inside Workglance is
  swallowed and the tab carries on.
- A card's identity (which tab, which folder) comes from the session, filled in by the hook, never from
  what the agent typed.
- Text written by agents or found in history is passed to agents as data, labelled as such.
- Exports, search results given to agents and the digest summary are redacted (API keys, tokens,
  passwords in common formats).
- Nothing is sent off the machine except the optional digest summary (through your own `claude -p`) and
  optional read-only CI API calls.

## Reporting a vulnerability

Please report it privately through **GitHub's "Report a vulnerability"** (Security tab of the repository),
not in a public issue. You will get an answer within a week.
