# Claude Code Project Guidelines

## Agentic & Subagent Boundaries

- **DO NOT** spawn autonomous subagents for basic syntax queries, single-file edits, or simple git status checks.
- **RESTRICT** subagent usage exclusively to heavy multi-file refactoring, deep codebase analysis, or isolated research tasks.
- **MANDATORY**: Always ask for explicit user confirmation before initiating any subagent loops that exceed 3 sequential steps.
- **MODEL CONSTRAINTS**: When creating custom subagents via `/agents`, always default to the `Haiku` model for non-critical code reviews or logs to conserve tokens.
- **DO NOT GIT COMMIT THE CHANGES UNLESS INSTRUCTED TO DO SO**: I'll be committing myself.
