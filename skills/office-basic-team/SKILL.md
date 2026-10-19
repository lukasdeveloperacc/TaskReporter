---
name: office-basic-team
description: Office variant of basic-team. Run or resume the installed basic-team workflow while reporting progress and user decisions to the local Office MCP app, with progress.py HTML fallback. Use when the user asks for office-basic-team. Not for explaining or editing this skill.
---

# Office Basic Team

기존 basic-team의 실행 흐름에 Office 보고를 연결한다. 원본 basic-team, progress.py, 플러그인 또는 전역 설정은 수정하지 않는다.

## 1. 원본 로드와 재개

실제 설치된 basic-team 디렉터리를 찾고 그 `SKILL.md`를 **전부 읽는다**. 해당 호스트의 skill catalog에 경로가 있으면 우선 사용한다. 없으면 아래 명령으로 Codex/Claude 캐시를 검색한다. 각 루트 안에서는 최신 버전을 선택한다.

```sh
BT=$(uv run --no-project python - <<'PY'
import os, re
from pathlib import Path
home = Path.home()
roots = [Path(os.environ.get('CODEX_HOME', str(home / '.codex'))) / 'plugins/cache/lukas-plugin/lukas-plugin',
         Path(os.environ.get('CLAUDE_CONFIG_DIR', str(home / '.claude'))) / 'plugins/cache/lukas-plugin/lukas-plugin']
for root in roots:
    matches = list(root.glob('*/skills/basic-team/SKILL.md'))
    matches.sort(key=lambda p: tuple(int(n) for n in re.findall(r'\d+', p.parents[2].name)), reverse=True)
    if matches:
        print(matches[0].parent)
        break
else:
    fallback = home / 'orca/PersonalAgentPlugins/skills/basic-team'
    if (fallback / 'SKILL.md').is_file():
        print(fallback)
    else:
        raise SystemExit('설치된 basic-team을 찾지 못했습니다. 설치 위치가 필요합니다.')
PY
)
test -n "$BT" && cat "$BT/SKILL.md"
```

찾지 못하면 경로 누락을 보고하고 중단한다. 다른 동작을 basic-team이라고 재구현하지 않는다. `uv`가 없으면 이 명령 대신 파일 탐색으로 동일한 경로를 찾고 원본을 읽는다. Python 명령 실행은 원본과 같이 항상 `uv run`을 사용한다.

원본의 ralplan(없을 때 plan) → 승인 계획 → 소유 파일·검증 명령으로 작업 분할 → 병렬 구현 → 같은 고정 revision에서 독립 리뷰 → 수정 및 재리뷰 → 최종 검증·종료를 따른다. 원본의 역할별 모델·effort, 리더의 제품 파일 편집 제한, 최대 3회 미수렴 처리와 권한 경계를 유지한다. **Karpathy Agent와 Ponytail Agent는 필수**, Impeccable Agent는 보이는 UI 변경, E2E Agent는 화면·서버·저장소를 잇는 흐름일 때 필요하다. 두 조건의 판단 이유를 decision으로 남긴다. 네 리뷰어 이름과 결과 `PASS` / `CHANGES_REQUIRED`를 그대로 쓴다.

`<project>/docs/inprogress/<task-slug>.office.json`이 같은 작업에 있으면 읽고 기존 `run_id`와 URL을 재사용한다. 현재 승인 계획·진행 상태·열린 질문도 재개한다. Office의 `GET /api/state`에서 이 run의 저장 상태를 확인할 수 있다. 알 수 없는 run_id를 무시하고 새 run으로 바꾸지 않는다. 참조할 전체 상태를 유지한다: tasks는 id별, decisions는 title별, reviews는 round+reviewer별로 병합하며 task의 `after` 참조를 보존한다.

## 2. 진행 보고

`mcp__office__report`와 `mcp__office__ask`가 모두 있으면 Office 모드다. ralplan 시작 시 첫 `report`를 보내 회의실을 연다. `project_path`는 저장소의 절대 경로, `title`은 작업 이름, `doc_path`는 알려진 spec Markdown 경로다.

```json
{"project_path":"<absolute-project>","title":"<작업 이름>","doc_path":"<spec.md>","patch":{"stage":"계획","summary":"ralplan 회의 중","todo":"없음","blockers":"없음","tasks":[{"id":"PLAN","title":"ralplan 계획","owner":"leader","lane":"plan","status":"진행중"}]}}
```

응답의 `run_id`를 즉시 아래 sidecar에 저장한다. `url`은 `http://127.0.0.1:4780/#/run/<run_id>`다. 이후 모든 report에 이 `run_id`를 넣는다.

```json
{"run_id":"<returned-run-id>","url":"http://127.0.0.1:4780/#/run/<returned-run-id>"}
```

