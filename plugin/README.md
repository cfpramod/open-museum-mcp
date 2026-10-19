# open-museum-mcp plugin

This directory is the Claude Code plugin for [open-museum-mcp](../README.md). It carries no code of its
own: `.claude-plugin/plugin.json` starts the published npm package with `npx`, pinned to the same version
as the package. See the repository README for what the server does and how it decides what is open.

```
/plugin marketplace add cfpramod/open-museum-mcp
/plugin install open-museum-mcp@open-museum
```
