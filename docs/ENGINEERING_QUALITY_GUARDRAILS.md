# Engineering Quality Guardrails

Chef is developed heavily by autonomous agents. That makes verification discipline part of the product architecture, not just a coding preference.

## Core rule

**Test behavior and invariants, not implementation syntax.**

A test should fail when a user-visible behavior, runtime contract, persistence guarantee, security boundary, or lifecycle invariant breaks. It should not fail merely because code was renamed, reordered, extracted, or rewritten without changing behavior.

## Preferred test order

Use the highest-value level that proves the acceptance criterion with reasonable cost:

1. **Runtime / integration tests** for Mission, Task, Session, persistence, recovery, approvals, HTTP, PTY, and concurrency behavior.
2. **Scenario / acceptance tests** for flows that cross multiple boundaries, especially Thread -> Mission -> Task -> Worker -> result and restart/recovery paths.
3. **Focused unit tests** for deterministic pure logic with meaningful edge cases.
4. **Static source checks only for true static architecture rules** that cannot be expressed as runtime behavior.

Do not add source-text or regex assertions to prove ordinary product behavior. Matching strings such as function names, JSX fragments, `slice(...)`, class names, or exact implementation expressions creates false confidence and brittle tests. Existing source-regex UI suites are legacy debt. Do not expand that pattern. When touching one, prefer migrating the relevant behavior toward an executable scenario or pure behavioral test.

## Acceptance coverage

For every change, start from the failure or user outcome and write the smallest test that proves that outcome.

Good examples:

- A Thread keeps its Mission history after restart.
- A failed worker leaves durable state that can be retried safely.
- An approval gate cannot be bypassed.
- A cancelled PTY is actually torn down and does not leave owned handles behind.
- A follow-up message stays in the same Thread lineage and starts a new Mission.

Weak examples:

- A source file contains a specific hook name.
- A component contains a literal string or JSX structure.
- A helper is called in one exact syntactic form.
- A test exists only to increase line or branch coverage.

## Test suite shape

Organize tests by durable product/runtime boundaries, not by the issue or PR that introduced them.

Before creating a new test file:

1. Check whether the scenario belongs in an existing suite.
2. Prefer extending a coherent domain suite over creating another one-off regression file.
3. If a new file is justified, name it after the behavior or subsystem, not the ticket.
4. Keep fixtures and setup reusable when multiple tests exercise the same runtime boundary.

Coverage percentage is not a goal by itself. A smaller suite with strong behavioral coverage is better than a larger suite that mirrors implementation details.

## Comments

Comments should explain **why**, not narrate **what** the next line does.

Keep comments for:

- non-obvious invariants or ownership boundaries;
- concurrency, persistence, lifecycle, security, or platform constraints;
- surprising tradeoffs and measured performance decisions;
- external protocol quirks that future maintainers could accidentally remove.

Avoid comments that:

- restate obvious code;
- describe PR history such as `Fix 1`, `temporary fix`, or `changed for issue X`;
- preserve obsolete implementation detail after a refactor;
- add noise around self-explanatory assignments, loops, or conditionals.

If the rationale matters after the PR is merged, rewrite it as a durable invariant or constraint.

## Autonomous agent review checklist

Before publishing a PR, the agent must ask:

- Does each new test prove behavior or a real invariant?
- Would harmless refactoring break the test? If yes, the test is probably too coupled.
- Did I create a new test file because the architecture needs it, or because this task happened to be separate?
- Did I add comments that only narrate the code or the history of my patch?
- Is there a realistic scenario test that would give stronger evidence with fewer assertions?
- Am I reporting observed validation rather than inferred confidence?

The goal is not fewer tests. The goal is fewer low-signal tests and stronger evidence that Chef works as a system.
