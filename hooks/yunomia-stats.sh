#!/usr/bin/env bash
# Yunomia stats hook for Claude Code.
#
# Install:
#   1. Copy this file to ~/.claude/hooks/yunomia-stats.sh and chmod +x.
#   2. Add to ~/.claude/settings.json (or per-project .claude/settings.json):
#        {
#          "hooks": {
#            "PostToolUse": "~/.claude/hooks/yunomia-stats.sh",
#            "Stop":        "~/.claude/hooks/yunomia-stats.sh"
#          }
#        }
#
# What it does:
#   On every tool-use and turn-end, writes a small JSON file at
#     ~/.claude/projects/<sanitised-cwd>/<session>-stats.json
#   containing tokens_used / tokens_remaining / model / last_tool_at.
#
# Yunomia reads this file (when present) instead of the JSONL byte-count
# heuristic, so the context-window chip in the agent rail and the
# auto-compact-at-50% trigger fire on real numbers.

set -euo pipefail

# Claude Code passes hook context as env vars / stdin JSON. The session id +
# project path are available; cwd is the working directory of the agent.
SESSION_ID="${CLAUDE_SESSION_ID:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
MODEL="${CLAUDE_MODEL:-unknown}"
TOKENS_USED="${CLAUDE_TOKENS_USED:-0}"
TOKENS_TOTAL="${CLAUDE_TOKENS_TOTAL:-200000}"

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Sanitise cwd to match Claude Code's project-dir convention.
SANITISED=$(echo "$PROJECT_DIR" | sed 's|^/||; s|/|-|g; s|\.|-|g')
OUTDIR="$HOME/.claude/projects/-$SANITISED"
mkdir -p "$OUTDIR"

cat > "$OUTDIR/$SESSION_ID-stats.json" <<EOF
{
  "session_id": "$SESSION_ID",
  "tokens_used": $TOKENS_USED,
  "tokens_total": $TOKENS_TOTAL,
  "model": "$MODEL",
  "last_tool_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
