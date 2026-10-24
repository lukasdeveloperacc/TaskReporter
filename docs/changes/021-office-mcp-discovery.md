# 021 — Office MCP 탐색과 완료 작업 표시

상태: 완료

## 이유와 확정 범위

보고 클라이언트가 실행을 만들거나 재개하기 전에 실제 사무실의 부서·owner 규칙과 프로젝트별 진행 중 실행을 확인하고, 보고 후 배정 결과를 점검할 수 있게 한다. 작업 중인 직원과 최근 완료한 직원을 구분하면서 완료 작업도 사무실에서 확인할 수 있게 한다.

- 기존 역할 레지스트리를 내용 변경 없이 `shared/roles.json`으로 옮기고 서버와 웹이 같은 owner 해석·직원 배정을 사용한다.
- 읽기 전용 `get_office_rules({})`, `get_active_runs({ project_path })`를 추가한다. 프로젝트 경로는 절대 경로이며 다른 프로젝트·종료한 실행은 목록에서 제외한다. 기존 실행 재개나 다른 실행 종료는 자동 수행하지 않는다.
- `report`는 병합 후 요청에 포함된 task ID의 `placements`, `get_run`은 모든 task의 `placements`를 반환한다. 이는 데이터에서 계산한 부서 배정이며 브라우저 렌더링이나 실제 좌표를 입증하지 않는다.
- 현재 작업과 최근 완료 작업을 별도로 보관한다. 현재 작업이 없을 때 최근 완료 제목을 작게 표시하고, 종료한 직원을 포함해 접근 가능한 상세에서 전체 제목을 확인한다.
- README와 관련 요구사항·구조 문서에 탐색 후 신규/재개 판단, fallback 확인, 외부 연동 스킬 권고를 기록한다.

## 제외 범위

DB 마이그레이션, 역할 규칙 변경, 자동 owner 재작성, 자동 실행 재개·형제 실행 종료, 사무실 크기·스크롤 정책 변경, 외부 PersonalAgentPlugins 소스·설치 캐시 수정은 포함하지 않는다. [020 인터뷰 기록](020-office-mcp-user-interview.md)은 당시 조사 결과로 보존한다. 디자인 원칙은 변경하지 않는다.

## 관련 문서

- [실행·클라이언트 연결](../../README.md)
- [시스템 구조](../1-SYSTEM-ARCHITECTURE.md)
- [진행 보고와 사무실 요구사항](../requirements/progress-office.md)
- [결재와 basic-team 연동](../requirements/decisions-integration.md)

## 완료·검증 기준

- MCP 도구 목록에 두 탐색 도구와 읽기 전용 표기가 있고, 엄격한 입력 검증을 적용한다.
- exact/prefix owner, plan lane 우선, unknown fallback, 빈 owner 미배정 결과가 서버와 웹에서 일치한다. 같은 owner의 여러 task는 병합된 전체 상태에서 계산한 실제 직원 배정을 사용한다.
- `include_state:false`에서도 placements를 반환하고 `get_run`은 상태를 바꾸지 않는다.
- 실행 탐색은 정규화된 절대 프로젝트 경로로 격리하고 종료 실행을 제외한다. 최근 보고 시각 내림차순·ID 순으로 결정하며 독립 실행 둘을 바꾸지 않는다.
- 현재 작업이 최근 완료보다 우선한다. 완료 시각이 유효한 항목을 우선하고 동률은 task ID로 결정한다. 잘못되거나 없는 시각, 빈 제목을 처리하며 idle·종료 직원은 typing으로 표시하지 않는다.
- 한국어·라이트 화면 1185×800, 1511×800에서 진행 직원, 이전 완료가 있는 idle 직원, 종료 직원, unknown owner, 동시 실행 둘을 확인한다. 종료 직원 상세도 마우스·키보드로 접근한다.
- 관련 테스트 후 전체 `npm test`, `npm run typecheck`, `npm run build`, `npm run golden`을 통과한다. live 4780 데이터는 검증에 사용하거나 변경하지 않는다.
- 독립 Backend·Karpathy·Ponytail·Impeccable·E2E 검토에서 최종 동일 revision을 확인한다.

## 구현·검증 결과

2026-10-24 로컬 구현과 전체 자동 검사를 완료했다. 공용 레지스트리·resolver, 읽기 전용 탐색 도구 둘, report/get_run placements를 반영했다. 절대 경로는 report와 동일하게 `isAbsolute`로 검사하고 `resolve`로 정규화하며 파일 존재나 symlink realpath 조건을 추가하지 않았다. 최근 완료 작업은 현재 진행 task와 분리하고, 현재 업무가 없을 때 짧은 완료 제목을 표시한다. 종료 직원도 클릭·키보드로 상세를 열고 `업무 기록` 탭에서 전체 제목을 확인한다. 이름·모델·effort, 방 크기·스크롤 정책은 유지한다. 외부 스킬은 적용 권고만 문서화했으며 소스·설치 캐시를 수정하지 않았다.

root가 구현 담당자 편집 종료 후 수행한 전체 로그를 직접 확인했다.

| 검사 | 실제 결과 | 전체 로그 |
| --- | --- | --- |
| `npm test` | 19개 파일·253개 테스트 통과 | [test](../../.omx/reports/office-feedback-20261024/full-test.log) |
| `npm run typecheck` | 종료 코드 0, TypeScript 오류 없음 | [typecheck](../../.omx/reports/office-feedback-20261024/full-typecheck.log) |
| `npm run build` | 종료 코드 0, Vite production build 완료 | [build](../../.omx/reports/office-feedback-20261024/full-build.log) |
| `npm run golden` | 설치된 원본 progress.py와 committed fixture 일치 PASS | [golden](../../.omx/reports/office-feedback-20261024/full-golden.log) |

문서 자체 검사는 로컬 링크·헤딩, diff whitespace, 020 SHA256 보존과 기존 역할 레지스트리 바이트 보존을 확인한다. [문서 검사 증거](../../.omx/reports/office-feedback-20261024/docs-checks.txt)와 [상세 결과](../../.omx/reports/office-feedback-20261024/docs-executor.md)에 기록했다.

이후 동결 revision의 독립 Backend·Karpathy·Ponytail·Impeccable·E2E 및 브라우저 matrix 검증을 마쳤다. 최종 판정은 root가 관리하는 [.omx/reports/office-feedback-20261024](../../.omx/reports/office-feedback-20261024/) 실행 증거를 따른다. 후속 [023](023-office-mcp-client-coordination.md)에서 첫 생성 응답과 표시를 보완하고 전체 자동 검사·브라우저 확인을 다시 수행했다. 자동 검사와 로컬 화면 검증은 배포된 latest 반영이나 실제 클라이언트의 자동 적응을 뜻하지 않는다.
