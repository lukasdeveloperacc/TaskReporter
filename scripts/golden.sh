#!/bin/sh
set -eu
BT="${1:-${BASIC_TEAM_DIR:-}}"
if [ -z "$BT" ]; then
  for candidate in "$HOME/.codex/skills/basic-team" "$HOME/.claude/skills/basic-team" \
    "$HOME"/.codex/plugins/cache/lukas-plugin/lukas-plugin/*/skills/basic-team \
    "$HOME"/.claude/plugins/cache/lukas-plugin/lukas-plugin/*/skills/basic-team; do
    if [ -f "$candidate/scripts/progress.py" ]; then BT="$candidate"; break; fi
  done
fi
if [ ! -f "$BT/scripts/progress.py" ]; then
  echo 'basic-team progress.py not found; pass its skill directory or set BASIC_TEAM_DIR' >&2
  exit 1
fi
uv run --no-project python -I -B - "$BT" <<'PY'
import sys, json, re
from pathlib import Path
sys.path.insert(0, sys.argv[1] + "/scripts")
import progress
fixtures = Path('server/fixtures')
md = (fixtures / 'progress-example.md').read_text(encoding='utf-8')
patches = [json.loads(b) for b in re.findall(r"```json\n(.*?)\n```", md, re.S)]
data = progress.apply({}, {"title": "외부 STT 가져오기 끊김 해결 + 외부 작업 판정 통일", "stage": "계획", "summary": "", "todo": "없음", "blockers": "없음"})
for p in patches: data = progress.apply(data, p)
for t in data["tasks"]: t.pop("started", None); t.pop("finished", None)
data.pop("updated", None)
expected = json.loads((fixtures / 'progress-example.expected.json').read_text(encoding='utf-8'))
assert data == expected, 'progress.py output differs from committed golden fixture'
print('PASS: installed progress.py matches the committed golden fixture')
PY
