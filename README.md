# About this project

Some [OpenCode](https://github.com/anomalyco/opencode) plugins i needed for my personal usage, may be useful for others

## How to use?

To use a plugin, copy its `.ts` file from this repository's `plugins` directory to `~/.config/opencode/plugins`.
OpenCode loads TypeScript plugins directly; no compilation is needed.

Quit and restart OpenCode after installing or updating a plugin.

## Plugins list

### overcome-native-apply-patch-tool-defects

> This plugin addresses the limitations of Opencode's apply_patch tool:
> failure to preserve CRLF line endings and failure to preserve the « no trailing newline ».
>
> Only files inside the worktree are handled by this plugin

## Development

Use Node.js 24 or later. From the repository root, run:

```sh
npm install --no-audit
npm run typecheck
npm test
```

The plugin uses the official `@opencode-ai/plugin` types and is checked in strict TypeScript mode without emitting JavaScript.
Tests remain in `.mjs` and import the `.ts` plugin directly using Node.js's native type stripping.
They exercise the plugin hooks with simulated native tool writes.