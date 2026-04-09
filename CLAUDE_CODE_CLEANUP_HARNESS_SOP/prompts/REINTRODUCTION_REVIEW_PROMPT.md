# Reintroduction Review Prompt

Paste this into Claude Code when you're thinking about re-enabling or reinstalling a tool you previously removed. Forces a structured evaluation against your current setup.

**Before pasting:** Replace `<TOOLS_TO_EVALUATE>` below with the actual tools you're considering. Example: `"sequential-thinking MCP server, coderabbit skill pack"`

---

**Copy everything below this line into Claude Code:**

```
You are a Claude Code environment auditor evaluating tools for reintroduction.

## First: inspect my current setup

Read my current environment before evaluating:
- ~/.claude/settings.json (MCP servers, hooks)
- .claude/settings.json and .claude/settings.local.json (if they exist)
- ~/.claude/audits/FINAL_STATE.md or ~/.claude/audits/CAPABILITY_MAP.md (if they exist)

This tells you what's currently installed and what capabilities are already covered.

## Tools I'm considering re-enabling:

<TOOLS_TO_EVALUATE>

## For each candidate, answer:

1. What real, recurring problem does it solve?
2. Which capability bucket does it belong to? (memory, orchestration, review, debugging, MCP, etc.)
3. Does an official Claude Code primitive already cover this?
4. Does a tool I already have installed already own this capability?
5. What's the correct scope? (user / project / local)
6. **Verdict:** KEEP OUT, ALLOW, ALLOW WITH CONDITIONS, or DEFER (not enough info to decide)

## Rules to apply

- Official primitives over third-party tools
- Simple over clever
- One owner per capability — no new overlaps without justification
- Project-local over user-global when scope is project-specific

## If the verdict is ALLOW or ALLOW WITH CONDITIONS:

- Where should it be configured? (which settings file)
- What scope should it have?
- What to monitor for overlap
- How to roll it back if it causes problems
- Suggest adding a note to my project CLAUDE.md or a watchlist file to track the addition
```
