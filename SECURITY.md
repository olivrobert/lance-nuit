# Security Policy

## Supported versions

The project is experimental (`0.x`). Only the latest published version receives
security fixes.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository
(<https://github.com/olivrobert/lance-nuit/security/advisories/new>).

You should receive an acknowledgement within a week. Coordinated disclosure is
appreciated: give the project a reasonable window to release a fix before
publishing details.

## Automated scanning

Every push and pull request runs the `Security` workflow:

- **gitleaks** (`.gitleaks.toml`) scans the full git history and the working
  tree for committed credentials. Beyond the default ruleset it carries custom
  rules for the credentials this runner handles: Anthropic, OpenAI and
  Atlassian API tokens.
- **semgrep** (`.semgrep.yml`) runs repository-owned rules covering shell
  injection through `child_process`, dynamic code execution, weak digests,
  insecure randomness for tokens and lock ids, and disabled TLS verification.
  Only `ERROR` rules fail the build.

Both configurations live in this repository rather than a remote registry, so
scans stay reviewable and reproducible offline.

## Scope notes

The runner executes shell commands and agent backends defined by the loaded
pipeline. A pipeline definition is code: only run pipelines you trust, exactly
as you would treat any script in a repository.
