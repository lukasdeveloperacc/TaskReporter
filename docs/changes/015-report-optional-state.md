# report 전체 상태 응답 선택

상태: 완료 (로컬 검증, 배포 전)

반복 보고의 응답 크기를 줄이기 위해 report에 선택적 boolean include_state를 추가한다. false일 때 state만 생략하며 나머지 필드는 유지한다. 미지정/true 기본 동작은 유지한다. get_run에 전체 state를 추가하고 기존 조회 필드를 보존한다. [결재·실행 요구사항](../requirements/decisions-integration.md#report-상태-조회)에 계약을 기록한다.

범위: 공유 타입·MCP 입력/출력 스키마·응답 조립·테스트·README. DB 변경·기본값 전환·외부 스킬·이미지 배포는 제외한다.

검증 기준: false/true/미지정 응답, strict boolean 검증, asks/checks 유지, 전체 상태 조회, 스키마 감지, 전체 테스트·타입 검사·빌드.

검증 결과: 전체 테스트 18개 파일·215개 통과, npm run typecheck·npm run build·git diff --check 통과. MCP 통합 테스트로 opt-in 생략(text/structuredContent), true/기본 동작, asks/checks 보존·전체 state 일치·잘못된 타입 거부·스키마를 확인했다. 실제 호스트 스킬·이미지 배포는 미검증이다.
