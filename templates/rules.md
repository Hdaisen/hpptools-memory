## Behavioral Rules

> Rules are unconditional — they persist regardless of context cleanup or memory filtering.

### Git Workflow
- After modifying memory-related files, always sync to your project repo immediately
- After syncing to the project, always commit
- Main branch is protected — use branch + PR workflow:
  ```bash
  git checkout -b feat/<description>
  git add -A && git commit -m "<description>"
  git push origin feat/<description>
  gh pr create --base main --title "<description>" --body "<details>"
  gh pr merge --squash
  ```
- Do NOT ask for confirmation for routine branch/PR operations
- If push fails, try HTTPS fallback without asking.

### Branch Management
- **main = public release** — contains only generic mechanisms and templates; **never personal identity/paths** (usernames, local paths, personal workflow rules)
- **personal = local private branch** (optional, not pushed): your own identity, paths, and project-specific rules. Sync daily changes to personal
- Generic changes (extensions/, scripts/, agents/ mechanics, docs/) live on both branches; personal content (core-prompt.md identity section, rules.md personal paths, corresponding templates/ sections) lives only on personal
- Before committing to main, self-check: grep for personal keywords (usernames, `C:\Users\`, `F:\projects\`, etc.) — if found, move to personal, never main

### Code Changes
- All extension code lives in the plugin package directory (e.g. `<repo>/plugins/memory`)
- The git project repo is the downstream — copy TO it, not FROM it
- After every code change, sync to git project, commit, and push via branch + PR
- Validate code changes with **semantic/runtime checks** (real execution/tests), not just grep/syntax — finding a function name via grep does not mean the function works

### Design Process
- Before proposing designs or optimizations, `recall` past decisions and read the relevant code first — avoid re-recommending already-rejected options

### Deletion Care
- Before deleting plugins/packages/files, list the exact items the user wants deleted and verify them, to avoid accidental deletion

### WSL Path Conversion
- When user provides a Windows path (e.g., `C:\projects\...` or `C:\Users\<name>\...`), auto-convert to WSL format (`/mnt/c/projects/...` or `/mnt/c/Users/<name>/...`) when running bash/wsl commands
- Do NOT repeatedly fail trying to access Windows paths directly in WSL
- Conversion rule: `X:\path` → `/mnt/x/path` (lowercase drive letter)
- Exception: when using Windows-native tools (PowerShell, cmd), keep Windows paths as-is

### Communication
- No compliments, no fluff, no "好问题" / "好想法"
- Be concise — let one sentence do the work of three
- If uncertain, state your understanding first, then ask a specific question
- When getting corrected, extract the general lesson and record it as a rule if it's unconditional

### Notebook Maintenance (by main LLM, active)
- notebook.md is an active whiteboard, not a log archive; **maintained by you (the main LLM) proactively**
- When task status changes (starting a new task / completing a todo / new constraint / key decision), update notebook.md with `edit` immediately — don't wait for the end of the turn
- Record only: current task, active todos, cross-turn constraints, key decisions
- Don't record conversation details (that's dialogue-summary's job)
- Subagents (consolidation/hippocampus) **read-only on notebook** — async concurrent writes would overwrite each other; it's your exclusive whiteboard

### Confirmation
- Use the `confirm` tool for interactive y/n prompts (not text questions)
- Only ask the user to confirm genuinely risky decisions
- Routine operations (push after commit, sync code) do NOT need confirmation
