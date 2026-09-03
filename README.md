# Threads Sidebar

A drop-in replacement for bb's scrolling sidebar thread list. It keeps bb's
New Thread button, search, navigation rows, and footer intact while replacing
the thread organization and row presentation.

## Behavior

- Recent is a compound hierarchy: time bucket (Today, Yesterday, Previous
  7 days, Previous 30 days, Older) → project → threads. Project-only view
  keeps Personal first.
- Special sections stay in the deterministic order
  Pinned → Attention → Pull Requests → Running. Attention and Pull Requests
  are additive overlays, so those threads also remain in their normal
  recent/project position.
- Attention includes blocked/needs-answer threads and, optionally, unread
  threads.
- Every row resolves exactly one quiet status in strict priority order:
  needs-you question mark → unread dot → working 2.5-second pulsing dot.
  Collapsed parents roll up their children's status.
- Filters by all, unread, needs-you, project, host search, and archived state.
- Parent/child threads stay nested behind a fork-count badge.
- Rows support bb's keyboard shortcut DOM contract and drag-to-split gesture.
- Double-click a title to rename; Enter saves and Escape cancels. The row menu
  also exposes rename, pin, read state, archive, and bb's confirmed delete flow.
- Agent marks come from bb's live provider directory. The resolved status is
  rendered as a corner badge when agent icons are enabled.
- Pull requests are discovered through bb's lazy per-row lookup and displayed
  as linked badges.

View preferences, collapsed sections, and expanded parents are stored in the
browser's local storage. Plugin-wide section and auto-title preferences live
in bb's plugin settings.

## Automatic titles

After the second user message, the backend generates and applies one concise
title. It uses a hidden Codex GPT-5.6 Luna worker at low reasoning by default,
then stops and archives that worker. It does not periodically re-title the
thread.

Automatic titles can be disabled in plugin settings. The title model is also
configurable there using `provider:model` syntax. Use **Rename with AI** in a
thread row's three-dot menu to generate a fresh title on demand; manual inline
rename remains available as **Rename**.

## Development

```bash
npm install
npm test
bb plugin build
bb plugin install . --yes
```

After edits:

```bash
bb plugin reload threads-sidebar
```

Choose **Threads Sidebar** under **Settings → Appearance → Sidebar** if bb's
default list or another replacement is currently pinned.
