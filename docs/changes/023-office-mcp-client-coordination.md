# 023 — Office MCP 실행 구분과 스킬 연동

상태: 완료

## 이유와 범위

[020](020-office-mcp-user-interview.md)·[022](022-office-mcp-second-interview.md)의 실사용 피드백을 반영하고 [021](021-office-mcp-discovery.md)의 로컬 구현을 검증·커밋·푸시한다. PersonalAgentPlugins의 지정 Orca pane은 스킬 원본의 탐색·배정 확인·추가 요구 보고 절차를 맡고 각각의 저장소에서 검증·커밋·푸시한다.

- 첫 report 응답에 같은 프로젝트의 진행 중 `active_runs` 요약을 선택 필드로 제공한다. 이후 보고에는 생략하며, 조회는 `get_active_runs`를 사용한다. 최초 쓰기 전 탐색을 대체하지 않는다.
- `get_run`에 저장된 `last_report_at`을 제공한다. 조회는 시각·상태를 변경하지 않는다.
- 선택한 실행 이름·ID, 같은 프로젝트의 병렬 실행 수를 표시하고 보고 갱신으로 선택을 바꾸지 않는다.
- 직원 상세에서 임시 배정 이유와 마지막 보고를 설명하고 사용자 아바타를 작업자와 구분한다. 상태는 보고된 작업 기준이며 실제 agent 생존을 추측하지 않는다.

독립 run 유지, 실제 프로젝트 경로 유지, unknown owner 원문 보존, 자동 owner 수정·형제 run 종료 금지를 유지한다. DB 변경·새 의존성·제품 배포는 포함하지 않는다. 외부 스킬은 상대 pane의 소유이며 이 저장소에서 캐시를 수정하지 않는다.

## 검증 기준

실제 MCP transport 테스트로 같은 경로의 독립 실행 두 개, 종료 실행·타 프로젝트 제외, 재개·include_state:false, readonly 시각을 검증한다. UI 테스트로 동일 제목의 실행 구분과 SSE 후 선택 유지, fallback과 plan 우선, 아바타 설명을 확인한다. 전체 test·typecheck·build·golden, 실제 브라우저 확인 후 결과와 각 저장소 commit을 기록한다.

## 구현·검증 결과

위 범위를 구현했다. 기존 진행 run을 갱신할 때 active_runs는 생략하고 첫 생성 응답만 제공한다. 새 필수 입력은 없다. 배정과 최근 완료 표시를 위한 공용 resolver를 서버와 UI가 함께 사용하며, 기존 owner 규칙은 바꾸지 않았다.

- `npm test`: 19개 파일·258개 테스트 PASS. 신규 회귀는 실제 MCP transport의 병렬 run 보존·종료/다른 프로젝트 제외·기존 run 재개·조회 시각 불변과 UI의 동일 제목/SSE 선택 유지·fallback/plan 우선을 포함한다.
- `npm run typecheck`, `npm run build`, `npm run golden`: 모두 종료 코드 0. lint 스크립트는 이 저장소에 없다.
- 브라우저: 합성 데이터의 별도 SQLite·localhost:4781로 390·1185·1511×800 화면을 확인했다. 세 크기에서 실행 이름·ID와 아바타 설명, 두 데스크톱 크기에서 fallback 업무 상세와 마지막 보고 문구를 확인했다. 문서 너비가 viewport를 넘지 않았다. 기존 live 4780과 실제 작업 데이터는 변경하지 않았다.
- Impeccable detector 결과 `[]`, diff whitespace와 변경 문서의 로컬 링크 검사 PASS.

새 검증 증거는 [.omx/reports/office-coordination-20261024](../../.omx/reports/office-coordination-20261024/)의 `test.log`, `typecheck.log`, `build.log`, `golden.log`, `browser.json`, `summary-*.png`, `unknown-*.png`, `design-detect.json`이다. 로컬 증거는 Git 추적되지 않는다. 021의 기존 동결 revision 검토와 이번 보완의 검증을 구분한다.

## 스킬 협업 결과

사용자가 지정한 `8c4c9822-2503-4c38-a6db-830c2776ad1e:484dc3c8-b9c9-4f6a-97a6-d9e85009bd06`은 실제 `term_e8cdc03f-ebeb-4c7d-aecf-2b6599093c34`로 확인했다. Orca 질문 `msg_994f7d743ebf`와 후속 계약 `msg_7dcebe83ed1c`로 파일 소유권·MCP 계약을 맞췄다. 기존 사용자 pane은 유지한다.

PersonalAgentPlugins의 `skills/basic-team/SKILL.md` 및 `references/{reporting,office-operations,briefs}.md`에 지원 도구 탐색·신규/재개 판단·placements 확인·정식 reviewer owner·추가 요구 시 기존 작업 지속 여부·새 카드 실제 설정 재확인을 반영했다. 상대 pane은 형식 검사, 링크 15개, 독립 6개 시나리오 검토 PASS를 회신했다. 제품 담당은 원본 reporting/office-operations의 계약을 읽어 자기 포함 목록과 자기 제외 sibling 처리, optional 필드·시각 의미가 일치함을 확인했다.

스킬 커밋은 [e33db0b](https://github.com/lukasdeveloperacc/PersonalAgentPlugins/commit/e33db0b7d3a48989be01c8ba6114b06379fc0158), 최종 [cb35741](https://github.com/lukasdeveloperacc/PersonalAgentPlugins/commit/cb357417c807027e6967aad1af43013272882ce9)이다. `git ls-remote origin refs/heads/main`으로 최종 SHA의 원격 반영도 확인했다. 설치 캐시·전역 설정은 수정하지 않았다. 실제 호스트가 변경 스킬을 읽는 것은 재로딩 이후이며 자동 갱신을 보장하지 않는다. 제품은 이 기록과 구현을 같은 커밋으로 전달한다. Docker 재배포는 이번 범위에 포함하지 않는다.
