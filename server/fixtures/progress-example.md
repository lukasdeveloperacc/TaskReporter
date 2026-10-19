# Progress page example

A real-shaped run, saved at the moments SKILL.md asks for. Each block is one `update` patch; send only what changed. The page draws the graph from `lane`, `status` and `after`, so keeping those three right is what matters.

Conventions used here:
- Lane is the kind of work, not when it happened: planner/architect/critic and user approval → `plan`, executor work (including prototype tweaks) → `build`, every review round → `review`, only fixes → `fix`, final checks/report → `finish`. The page draws the arrow back from a fix to the next round.
- Agent tasks carry the full model ID and effort (not the spawn alias), so the card shows exactly which model version ran each task.
- If an agent runs on a different model or effort than SKILL.md's table, record why as a decision.
- One card per piece of work, including each review per round (`R1-K`, `R2-K`) and each fix, so the graph shows the loop.
- Set a task to `진행중` when its agent starts (the full check too, and each round's review cards at dispatch), so its card shows how long it has run; publish verdicts in `reviews` only after all reviewers returned.
- Work that is dropped or replaced (a plan the user stopped, a superseded prototype) becomes `중단`, never `완료`.
- `note` carries the one-line result a person needs (a verdict, a count, why it is blocked).
- Notes on check results say `직접 확인` (the leader saw the command run) or `담당자 보고` (the agent's report).
- A blocked task stays `진행중` with the reason in `note`, and `blockers` says the same at the top.
- `todo` holds what the user must do or decide; `blockers` only what stops the run.
- `summary` says what is happening now and what comes next, in plain Korean.
- The script stamps `started`/`finished` and sets stage `완료` itself; do not send them.

```sh
uv run "<skill-dir>/scripts/progress.py" init "<project>/docs/inprogress/external-stt-import-20261012-1150.html" --title "외부 STT 가져오기 끊김 해결 + 외부 작업 판정 통일"
```

## 1. Plan approved, tasks split (end of step 2)

```json
{"stage": "구현", "summary": "ralplan 계획이 승인되어 계약(C-1)부터 구현을 시작했습니다", "blockers": "없음",
 "todo": "결정 'Notion 동기화 제외'가 맞는지 확인해 주세요 (요청에 없어 빼는 것으로 가정)",
 "tasks": [
  {"id": "PLAN", "title": "ralplan 계획", "owner": "leader", "lane": "plan", "status": "완료", "note": "plan-r4 승인"},
  {"id": "C-1", "title": "OpenAPI 계약 갱신 + 타입 재생성", "owner": "backend-1", "model": "claude-haiku-5-5", "effort": "max", "lane": "build", "status": "진행중", "after": ["PLAN"]},
  {"id": "BE-1", "title": "가져오기 안에서 음성 검증까지 처리", "owner": "backend-1", "model": "claude-haiku-5-5", "effort": "max", "lane": "build", "status": "대기중", "after": ["C-1"]},
  {"id": "BE-2", "title": "외부 작업에 교정 구간 복사·제출 규칙", "owner": "backend-2", "model": "claude-haiku-5-5", "effort": "max", "lane": "build", "status": "대기중", "after": ["C-1"]},
  {"id": "FE-1", "title": "3단계 표시·로딩·잠금, 공개 대기 라벨", "owner": "frontend-1", "model": "claude-haiku-5-5", "effort": "max", "lane": "build", "status": "대기중", "after": ["C-1"]},
  {"id": "FE-2", "title": "외부 작업 상세를 엑셀 판정 UI로 통일", "owner": "frontend-2", "model": "claude-haiku-5-5", "effort": "max", "lane": "build", "status": "대기중", "after": ["C-1"]},
  {"id": "CHECK", "title": "전체 테스트·빌드", "owner": "backend-1", "model": "claude-haiku-5-5", "effort": "max", "lane": "build", "status": "대기중", "after": ["BE-1", "BE-2", "FE-1", "FE-2"]}],
 "decisions": [
  {"title": "Impeccable 리뷰 필요", "body": "3단계 표시, 목록 라벨, 판정 화면 등 보이는 UI가 바뀜"},
  {"title": "E2E 리뷰 필요", "body": "가져오기 → 이어하기 → 공개 → 판정 → 제출이 화면·서버·DB를 가로지름"},
  {"title": "Notion 동기화 제외", "body": "가정: 요청에 없어 이번 범위에서 뺌 (사용자 확인 필요)"}]}
```

## 2. A blocker during build; the user answers the to-do

```json
{"todo": "없음", "blockers": "BE-1: 로컬 MinIO 버킷이 없어 통합 테스트 실패 — 시드 스크립트로 생성 후 재시도 중",
 "tasks": [
  {"id": "C-1", "status": "완료"}, {"id": "BE-2", "status": "진행중"}, {"id": "FE-1", "status": "진행중"}, {"id": "FE-2", "status": "진행중"},
  {"id": "BE-1", "status": "진행중", "note": "막힘: 테스트 버킷 없음"}],
 "decisions": [{"title": "Notion 동기화 제외", "body": "사용자 확인: 이번 범위에서 빼기로 함"}]}
```

## 3. Build done, first review round dispatched (start of step 4)

```json
{"stage": "리뷰 (1라운드)", "summary": "구현과 전체 검사가 끝나 4명이 같은 revision을 리뷰하고 있습니다", "blockers": "없음",
 "tasks": [
  {"id": "BE-1", "status": "완료", "note": ""}, {"id": "BE-2", "status": "완료"}, {"id": "FE-1", "status": "완료"}, {"id": "FE-2", "status": "완료"},
  {"id": "CHECK", "status": "완료", "note": "백엔드 392 · 통합 339 · 프론트 1435 통과 (담당자 보고)"},
  {"id": "R1-K", "title": "Karpathy 리뷰 R1", "owner": "Karpathy Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["CHECK"]},
  {"id": "R1-P", "title": "Ponytail 리뷰 R1", "owner": "Ponytail Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["CHECK"]},
  {"id": "R1-I", "title": "Impeccable 리뷰 R1", "owner": "Impeccable Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["CHECK"]},
  {"id": "R1-E", "title": "E2E 리뷰 R1", "owner": "E2E Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["CHECK"]}]}
```

## 4. First round finished (end of step 4)

```json
{"stage": "수정 (1라운드)", "summary": "1차 리뷰에서 Impeccable이 필수 수정 1건을 냈습니다. 담당자가 고친 뒤 4명이 새 revision을 다시 리뷰합니다",
 "tasks": [
  {"id": "R1-K", "status": "완료", "note": "PASS"}, {"id": "R1-P", "status": "완료", "note": "PASS · 권고 2건"},
  {"id": "R1-I", "status": "완료", "note": "수정 필요: 경고 사유 색 대비"}, {"id": "R1-E", "status": "완료", "note": "PASS · 5개 시나리오"},
  {"id": "FIX-1", "title": "경고 사유 색·대비 수정", "owner": "frontend-1", "model": "claude-haiku-5-5", "effort": "max", "lane": "fix", "status": "진행중", "after": ["R1-I"]}],
 "reviews": [
  {"round": 1, "reviewer": "Karpathy Agent", "verdict": "PASS", "note": "요구사항·계약 범위 이상 없음"},
  {"round": 1, "reviewer": "Ponytail Agent", "verdict": "PASS", "note": "권고: 중복 표시 정리, 재시도 경로 테스트 보강"},
  {"round": 1, "reviewer": "Impeccable Agent", "verdict": "CHANGES_REQUIRED", "note": "경고 사유 텍스트 대비 3.1:1 → 4.5:1 이상 필요"},
  {"round": 1, "reviewer": "E2E Agent", "verdict": "PASS", "note": "가져오기→이어하기→공개→판정→제출 실제 브라우저 확인"}]}
```

## 5. Fix done, second round dispatched (step 5)

```json
{"stage": "리뷰 (2라운드)", "summary": "수정이 끝나 4명이 새 revision을 다시 리뷰하고 있습니다",
 "tasks": [
  {"id": "FIX-1", "status": "완료", "note": "대비 4.8:1, 프론트 테스트 통과 (담당자 보고)"},
  {"id": "R2-K", "title": "Karpathy 리뷰 R2", "owner": "Karpathy Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["FIX-1"]},
  {"id": "R2-P", "title": "Ponytail 리뷰 R2", "owner": "Ponytail Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["FIX-1"]},
  {"id": "R2-I", "title": "Impeccable 리뷰 R2", "owner": "Impeccable Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["FIX-1"]},
  {"id": "R2-E", "title": "E2E 리뷰 R2", "owner": "E2E Agent", "model": "claude-sonnet-5-5", "effort": "high", "lane": "review", "status": "진행중", "after": ["FIX-1"]}]}
```

## 6. Second round passed (end of step 5)

```json
{"stage": "마무리", "summary": "2차 리뷰에서 4명 모두 PASS했습니다. 최종 검사 후 에이전트를 종료하고 보고합니다",
 "tasks": [
  {"id": "R2-K", "status": "완료", "note": "PASS"}, {"id": "R2-P", "status": "완료", "note": "PASS"},
  {"id": "R2-I", "status": "완료", "note": "PASS"}, {"id": "R2-E", "status": "완료", "note": "PASS"},
  {"id": "DONE", "title": "최종 검사 · 에이전트 종료 · 보고", "owner": "leader", "lane": "finish", "status": "진행중", "after": ["R2-K", "R2-P", "R2-I", "R2-E"]}],
 "reviews": [
  {"round": 2, "reviewer": "Karpathy Agent", "verdict": "PASS"}, {"round": 2, "reviewer": "Ponytail Agent", "verdict": "PASS"},
  {"round": 2, "reviewer": "Impeccable Agent", "verdict": "PASS", "note": "대비 기준 충족"}, {"round": 2, "reviewer": "E2E Agent", "verdict": "PASS"}]}
```

## 7. Finished (end of step 6)

No `stage` here: closing the finish task sets it to `완료`.

```json
{"summary": "모든 리뷰 PASS, 최종 검사 통과, 에이전트 종료. 변경은 커밋하지 않은 채 작업 트리에 있습니다",
 "todo": "커밋·push 여부 결정 (아직 하지 않음)",
 "tasks": [{"id": "DONE", "status": "완료", "note": "테스트 통과 (직접 확인) · 에이전트 8명 종료"}]}
```
