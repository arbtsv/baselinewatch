# baselinewatch: notes for coding agents

baselinewatch is a Playwright plugin for baseline-driven synthetic monitoring:
named measurements, human-approved baselines, a recheck of slow steps, a text
report, CSV history and exit codes for a scheduler. Status: early development.

## This repository is public

- Everything committed here is published. Follow `docs/public-hygiene.md`.
- Use only invented examples: the demo portal, `example.com`, `*.test`,
  placeholder credentials. Never reproduce text, ids, hosts or screenshots of a
  real application.
- Write committed files in English. `README.ru.md` is the only Russian file.
- Stage explicit paths. Never `git add -A`, `git add .` or `git add -f`.
  `.private/` and `CLAUDE.local.md` are ignored on purpose.
- Push only with the `public-pr` skill. Never `--no-verify`, never set
  `BASELINEWATCH_LEAK_*` variables, never push to `main`.
- Images go to `docs/img/` only. A human adds each one to
  `docs/img/MANIFEST.txt`.

## Commands

```sh
git config core.hooksPath .githooks       # once per clone
node --test "test/hook/*.test.mjs"         # pre-push hook tests
```

## Layout

- `.githooks/pre-push`: the leak guard.
- `.claude/skills/public-pr/`: the commit, push and PR workflow.
- `docs/public-hygiene.md`: the publication policy and the reviewer instructions.
