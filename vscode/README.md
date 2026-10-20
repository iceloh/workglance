# Workglance for VS Code

The board of everything your AI coding tabs are doing, next to them.

- **Status bar**: how many tabs need you (a question, a permission) and how many are working.
- **Notifications** when a tab asks you something or needs permission, with **Open tab** to jump to it.
- **Workglance: Open board** shows the board in a panel: tasks your agents keep, what is still undone in
  each worktree, and every tab with its history. Click a tab name to open that Claude Code session.

**Needs the Workglance tool on your machine** (Node.js 24+): `npx workglance install`. If it isn't installed, the
extension says so and installs it for you with one click (**Install now**, or the status bar item). After that it
starts the local server whenever it is down. Source and docs: https://github.com/iceloh/workglance
