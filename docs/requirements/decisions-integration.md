# 결재와 실행 연동

상태: 현재 구현. 사용자는 대표실에서 필요한 결정을 전달하고 터미널의 원본 basic-team은 그 답을 받아 진행한다. 앱이 에이전트를 직접 실행하지 않는다.

## ask 계약

`POST /mcp`의 `ask`는 `run_id`, `question`, `options`와 선택적인 `recommended`, `ask_id`를 받는다. 서버 선택지는 1–6개를 허용하고 basic-team은 구체적인 2–4개와 그중 추천값을 보낸다. 신규 질문은 DB에 pending으로 저장한다. 기본 295000ms 안에 브라우저 답이 오면 `{status:"answered",answer,ask_id}`, 시간 내 답이 없으면 `{status:"pending",ask_id}`를 반환한다. pending은 질문 종료가 아니다. 같은 id로 재호출하고 질문을 중복 생성하지 않는다. 저장된 답은 같은 id 재호출에서도 반환된다. 정확한 타입은 [contract.ts](../../shared/contract.ts)다.

ask 최상위의 알 수 없는 필드를 거부하고, recommended가 있으면 options에 포함되는지 검증한다. 포함되지 않은 추천값은 질문을 저장하기 전에 오류로 반환한다. 읽기 전용 `get_run({run_id})`으로 해당 실행의 pending 질문을 조회할 수 있다([변경 008](../changes/008-mcp-validation.md)). 조회 자체는 질문을 답변·종료하거나 대기 호출을 만들지 않는다.

대표실 선택지는 `POST /api/asks/:id/answer`에 `{answer}`로 보낸다. 선택지 외 값은 400, 없는 질문은 404, 이미 처리된 질문은 409다. 사용자가 창을 닫거나 Esc를 눌러도 질문은 남는다. 전송 중 중복 선택을 막고 실패 시 오류를 표시한다. 추천은 사용자의 답을 대신하지 않는다.

터미널에서 답하려면 도구 대기를 Esc로 끊고 채팅으로 답한다. 리더는 다음 report의 최상위 `close_ask_ids`로 해당 질문을 닫는다. 완료·중단 report는 남은 pending 질문을 닫는다. 종료 run의 새 질문과 닫힌 질문 재호출은 오류다. 취소된 HTTP 호출의 waiter는 해제하지만 DB 질문은 유지한다.

## 스킬 연결과 폴백

lukas-plugin basic-team의 Office 모드는 office `report`·`ask` 도구가 있을 때 켜지며 계획·병렬 구현·독립 리뷰·수정·검증 절차는 그대로다. 각 progress.py update 지점에서 같은 patch를 report한다. run id와 URL은 `docs/inprogress/<task-slug>.office.json`에 보존하며 같은 작업 재개 시 재사용한다.

도구 부재 또는 실제 연결 오류이면 해당 run의 나머지는 기존 progress.py HTML을 사용한다. 중간 전환은 전체 tasks·decisions·reviews와 after 참조를 먼저 복원하고 이후 incremental update를 보낸다. 검증·입력·권한 오류는 폴백 이유가 아니며 수정해야 한다. HTML 진행·sidecar는 [문서 관리 규칙](../AGENTS.md)의 런타임 예외다.

## 완료·검증 기준

앱 답변→대기 호출, pending→동일 id 재시도, 터미널 답변 종료, 중복 답변 거부, run 종료·재시작·연결 취소를 검증한다. 근거는 [app 테스트](../../server/app.test.ts), [store 테스트](../../server/store.test.ts), [패널 테스트](../../web/src/Panels.test.tsx)다. SDK 재생과 실제 Claude Code 실행은 구분한다. 2026-10-19 Claude Code 2.1.303·sonnet·`MCP_TOOL_TIMEOUT=325000`의 실제 긴 대기와 동일 id 답변 전달을 확인했다. 환경별 결과와 전체 실행 상태는 [변경 기록](../changes/001-office-team-reporter.md)을 따른다.
