# About this project

Some [OpenCode](https://github.com/anomalyco/opencode) plugins i needed for my personal usage, may be useful for others

## How to use?

These plugins target OpenCode V2.

To use a plugin, copy its `.ts` file from this repository's `plugins` directory to `~/.config/opencode/plugins`.
OpenCode loads TypeScript plugins directly; no compilation is needed.

Changes under watched plugin directories reload automatically. If a change is not picked up, run `opencode service restart`.

## Plugins list

### overcome-native-apply-patch-tool-defects

This plugin addresses the limitations of OpenCode's native `patch` tool:

- failure to preserve CRLF line endings
- failure to preserve the « no trailing newline ».

Only files inside the worktree are handled by this plugin

## Development

The plugin uses the OpenCode V2 `@opencode/plugin` API

Use Node.js 24 or later. From the repository root, run:

```sh
npm install --no-audit
npm run typecheck
npm test
```

The test harness requires Node.js 24 or later to import TypeScript using native type stripping.

Tests exercise V2 hook registration, tool results, session events and cleanup,
and simulate native tool writes rather than running OpenCode itself.