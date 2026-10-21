# baselinewatch

[Русская версия](README.ru.md)

Baseline-driven synthetic monitoring for web applications, built on Playwright.

> **Status: early development.** There is nothing to install yet. This README
> describes the plan for v1.

## The idea

You write ordinary Playwright scenarios and name the steps you care about. For
each step, baselinewatch compares the measured time with a baseline that a human
approved, so measurements from different days and machines stay comparable. A
step that is too slow is measured again before the run fails. Every run produces
a short text report, a CSV history and a zip with screenshots. It ends with an
exit code that any scheduler understands:

| Code | Meaning                                              |
|------|------------------------------------------------------|
| 0    | every step is within its baseline                    |
| 1    | a step is slow or failed                             |
| 3    | the environment is not ready (config, browser, lock) |

## Planned for v1

- A Playwright fixture for named measurements and a reporter that writes the
  results.
- Baselines in a reviewed JSON file, separate from environment settings.
- A `blw` command line: `blw init` creates a monitoring project, `blw run`
  performs the two passes and builds the report.
- Windows templates for operators who do not use Node themselves:
  `install.bat` sets up a portable Node and browser, `monitor.bat` runs the
  monitor and returns the exit code.
- A fictitious demo portal that runs offline and serves as the example and the CI
  test bed.

Out of scope: charts, desktop shortcuts, scheduling, alerting.

## Supported install

The core is installed into a monitoring project from the `.tgz` that `npm pack`
builds, so it lives in `<project>/node_modules/baselinewatch`. `blw run` finds
the project from that location.

Known limit for now: other layouts are not supported yet, for example pnpm,
`npm link`, a `file:` dependency on a directory, or a workspace that hoists
packages. A copy that runs from anywhere else stops with a configuration error
that names this install.

## Development

This repository is public, and leak prevention is part of the project. Before
your first push, enable the pre-push hook:

```sh
git config core.hooksPath .githooks
node --test "test/hook/*.test.mjs"
```

How the hook, the pull request marker and the CI checks fit together is
described in [docs/public-hygiene.md](docs/public-hygiene.md).

## License

[MIT](LICENSE)
