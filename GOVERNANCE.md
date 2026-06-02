# Governance

This document describes how decisions get made in open-museum-mcp. It is deliberately short, because the project is small.

## Current model

open-museum-mcp is maintained by a single person (see [MAINTAINERS.md](MAINTAINERS.md)). The maintainer reviews and merges pull requests, cuts releases, and owns the rights-gate policy that is the core of the project.

This is a side project. New releases ship when one of three things happens: the maintainer's own work needs a feature, a new museum is wired in, or a contributor's PR is merged. There is no fixed cadence. The maintainer does commit to reviewing and merging contributor PRs promptly.

## How decisions are made

- **Pull requests.** Anyone can open one. The maintainer reviews for correctness, test coverage, and fit with the conventions in [CONTRIBUTING.md](CONTRIBUTING.md). Adapter and rights-gate changes get the closest review, because license correctness is the property the project exists to protect.
- **Rights-gate policy.** The strict-default-deny posture in `src/licenseGate.ts` is not up for negotiation. A change that could let a non-open-access record through is treated as a P0 regression, not a feature. When a museum's rights model is genuinely two-tier, the project expresses that explicitly rather than relaxing the default. See the rules in CONTRIBUTING.md.
- **Releases.** The maintainer tags versions following [Semantic Versioning](https://semver.org/) and records every release in [CHANGELOG.md](CHANGELOG.md).
- **Breaking changes.** These require a major or minor bump as SemVer dictates, a CHANGELOG entry that states the migration, and a clear reason in the PR.

## How governance broadens

If the project attracts regular contributors, governance widens to match. A contributor who has landed several well-reviewed PRs, shown sound judgement on rights questions, and stayed active over time may be invited to become a maintainer with merge rights. The criteria are:

- A track record of merged, high-quality contributions (adapters, fixes, or docs).
- Demonstrated care with the rights gate, the part of the codebase where mistakes are most costly.
- Sustained engagement, not a single burst.

When a second maintainer joins, this document is updated to describe shared decision-making (for example, a second review on rights-gate changes, and a tie-break rule). Until then, the model above stands.

## Code of conduct

All participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
