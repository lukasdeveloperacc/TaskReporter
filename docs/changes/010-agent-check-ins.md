# 010 — 정체·런타임 정보 누락 작업의 에이전트 체크인

상태: 진행 중. 로컬 구현되었으며 backend 대상 검사 4개 파일·65개 테스트와 typecheck·diff 검사를 통과했다. UI 대상 검사 4개 파일·80개 테스트와 typecheck·diff 검사도 통과했다. 전체 검사·독립 리뷰·브라우저 E2E·Impeccable 검토는 진행 중이다. 배포 이미지와 실제 호스트 적응은 검증하지 않았다.

## 이유와 범위

다른 작업의 보고로 가려지는 장시간 미변경 작업에 설명을 요청한다. run·task별 의미 있는 변경 기준을 SQLite에 저장하고 다음 `report`에서 기존 `STALE_MS` 이상을 감지한다. pending 요청은 명시적인 request ID·실제 설명 응답 전까지 반복 전달한다. 전달 자체는 응답이 아니며 설명은 작업 완료나 정상 작동 증명이 아니다.

진행중 작업의 model·effort가 누락되거나 공백뿐이면 같은 체크인으로 즉시 실제 관찰값을 묻는다. 정체도 해당하면 질문에 두 사유를 포함하고 run·task당 pending 하나를 유지한다. 클라이언트는 다음 patch에 관찰값을 보충하면서 명시적으로 답하거나, 확인 불가 이유를 설명하고 모르는 값은 생략한다. 요청된 설정이나 기본값을 사실로 꾸미지 않는다. 값 보충 자체는 업무 진척·응답이 아니다. 수락된 설명은 누락이 남아 있어도 STALE_MS 동안 재요청을 억제하고 동일 replay는 쿨다운을 연장하지 않는다. 누락 쿨다운은 업무 진척 시각과 별도로 수락 응답에 기반하며 note 변경으로 연장되지 않는다. 동일 owner 재개는 쿨다운을 보존하고 새 owner는 이전 담당자의 쿨다운 없이 누락 요청을 받을 수 있다. 모든 질문에 조건부 누락 안내를 넣어 pending 내용은 유지한다. 별도 스키마 필드나 요청 메커니즘은 추가하지 않는다.

