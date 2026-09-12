---
name: hello
description: Template and smoke test for the VsWorker skill bundling pipeline. Use only when someone explicitly asks to verify that bundled skills reach the model.
---

# Bundled skill template

This skill ships inside every VsWorker build and is off by default, so a release is unaffected until someone
turns it on with `opencode vsworker skills enable hello`. It exists to prove the pipeline end to end: the file
you are reading was compiled into the binary, written to the cache directory at startup, and handed to you by
the `skill` tool.

Copy `vsworker/skills/hello/` as the starting point for a real in-house skill, or run
`bun run --cwd vsworker bundle import skill <name>` to vendor one you already keep in your global skills
directory. Read `vsworker/README.md` for the field reference.

## What to do when this skill loads

Say that the bundled skill pipeline works, and report the base directory printed above the file list. Nothing
else. This skill carries no instructions for real work.
