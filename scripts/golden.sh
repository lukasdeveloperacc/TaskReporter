#!/bin/sh
set -eu
BT="$1"
uv run --no-project python -I -B - "$BT" <<'PY'
import sys, json, re
sys.path.insert(0, sys.argv[1] + "/scripts")
import progress
md = open(sys.argv[1] + "/references/progress-example.md", encoding="utf-8").read()
patches = [json.loads(b) for b in re.findall(r"```json\n(.*?)\n```", md, re.S)]
data = progress.apply({}, {"title": "외부 STT 가져오기 끊김 해결 + 외부 작업 판정 통일", "stage": "계획", "summary": "", "todo": "없음", "blockers": "없음"})
for p in patches: data = progress.apply(data, p)
for t in data["tasks"]: t.pop("started", None); t.pop("finished", None)
data.pop("updated", None)
print(json.dumps(data, ensure_ascii=False, indent=1))
PY