추가 반영 범위: 미완료 TODO를 남긴 task 완료와 run 성공 종료를 거부한다. done 생략도 미완료이고 run의 명시·finish 자동 완료는 중단 task의 TODO까지 검사한다. 이미 완료된 task에 미완료 TODO를 추가해도 거부한다. run 중단은 비성공 종료로 허용하며 자동 체크하지 않는다. 정체/누락 체크인 질문에는 생성 당시 미완료 TODO id·text와 최신 TODO 확인 안내를 넣는다. 남은 TODO만으로 즉시 체크인을 만들지 않는다. 클라이언트는 실제 업무를 끝내고 TODO 완료를 보고해야 하며 새로운 스키마·취소 API·자유문자열 todo 파서는 추가하지 않는다. 상세는 [TODO 성공 종료 방지](../requirements/progress-office.md#미완료-todo의-성공-종료-방지)를 따른다.

추가 UI 반영 범위는 엘리베이터 클릭 시 대표가 걸어서 도착한 후 층 선택을 열고, 층/run 전환 때 전체/일반 보기 모드를 유지하는 것이다. 층별 이동·패널 상태는 정리하며 기존 실패·중단·키보드·모션 축소 규칙을 유지한다. [UI 요구사항](../requirements/progress-office.md#엘리베이터-클릭-이동과-보기-모드-유지)과 [사용자 흐름](../4-USERFLOW.md#직접-둘러보기)을 따른다. 디자인 변경이나 브라우저 저장소 영속화는 추가하지 않는다.

체크인 수동 UI·API, 타이머·daemon·hook·선제 깨우기, 새 의존성, 외부·전역 스킬 수정은 범위 밖이다. 기존 무응답 클라이언트의 보고는 계속 허용한다. 응답을 읽고 설명을 돌려보내려면 클라이언트/스킬 적응이 필요하며 호스트의 자동 대응을 보장하지 않는다.

## 관련 문서와 구현 작업

- [체크인 요구사항·API·오류·검증 기준](../requirements/decisions-integration.md#에이전트-체크인)
- [공용 계약](../../shared/contract.ts): 추가 선택 입력·추가 응답 타입. 기존 필수 입력과 task 병합 계약 보존.
- [저장소](../../server/store.ts): run별 작업 기준과 요청·응답의 영속성, pending 중복 방지, 종료·멱등 replay·충돌 처리.
- [MCP 서버](../../server/app.ts): report 트랜잭션에서 감지·검증·응답·종료, read-only get_run의 전체 요청 이력 노출, strict 스키마와 도구 설명·instructions.
- [README](../../README.md): 응답 처리와 클라이언트 적응 요구 안내. 외부 스킬 자체는 수정하지 않음.

## 검증 방법과 결과

검증 기준은 [요구사항의 완료·테스트 기준](../requirements/decisions-integration.md#완료테스트-기준)을 따른다. 임계시간 경계, task별 의미 변화, 반복 노출, 실제 설명·쿨다운, 오류 시 report 전체 롤백, 완료·중단·종료, 동일/충돌 replay, 기존 DB·서버 재시작, 같은 프로젝트 병렬 run 격리를 서버·저장소 회귀 테스트로 확인한다. 기존 클라이언트 계약과 typecheck·build도 검증한다.

추가 검증은 model·effort 각각/동시 누락·공백값의 즉시 질문, 정체와 결합된 한 질문, 실제 관찰값 보충·확인 불가 설명, 설명 없는 값 보충의 pending 유지, 누락 상태에서 응답 후 쿨다운·경계·replay·재시작, 기존 무응답 클라이언트의 정상 보고를 포함한다.

TODO 추가 검증은 task 완료의 미완료 false/생략 거부, 완료 task의 TODO 추가·해제 거부, 동시 TODO 완료 patch 허용, 명시/자동 run 완료와 중단 task 잔여 검사, 중단 허용·자동 체크 없음, 생성 질문의 잔여 목록·최신 확인 안내·pending 불변, 잔여만으로 즉시 요청하지 않음, 오류 시 report 전체 롤백을 포함한다. 외부 progress.py·기존 golden fixture는 수정하지 않는다.

UI 추가 검증은 클릭 후 이동·도착 전 창 닫힘·도착 후 열림, 이동 취소/실패/층 전환 시 늦은 창 열림 방지, 모션 축소, 전체/일반 보기 각각의 층·run 전환 유지와 층별 상태 정리를 포함한다. UI 변경은 데스크톱·390×844 실제 브라우저 E2E와 Impeccable 검토가 필요하며 아직 수행 전이다.

로컬 backend 검증은 `npx vitest run server/progress.test.ts server/store.test.ts server/app.test.ts shared/contract.test.ts`의 4개 파일·65개 테스트 PASS와 `npm run typecheck`, `git diff --check` PASS다. 근거는 로컬 `.omx/artifacts/agent-check-ins/targeted-checks-r2.log`와 `backend-leaf-result.md`다. 이 경로는 실행 증거이며 Git 추적·배포 포함을 보장하지 않는다. UI 대상 검사는 로컬 `frontend-motion-checks.log`에서 4개 파일·80개 테스트와 typecheck·diff PASS를 확인했다. 전체 test·build·golden, 독립 리뷰·브라우저 E2E·Impeccable 결과는 같은 실행 증거 디렉터리에 root가 보존하며 문서의 기존 결과와 구분한다. 문서 링크·JSON 예제·diff 검사 결과도 그 디렉터리의 `docs-final-result.md`에 둔다. 실행 식별자는 Office run `df7e2668-1f47-4138-83af-c397518116ac`다. 실제 호스트의 자동 응답·운영·배포 검증은 수행하지 않았다.
