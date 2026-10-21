# 008 — Office MCP 입력 검증·상태 조회 개선

상태: 구현·자동 검증 완료. 로컬 커밋까지만 수행하며 배포는 이번 범위에 포함하지 않는다.

## 이유와 범위

basic-team의 잘못된 필드가 조용히 저장되는 문제를 막고, MCP 클라이언트가 HTTP 상태 API를 직접 호출하지 않고 실행 상태를 읽게 한다. report·ask의 최상위 인자와 report patch·task·decision·review에 타입과 허용 키 검증을 적용한다. 각 입력 필드 설명, stage 접두어·병합 키·owner 좌석 안내를 도구 설명과 서버 instructions에 제공한다. 기존 patch.title은 유지한다.

report 응답에 병합된 state와 ended_at을 추가하고 readOnlyHint를 선언한 get_run을 제공한다. get_run은 project_path·stage·ended_at·tasks·decisions·reviews·pending 질문을 반환한다. ask의 recommended는 options 안에 있어야 한다. model은 전체 모델 ID, effort는 host가 확인한 값만 보내며 모르면 생략한다. reviewer-*는 감사팀, plan-*는 회의실로 매칭하며 reviews만 있는 실행의 리뷰어 캐릭터도 검증한다.

HTML 원본 progress.py 파일은 수정하지 않는다. TypeScript 중첩 항목의 알 수 없는 키를 거부하면서 기존 정상 입력의 병합·시간·종료 규칙은 보존한다. 신규 의존성·스킬 수정·push·GHCR 배포는 제외한다.

## 관련 문서

- [보고·사무실 계약](../requirements/progress-office.md#mcp-입력-검증조회-개선)
- [결재와 실행 연동](../requirements/decisions-integration.md)
- [실행·검증 명령](../1-SYSTEM-ARCHITECTURE.md#개발과-검증)

## 구현 작업

- 공용 report 응답 타입, 타입이 있는 strict MCP 스키마와 필드 설명, 서버 instructions·report 설명, get_run 등록.
- TypeScript task·decision·review 허용 키 검증, ask 추천값 검증, 입력 오류 때 저장되지 않는지 확인.
- 역할 owner 매칭과 reviews만 있는 리뷰어 캐릭터 회귀 검사.
- README·요구사항과 실제 tools/list·예시 응답·거부 오류를 포함한 로컬 결과 artifact 갱신.

## 검증 기준과 결과

리더가 `npm test && npm run typecheck && npm run build && npm run golden` 전체 PASS를 확인했다. 테스트는 18개 파일·165개를 통과했다. SDK 실제 tools/list의 스키마·필드 설명·readOnlyHint와 get_run 응답, 오타 거부·거부 시 무변경을 확인했다. owner 좌석 매칭과 reviews만 있는 리뷰어 캐릭터도 자동 검사에 포함한다.

잘못된 타입과 알 수 없는 키는 이제 MCP SDK의 strict 입력 검증에서 먼저 거부되므로 기존 병합 단계의 오류 문구 대신 도구 입력 검증 오류가 반환된다. 정상 patch의 병합·시간·종료 규칙은 유지한다. golden 기대 JSON은 변경하지 않았다.

기존 golden 스크립트는 인자 없는 `npm run golden`에서 `$1` 미정의로 실패했다. 명시 인자·BASIC_TEAM_DIR를 우선하고 기본 skill 설치 경로를 탐색하도록 고쳤다. 설치본 예제와 저장소 예제가 달라지는 경우를 피하기 위해 설치본 progress.py에 저장소의 고정 progress-example.md를 재생하고 기대 JSON과 실제 assert 비교한다. 원본 파일 자체는 수정하지 않았다.

실제 Claude Code 클라이언트 재시작·호출과 새 브라우저 E2E는 이번 검사에 포함하지 않는다. SDK 호출과 역할 매칭 자동 검사는 이 검증을 대신하지 않는다. push하지 않아 GHCR 이미지는 갱신되지 않는다.
