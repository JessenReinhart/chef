# Superseded: Intent-First Home

This document is no longer the authoritative Chef UI direction.

The separate `Chef Home / Activity → Workbench` product model proved confusing in real use because it created two surfaces that both looked like Chef's main application.

The authoritative direction is now:

- [`UI_NORTH_STAR_LIVING_WORKSPACE.md`](./UI_NORTH_STAR_LIVING_WORKSPACE.md)

The replacement keeps the valuable intent-first principle but applies it inside **one canonical Living Workspace**:

> **Users specify outcomes. Chef constructs the team and workspace. The canvas explains what Chef is doing.**

Historical reason for supersession:

- the dark Intent Home and light Living Workspace competed as separate main pages;
- the active project context was too easy to miss;
- work could be happening successfully while the primary surface gave insufficient execution feedback;
- the intended Chef model is closer to a project-grounded living agent workspace than a chat homepage that launches a workbench.

Runtime state remains authoritative. Advanced graph/runtime capability remains available through progressive disclosure from the Living Workspace.