원본의 모든 `progress.py update` 지점에서 **동일한 patch**를 `report`로 보낸다. `doc_path`는 계획이 승인된 다음에만 승인 계획 Markdown으로 전환한다. 파일 생성이나 리뷰 진행만으로 전환하지 않는다. 계획 승인·각 리뷰 결과·blocker·종료 브리핑에는 stage, 완료/남은 일, todo, blocker와 이 URL을 포함한다.

검증 오류·잘못된 run_id·도구의 `isError`는 연결 실패가 아니다. 내용을 확인해 호출 또는 계획을 고치고 성공한 것으로 기록하지 않는다.

## 3. 결재와 문서 변경

원본 흐름상 사용자 결정이 필요한 질문만 `ask`로 보낸다. 질문, 2–4개의 구체적인 `options`, 그중 하나인 `recommended`, 현재 `run_id`를 넣는다. 응답이 `answered`이면 저장된 답으로 진행한다. `pending`이면 반환된 `ask_id`를 보존하고, 독립 작업을 진행하면서 **같은 id**로 재호출한다. 동일 질문을 새 ask로 중복 생성하지 않는다. 앱의 권장값은 사용자 답변을 대신하지 않는다.

사용자가 Esc 후 터미널에 직접 답하면 그 답을 반영하고 다음 report에 `close_ask_ids: ["<ask_id>"]`를 추가한다. 완료·중단 report는 run의 남은 질문도 닫는다. 닫힌 ask의 `ask closed`는 새 질문을 자동 생성할 이유가 아니다.

report 응답의 `doc_changes`가 비어 있지 않으면 diff를 읽고 변경 요지를 알린 뒤 다음 결재를 보낸다.

```json
{"run_id":"<run-id>","question":"기획서가 바뀌었습니다. 재계획할까요?","options":["재계획","그대로 진행"],"recommended":"재계획"}
```

답이 오기 전 변경에 의존하는 구현은 기다리되 독립 작업은 계속한다. 재계획 답변이면 원본 계획 흐름으로 돌아가고 승인 후 계획 문서를 연결한다. 그대로 진행이면 결정 이유를 report에 남긴다.

## 4. HTML 폴백

도구가 없거나 report가 실제 연결 오류(연결 거부·서버 도달 불가 등)로 실패하면 이유를 알리고 **그 run의 나머지 기간은** HTML을 사용한다. 앱 장애가 제품 작업을 막지 않도록 한다. 질문은 터미널 채팅으로 하고 앱에 남아 있는 질문은 접근 가능해졌을 때 닫거나 최종 종료 report로 정리한다. 검증·권한·입력 오류를 폴백으로 숨기지 않는다.

`PAGE`는 원본 규칙의 `<project>/docs/inprogress/<task-slug>-<YYYYMMDD-HHmm>.html`, `TITLE`은 작업명이다. 새 파일에만 init을 실행한다. 기존 폴백 페이지를 재개하면 init으로 덮어쓰지 않는다.

```sh
uv run "$BT/scripts/progress.py" init "$PAGE" --title "$TITLE"
```

**중간 전환 시에는 첫 incremental update 전에 전체 상태를 복원한다.** 현재 상태에서 `title`, `stage`, `summary`, `todo`, `blockers`, 모든 tasks/decisions/reviews를 포함한 유효한 patch를 `<project>/docs/inprogress/<task-slug>.full-state.json`에 쓴다. 일부 최근 패치만 복사하지 않는다. 완료·중단된 task와 모든 `after`가 참조하는 task도 포함한다. decisions에 `{"title":"Office 폴백","body":"<실제 연결 실패 또는 도구 없음 사유>"}`를 병합하고 다음 명령으로 한 번에 seed한다. 최초부터 폴백일 때도 이 decision을 첫 update에 넣는다.

```sh
uv run "$BT/scripts/progress.py" update "$PAGE" --input "$FULL_STATE"
```

`FULL_STATE`는 위 full-state JSON 파일의 절대 경로다. full seed 이후 원본 체크포인트에서 바뀐 필드만 update한다. 아래 JSON은 명령 형식 예시이며 실제 현재 patch를 전달한다.

```sh
uv run "$BT/scripts/progress.py" update "$PAGE" --input - <<'JSON'
{"stage":"구현","summary":"팀 구현 진행 중","todo":"없음","blockers":"없음"}
JSON
uv run "$BT/scripts/progress.py" status "$PAGE"
```

브리핑의 페이지 링크는 폴백 HTML 절대 경로로 바꾼다. 원본의 `references/progress-example.md` 패치·병합·시간·종료 규칙을 유지한다. 종료는 실제 완료 또는 중단 상태로 기록하고, 연결 실패만으로 제품 run을 완료 처리하지 않는다.
