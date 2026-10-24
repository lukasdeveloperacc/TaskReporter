# 결재와 실행 연동

상태: 현재 구현. 사용자는 대표실에서 필요한 결정을 전달하고 터미널의 원본 basic-team은 그 답을 받아 진행한다. 앱이 에이전트를 직접 실행하지 않는다.

아래 [에이전트 체크인](#에이전트-체크인)은 로컬 구현 상태다. backend 대상 검사 4개 파일·65개 테스트와 typecheck를 통과했으며 전체 검사·독립 리뷰·실제 호스트 적응 검증은 별도다.

## report 상태 조회

report의 선택 입력 include_state는 boolean이다. false면 응답 state만 생략하고 run_id·ended_at·doc_changes·checks·asks는 유지한다. 미지정/true는 기존 응답이다. get_run은 기존 필드와 함께 전체 state를 반환한다. 스킬은 tools/list의 report.inputSchema.properties.include_state로 지원을 확인한다. DB·기본 응답 정책은 바꾸지 않는다.

## 신규/재개 전 탐색 연동

상태: 로컬 구현·전체 자동 검사·실제 브라우저 확인 완료. 결과는 [변경 021](../changes/021-office-mcp-discovery.md)과 [스킬 협업 023](../changes/023-office-mcp-client-coordination.md)에서 연결한다. 클라이언트는 `tools/list`에서 지원을 확인하고 신규 실행을 생성하거나 기존 실행을 재개하기 전에 `get_office_rules({})`와 `get_active_runs({project_path})`를 읽는다. 기존 sidecar의 run_id도 활성 실행 목록·실제 작업과 대조한다. 같은 작업의 실행에만 확인한 run_id를 재사용하고 독립 작업은 새 실행으로 보고한다. 탐색 자체는 실행을 재개하거나 다른 실행을 종료하지 않는다.

report의 추가 응답 `placements`는 이번 patch의 task ID를 병합 후 상태에서 계산한다. get_run은 모든 task의 placements와 전체 state를 반환한다. include_state false에서도 placements는 유지한다. fallback이면 owner 규칙과 실제 담당자를 확인하고 필요한 경우 명시적으로 수정한다. 배정 값은 데이터에서 계산한 결과이며 화면에 캐릭터가 표시되었다는 증거가 아니다. 경로·규칙·미배정·동일 owner의 유효 lane 의미는 [보고 요구사항](progress-office.md#사무실-탐색과-배정-확인)을 따른다.

최초 생성 report의 선택 응답 `active_runs`와 `get_run.last_report_at`은 [변경 023](../changes/023-office-mcp-client-coordination.md)의 스킬 협업 계약이다. 클라이언트는 도구·필드 지원 여부를 확인하며 구버전의 필드 생략을 다른 실행이 없다는 증거로 해석하지 않는다. 표시용 owner와 native 실행 식별자는 구분하고 추가 요구의 기존 작업 지속 여부·계획 반영은 보고자가 설명한다. 외부 스킬은 PersonalAgentPlugins의 별도 커밋으로 관리한다.

외부 [PersonalAgentPlugins의 basic-team](https://github.com/lukasdeveloperacc/PersonalAgentPlugins)에 이 순서를 적용하도록 권고하는 안내다. 이번 저장소 변경은 외부 스킬 소스·설치 캐시를 수정하지 않으며 호스트나 기존 설치본의 자동 준수를 보장하지 않는다. 탐색 도구 없는 구버전 서버에서는 기존 계약을 유지하고 탐색 성공으로 보고하지 않는다. 실제 연결 실패의 HTML 폴백은 기존 [규칙](#스킬-연결과-폴백)을 따른다.

## run 회고

로컬 구현·검증 상태다(배포 전). 범위·검증은 [변경 017](../changes/017-run-retro.md)을 따른다. 목적은 basic-* 스킬 실행이 끝날 때 스킬 지시·도구·프로세스에서 막힌 점을 모아 이후 스킬·MCP 개선의 근거로 쓰는 것이다. 코드 결함은 리뷰 기록에 남기며 회고 대상이 아니다.

- report 최상위 선택 입력 `retro`는 `{skill, skill_version, category, evidence, suggestion?}` 0–3개다. category는 `instruction_gap`·`tool_friction`·`user_correction`·`review_miss`·`other`, skill·skill_version은 1–64자, evidence·suggestion은 500자 이하다. skill_version(예: `0.1.0+bb590a2`)은 파싱하지 않는 문자열이다. 알 수 없는 키는 거부한다.
- patch 병합 후 run이 종료 상태(finish task 자동 종료 포함)일 때만 받는다. 아니면 `retro requires ended run` 오류이며 report 전체가 롤백된다. 종료된 run에는 `patch:{}`와 retro만 보낼 수 있고 재개되지 않으며 ended_at도 유지한다. 다시 보내면 run 단위로 교체하고, 같은 내용 재전송은 최초 제출 시각을 유지한다. `[]`는 회고 없음 제출이다. 작업 id `__retro__`는 예약어로 거부한다.
- 회고 없이 run을 끝내는 report에서만(이미 끝난 기존 run의 이후 report에서는 아님) 그 run에 `task_id:"__retro__"`, owner null인 체크를 한 번만 만든다. 이 체크는 종료 정리에서 닫히지 않는다. retro 제출 시 `retro <n>건`으로 answered가 되고, check_replies 텍스트 답도 받는다. run이 재개되면 닫히며 다시 만들지 않는다. 답하지 않아도 완료를 막지 않는다.
- `get_run.retro`는 `{submitted_at, items}`다. 읽기 전용 `get_retros({skill?, category?, since?, project_path?})`는 최근 200행 기준으로 skill+category 묶음(`run_count`, `skill_versions`, `last_at`, 서로 다른 run이 2개 이상이면 `candidate:true`)과 run별 서버 신호(stage, ended_at, 최대 review round, `__retro__`를 제외한 체크 answered·미응답 closed 수·평균 응답 ms), `truncated`를 반환한다. since(시간대가 있는 ISO date-time)로 스킬 수정 전후를 나누며 project_path는 절대 경로여야 한다. 200행 제한에서 한 run의 항목이 잘릴 수 있고 이때 truncated가 true다. ask 대기 시간은 답변 시각을 저장하지 않아 제공하지 않는다.
- `get_retros.submission`은 종료된 run의 회고 제출 현황이다: `ended_runs`, `submitted`(retro_at 있음), 그중 `empty`(`retro:[]`), `missing`, 최근 미제출 20개 `recent_missing[{run_id, project_path, ended_at}]`. 미제출 run에는 스킬 정보가 없으므로 skill·category 필터는 적용하지 않고 since(ended_at 기준)·project_path만 적용한다. 기능 배포 전에 끝난 run도 미제출로 세므로 since로 배포 이후를 본다. 회고 강제(미제출 시 완료 거부)는 이 수치를 보고 결정한다([변경 018](../changes/018-retro-submission-rate.md)).
- 스킬은 `report.inputSchema.properties.retro`로 지원을 확인한다.

## ask 계약

`POST /mcp`의 `ask`는 `run_id`, `question`, `options`와 선택적인 `recommended`, `ask_id`를 받는다. 서버 선택지는 1–6개를 허용하고 basic-team은 구체적인 2–4개와 그중 추천값을 보낸다. 신규 질문은 DB에 pending으로 저장한다. 기본 100000ms(기존 295초에서 단축) 안에 브라우저 답이 오면 `{status:"answered",answer,ask_id}`, 시간 내 답이 없으면 `{status:"pending",ask_id,retry_after_sec:0,message:"같은 ask_id로 ask를 다시 호출하세요. 새 질문을 만들지 마세요."}`를 반환한다. pending은 질문 종료가 아니다. retry_after_sec 뒤 같은 id로 재호출하고 질문을 중복 생성하지 않는다. 저장된 답은 같은 id 재호출에서도 반환된다. 정확한 타입은 [contract.ts](../../shared/contract.ts)다.

ask 최상위의 알 수 없는 필드를 거부하고, recommended가 있으면 options에 포함되는지 검증한다. 포함되지 않은 추천값은 질문을 저장하기 전에 오류로 반환한다. 읽기 전용 `get_run({run_id})`으로 해당 실행의 pending·answered 질문을 조회할 수 있다([변경 008](../changes/008-mcp-validation.md)). get_run.asks는 기존 id·question·options 등을 유지하면서 ask_id를 추가한다. report.asks는 답변된 질문만 {ask_id,status:"answered",answer}로 반복 전달한다. 두 경로는 run별 공통 조회를 사용하고 closed 질문은 제외한다. 클라이언트는 ask_id로 중복 처리한다. 조회 자체는 질문을 답변·종료하거나 대기 호출을 만들지 않으며 수신 확인 상태를 저장하지 않는다. report가 없는 결재 대기 중에는 동일 ask_id 재호출을 계속한다. tools/list의 outputSchema에서 report/get_run의 asks와 ask의 retry_after_sec를 감지한다. ack·wait_sec 옵션·DB 마이그레이션은 추가하지 않는다.

대표실 선택지는 `POST /api/asks/:id/answer`에 `{answer}`로 보낸다. 선택지 외 값은 400, 없는 질문은 404, 이미 처리된 질문은 409다. 사용자가 창을 닫거나 Esc를 눌러도 질문은 남는다. 전송 중 중복 선택을 막고 실패 시 오류를 표시한다. 추천은 사용자의 답을 대신하지 않는다.

터미널에서 답하려면 도구 대기를 Esc로 끊고 채팅으로 답한다. 리더는 다음 report의 최상위 `close_ask_ids`로 해당 질문을 닫는다. 완료·중단 report는 남은 pending 질문을 닫는다. 종료 run의 새 질문과 닫힌 질문 재호출은 오류다. 취소된 HTTP 호출의 waiter는 해제하지만 DB 질문은 유지한다.

## 스킬 연결과 폴백

lukas-plugin basic-team의 Office 모드는 office `report`·`ask` 도구가 있을 때 켜지며 계획·병렬 구현·독립 리뷰·수정·검증 절차는 그대로다. 각 progress.py update 지점에서 같은 patch를 report한다. run id와 URL은 `docs/inprogress/<task-slug>.office.json`에 보존하며 같은 작업 재개 시 재사용한다.

도구 부재 또는 실제 연결 오류이면 해당 run의 나머지는 기존 progress.py HTML을 사용한다. 중간 전환은 전체 tasks·decisions·reviews와 after 참조를 먼저 복원하고 이후 incremental update를 보낸다. 검증·입력·권한 오류는 폴백 이유가 아니며 수정해야 한다. HTML 진행·sidecar는 [문서 관리 규칙](../AGENTS.md)의 런타임 예외다.

## 완료·검증 기준

앱 답변→대기 호출, pending→동일 id 재시도, 터미널 답변 종료, 중복 답변 거부, run 종료·재시작·연결 취소를 검증한다. 근거는 [app 테스트](../../server/app.test.ts), [store 테스트](../../server/store.test.ts), [패널 테스트](../../web/src/Panels.test.tsx)다. SDK 재생과 실제 Claude Code 실행은 구분한다. 2026-10-19 Claude Code 2.1.303·sonnet·`MCP_TOOL_TIMEOUT=325000`의 실제 긴 대기와 동일 id 답변 전달을 확인했다. 환경별 결과와 전체 실행 상태는 [변경 기록](../changes/001-office-team-reporter.md)을 따른다.

## 에이전트 체크인

목적은 오래 변하지 않은 진행중 작업에 실제 상황 설명을 요청하고, model·effort가 누락된 작업에는 실제 런타임 관찰값을 확인하는 것이다. 체크인은 사용자 결재 `ask`와 별도이며, 응답은 설명 기록이다. 응답만으로 작업을 완료하거나 에이전트의 정상 작동을 입증하지 않는다. 범위와 검증 진행은 [변경 010](../changes/010-agent-check-ins.md)에서 관리한다.

승인 집계 확장([변경 026](../changes/026-office-aggregate-and-focused-read.md), 로컬 구현·검증 완료, 실행 서버 반영 별도): `task.kind: aggregate`는 단일 작업자가 없는 집계이므로 model/effort 누락 확인만 면제한다. 30분 정체·TODO 정체와 성공 종료 조건은 그대로 적용한다. kind 생략 또는 actor는 기존 누락 검사를 유지한다. 유효 kind 전환은 과거 pending 체크를 closed로 보존하고 관찰 기준을 새로 설정한다. 집계를 실제 actor 설정 누락을 숨기는 용도로 사용하지 않는다.

### 감지와 작업별 기준 시각

- 타이머 없이 다음 정상 `report` 처리 시 해당 run의 `진행중` 작업을 검사한다. 작업별 의미 있는 변경 기준 시각보다 [기존 `STALE_MS`](../../shared/contract.ts)의 1,800,000ms **이상**이고 pending 요청이 없으면 한 건을 만든다. 정확히 경계 시각에도 생성 대상이다. 보고가 없으면 요청도 새로 만들지 않는다.
- 병합된 진행중 task의 model 또는 effort가 생략되었거나 빈 문자열·공백뿐이면 30분을 기다리지 않고 그 report에서 체크인을 요청한다. 새 작업·기존 데이터 첫 관찰·현재 업무 변경 보고도 이 검사 대상이다. 질문은 누락된 필드(model, effort 또는 둘 다)를 명시하고 실제 관찰한 런타임 값을 묻는다. 정체 조건도 충족하면 한 질문에서 진행 설명과 누락값을 함께 묻는다. 모든 질문에는 model·effort가 누락되면 실제 값을 확인·보고하라는 조건부 안내도 포함한다. 따라서 생성 후 추가 누락이 생겨도 기존 pending의 ID·question을 바꾸거나 두 번째 요청을 만들지 않는다. 별도 요청 종류·`missing_fields` 필드·도구를 추가하지 않고 기존 `question`과 run·task당 pending 최대 한 건 규칙을 사용한다.
- 기준 시각과 비교할 작업 상태는 SQLite에 run·task별로 보존한다. 다른 작업의 보고, run의 summary·todo·blockers·stage·title, 문서 변경, `state.updated`·`last_report_at` 갱신은 해당 작업의 시간을 초기화하지 않는다.
- 의미 있는 변경은 병합 후 작업의 실제 업무 값인 status·owner·note·todos의 변경이다. 같은 값을 다시 보내거나 필드가 생략되어 유지되는 것은 변경이 아니다. title·after·lane·model·effort와 서버 생성 started·finished만 바뀌는 보고는 기준 시각을 초기화하지 않는다. TODO의 내용·체크 상태 변경도 의미 있는 변경이다.
- 새로 관찰한 진행중 작업과 진행중으로 전환한 작업은 그 보고 시각부터 측정한다. 기존 DB에 기준 기록이 없는 작업도 첫 관찰 시각부터 측정하며 run의 마지막 보고나 오래된 started로 과거 정체를 추정하지 않는다. 현재 patch에 의미 있는 변경이 있으면 기준 시각을 먼저 초기화해 그 보고에서는 새 정체 요청을 만들지 않는다. 이미 pending인 요청은 답변 처리하지 않는다(owner 변경의 종료 처리는 아래 수명주기를 따른다).

### 전달·응답·종료

요청은 서버가 만든 request ID, run ID, task ID, 요청 시각과 설명 요청 내용을 가진다. 합의한 응답 항목은 `id`, `run_id`, `task_id`, `owner`(string 또는 null 스냅샷), `question`, `status`, `created_at`, `answer`, `responded_at`이며 응답 전 answer·responded_at은 null이다. 같은 run·task에는 pending 요청을 최대 하나만 둔다. 미응답 요청은 해당 run의 매 `report` 응답에 반복해서 포함한다. 전송 성공이나 다음 보고 수신은 수신 확인·응답이 아니다. 읽기 전용 `get_run`에는 그 run의 전체 요청 이력(pending·answered·closed)을 포함하되 조회는 요청 생성·응답·시간 초기화를 하지 않는다.

클라이언트는 응답의 요청을 읽고 해당 작업 담당자의 실제 진행·대기·장애 사유를 확인해 request ID와 설명을 이후 `report`에 함께 보낸다. model·effort 질문에는 다음 `patch.tasks`의 해당 task에 실제 관찰값을 보내고 `check_replies`에도 명시적으로 설명한다. 런타임 값을 확인할 수 없다면 확인하지 못한 실제 이유를 설명하고 모르는 필드는 생략한다. 기본값·요청받은 설정·추측을 관찰값으로 지어내지 않는다. model·effort를 채우는 것만으로 업무 진척으로 보거나 pending을 응답 처리하지 않는다.

추가 계약: 체크인 생성 시 해당 작업의 `done !== true`인 TODO id·text를 question에 포함하고 모든 질문에 최신 TODO를 다시 확인하라는 일반 안내를 넣는다. 이후 TODO가 추가되어도 저장된 pending 질문을 바꾸거나 추가 요청을 만들지 않는다. 정상 진행중인 작업에 TODO가 남았다는 이유만으로 즉시 요청하지 않으며, 정체·metadata 누락으로 생성되는 질문에 남은 일을 함께 담는다. 적응된 클라이언트는 실제 남은 업무를 해결하고 해당 TODO의 `done:true`를 patch로 보고한다. 설명이나 체크 표시만으로 실제 일을 끝낸 것으로 가장하지 않는다. 성공 종료는 [미완료 TODO 방지 규칙](progress-office.md#미완료-todo의-성공-종료-방지)을 따른다. 수행할 수 없어 종료해야 하면 남은 일을 보존한 명시적 run 중단을 사용하고 성공 완료로 표시하지 않는다.

ID만 보내거나 빈 문자열·공백뿐인 설명은 거부한다. 유효한 설명을 저장하면 요청은 answered가 되고 그 작업의 기준 시각을 응답 수락 시각으로 재설정해 즉시 재생성하지 않는다. model·effort가 여전히 누락되어도 수락된 응답 이후 STALE_MS 미만에는 누락 재요청을 만들지 않으며, STALE_MS 이상인 다음 report에서 다시 요청할 수 있다. 누락 쿨다운은 마지막 수락 응답을 기준으로 영속 보존하며 업무 진척 기준 시각과 구분한다. note·TODO 등 업무 변경은 누락 쿨다운을 연장하거나 우회하지 않는다. 이 쿨다운은 서버 재시작 후에도 유지한다. 동일한 수락 응답의 replay는 쿨다운을 연장하지 않는다. 작업이 계속 진행중이고 그 후 다시 임계시간에 도달하면 새 요청을 만들 수 있다. 설명 수락 자체는 task status·todos·run stage를 변경하지 않는다.

작업이 `진행중`을 벗어나면(`대기중`·`완료`·`중단`) 해당 pending 요청을 닫는다. owner 변경도 이전 담당자의 pending을 닫고 기준 시각을 초기화한다. 새 담당자의 정보가 누락되면 이전 담당자의 응답 쿨다운을 적용하지 않고 즉시 새 요청을 만들 수 있다. 같은 report에서 이전 담당자의 유효 응답을 수락하고 owner를 변경해도 응답은 이전 담당자 이력으로 저장하며 새 담당자의 즉시 누락 요청을 억제하지 않는다. run 종료는 남은 pending 요청 전체를 closed로 만든다. 종료된 run에 조회·재시작만으로 새 요청을 만들지 않으며 기존 종료 이력에 요청을 소급 생성하지 않는다. 기존 report 계약에 따라 run이 다시 열리면 진행중 작업은 재개 보고 시각부터 새 기준을 잡고 closed 요청은 다시 pending으로 열지 않는다. 동일 owner로 run을 다시 열면 업무 진척 시각은 초기화하되 최근 수락 응답의 누락 쿨다운은 유지한다. 종료 보고에 유효한 응답이 함께 있으면 응답을 저장한 뒤 나머지 pending을 닫는다.

### API·오류·호환성

승인된 계획과 팀 간 API 합의의 wire 이름은 다음과 같다. 로컬 구현되었으며 전체 검사·독립 리뷰는 진행 중이다. `report` 최상위 선택 입력 `check_replies: [{check_id, answer}]`, pending 요청만 담는 추가 응답 필드 `checks`, 전체 이력을 담는 `get_run`의 추가 `checks`다. 첫 report가 새 run을 저장하면서 누락 요청을 만들 수 있다. 비어 있지 않은 응답 목록에는 기존 `run_id`가 필요하다. `patch`와 기존 필수 입력·응답 필드를 유지한다. [공용 계약](../../shared/contract.ts), MCP 스키마·도구 설명·서버 instructions와 [README](../../README.md)에 반영했다.

기존 strict 검증을 유지한다. 응답 ID·설명은 앞뒤 공백을 제거한 뒤 검증·저장·비교한다. 알 수 없는 키, 잘못된 배열·항목·필드 타입, 빈 ID·설명은 입력 오류다. 없는 request ID와 다른 run의 request ID는 현재 run의 유효 요청이 아니라는 오류로 거부한다. 같은 프로젝트의 다른 run도 별도 범위다. 이미 answered인 ID에 **동일한 저장 설명**을 재전송하면 멱등 성공하며 응답·기준 시각을 다시 갱신하지 않는다. 다른 설명은 충돌 오류다. 한 보고 안에서 동일 ID·동일 설명 중복은 한 번 처리하고 설명이 충돌하면 전체를 거부한다. lifecycle로 closed된 요청에 새 응답을 보내면 종료 오류이며, 과거 answered 응답의 동일 재전송은 run 종료 후에도 멱등 성공이다. 런타임 오류는 run_id 없는 응답의 `check_replies require run_id`, 없는/교차 run ID의 `unknown check_id for run`, 배치 설명 충돌의 `conflicting check_replies for check_id: <id>`, 종료 요청의 `check is closed`, 기존 답변 충돌의 `conflicting answer for check_id: <id>`다. 교차 프로젝트는 기존 `run_id belongs to a different project` 검증을 유지한다. 공백·타입·unknown key는 strict 스키마로 거부한다.

요청 검증·생성·응답·종료·기준 갱신은 기존 report 저장과 같은 SQLite 트랜잭션으로 처리한다. 잘못된 응답이 하나라도 있으면 진행 patch, 프로젝트·run 생성/수정, 문서 baseline, ask 종료와 체크인 변경이 모두 롤백되어야 한다. 재시작 후에도 pending ID·설명·상태·기준 시각을 유지하고 같은 요청을 중복 생성하지 않는다.

기존 클라이언트에는 새 필수 입력이 없고 model·effort를 생략하거나 응답하지 않아도 정상 보고를 계속 허용한다. 누락 자체를 입력 오류로 거부하지 않으며 잘못된 타입은 기존 strict 검증으로 거부한다. 이 경우 pending 요청이 유지된다. 도구 설명·instructions와 README는 새 응답 필드를 읽고 명시적으로 설명·관찰한 model·effort를 보내거나 확인 불가 이유를 설명하도록 클라이언트/스킬 적응이 필요함을 알린다. 호스트나 기존 외부 스킬이 자동으로 준수한다고 약속하지 않는다. 이번 범위에서는 외부·전역 스킬, hook, daemon, 선제 깨우기, 수동 생성 API·UI, 신규 의존성을 추가하지 않는다.

### 완료·테스트 기준

1. model·effort가 있는 같은 run의 A가 진행중인 동안 B의 반복 보고와 최상위 summary 변경이 A의 임계시간을 미루지 않는다. 경계 전에는 0건, 경계 이상인 다음 report에는 A 요청 1건이며 조회·무보고 시간 경과로는 생성되지 않는다.
2. 동일 task/TODO 값 반복과 title·after·lane·model·effort만의 변경은 시간을 유지하고 실제 note·TODO 변경은 초기화한다. 기존 데이터의 첫 관찰은 정체 기준만 저장하며 누락 검사는 즉시 한다. 의미 있는 변경이나 model·effort 보충이 있어도 pending은 명시 응답 전까지 반복 노출된다(lifecycle 종료 예외).
3. pending 반복 전달·전체 이력 get_run 조회는 응답 상태를 바꾸지 않는다. 유효한 설명 수락은 pending을 제거하고 쿨다운을 재설정하되 작업 완료·건강 상태를 만들지 않는다. 동일 replay는 시간도 변경하지 않는다.
4. 빈 값·알 수 없는 필드·없는 ID·교차 run ID·충돌 replay·closed 요청 응답을 포함한 보고는 오류이며 동반 patch·ask 종료를 포함한 저장 전체가 이전 상태를 유지한다. 동일 설명 중복은 한 번만 적용된다.
5. task 완료·중단·대기중 전환·owner 변경 및 run 종료로 해당 pending이 닫힌다. 종료 이력 조회·서버 재시작은 새 요청을 만들지 않는다. 종료 후 answered의 동일 replay와 closed의 새 응답을 구분한다. run을 다시 열면 기준 시각을 새로 잡고 과거 closed ID는 재사용하지 않는다.
6. SQLite 재오픈 후 같은 요청 ID·기준 시각·응답 이력이 유지된다. 같은 프로젝트의 병렬 run과 서로 다른 task의 요청·응답·쿨다운은 격리된다.
7. 새 입력 없이 기존 report가 성공하고 기존 state 병합·ask 계약을 보존한다. 추가 응답 필드와 도구 설명/README가 일치한다. 자동 클라이언트 대응이나 실제 호스트 적응을 검증한 것으로 간주하지 않는다.
8. 진행중 task의 model만 누락·effort만 누락·둘 다 누락·빈 문자열·공백뿐인 값은 첫 report부터 해당 필드를 명시한 질문 한 건을 만든다. 정체와 누락이 동시에 충족되면 하나의 질문이 두 사유를 묻는다. 대기·완료·중단 작업에는 누락 요청을 만들지 않는다.
9. 관찰한 값을 patch로 보충하고 설명을 명시적으로 보내는 흐름과 실제 확인 불가 이유만 답하는 흐름을 모두 허용한다. 여전히 누락된 값이 있어도 수락 직후에는 재요청하지 않고 STALE_MS 경계에서만 새 요청을 허용한다. 동일 replay는 이 시간을 미루지 않으며 재시작 후에도 결과가 같다. 설명 없이 model·effort만 보충하면 기존 pending ID·question이 유지된다. note·TODO 변경은 누락 쿨다운을 미루거나 우회하지 않는다. 동일 owner 재개는 최근 쿨다운을 보존하고 owner 변경은 새 담당자의 누락 요청을 즉시 허용한다. 같은 report의 이전 owner 응답 수락과 새 owner 변경에서도 이전 응답 이력을 보존하면서 새 owner 누락 요청을 즉시 만든다. 누락 안내는 질문 생성 당시 누락된 필드가 있을 때만 포함하며, 생성 후 추가 누락으로 기존 pending 질문을 다시 쓰지 않는다.
10. 정체/누락 생성 질문에 당시 미완료 TODO id·text와 최신 TODO 확인 안내가 들어간다. 완료 TODO는 미완료 목록에 넣지 않는다. 이후 TODO 추가는 pending ID·question을 바꾸지 않으며 최신 목록은 get_run으로 읽는다. metadata가 있고 정상 진행 중인 작업은 남은 TODO만으로 즉시 요청을 만들지 않는다. 실제 해결 후 TODO 완료 patch와 설명을 함께 보내는 흐름, 미완료 TODO를 남긴 task/명시·자동 run 성공 종료 거부와 저장 롤백을 검증한다.

### 체크인 문구와 표시 순서

새 체크인 질문은 한국어 한두 줄로 생성한다. 정체 조건이면 “30분째 변화 없음”을 표시하고 누락 필드·미완료 TODO 안내는 해당 항목이 있을 때만 덧붙인다. 실제 값 확인·추측 금지와 최신 TODO 확인·실제 완료 항목만 보고하는 지침은 유지한다. 이미 저장된 pending 질문은 변경하지 않는다. report와 get_run 응답은 가독성을 위해 checks·asks를 state 앞에 조립하지만 JSON 키 순서를 동작 계약으로 사용하지 않는다. 생성 조건·쿨다운·회신 수명주기·화면은 변경하지 않는다.
