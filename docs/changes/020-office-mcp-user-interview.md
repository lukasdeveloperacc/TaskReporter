# Office MCP 실사용 인터뷰와 개선 후보

상태: 완료 — 2026-10-24 실제 사용 pane 인터뷰와 저장 기록 대조를 마쳤다. 반영 범위는 조사 문서이며 MCP·UI·스킬 개선 후보는 미구현이다.

## 목적과 범위

사용자가 지정한 Orca tab `c5273d29-9433-42b9-baed-75bd9624636c` / leaf `91b5c66d-8513-4722-bd85-8e44dd89d129`의 실제 작업 에이전트를 인터뷰한다. 해당 pane은 SmartStoreToolkit의 등록 화면 개선을 수행했다. Office 도구의 장점·실패 사례를 저장 데이터 및 현재 코드와 대조하고, 제품 수정과 스킬 안내 수정의 책임을 구분한다.

기존 실행의 상태·회고 수정, 다른 프로젝트 코드 수정, 전역 스킬 설치본 변경은 제외한다. 관련 기준은 [진행 보고](../requirements/progress-office.md), [결재·체크인](../requirements/decisions-integration.md), [회고](017-run-retro.md), [TODO 진척](019-todo-progress-nudge.md)이다.

## 근거와 해석 범위

- 인터뷰 대상 runtime handle: `term_c6d7cd77-3a73-45eb-b568-10f6ca38a18e`. 사용자 지정 tab/leaf와 inventory의 일치를 확인했다.
- Office run: `e48b6368-2635-49c7-95dc-9b74db4d1e2a`. `get_run`으로 상태를 읽었으며 2026-10-23T16:28:46.144Z에 종료됐다.
- 프로젝트: `/Users/chaejin/orca/workspaces/SmartStoreToolkit/refactoring`.
- 현장 근거: 위 프로젝트의 `.omx/reports/simple-registration-20261023/office-seats-correction.md`, `retro.json`, `backend-lead.md`, `frontend-lead.md`, `docs-lead.md`.
- 도구 근거: 읽기 전용 `get_run`, 같은 project_path 및 `since:2026-10-23T00:00:00Z`로 제한한 `get_retros`. 다른 프로젝트 스냅샷은 수집하지 않았다.
- 코드 대조 기준: TaskReporter `158ed39`. 당시 배포 화면과 현재 소스의 차이를 아래에 별도 기록한다.
- 인터뷰 질문 `msg_492e53ea71bd`, 회신 `msg_6a69809e814f` (2026-10-24T06:18:39Z), 같은 thread로 수신했다. 송신자의 runtime handle이 지정 pane과 일치한다.

한 pane의 경험이며, 다른 실행은 같은 프로젝트의 회고 1건만 보조 근거로 사용한다. 반복 빈도와 모든 클라이언트의 안정성을 일반화하지 않는다.

## 인터뷰 답변과 대조

| 질문 | 실제 사용자의 답변 | 대조 결과 |
| --- | --- | --- |
| 무엇이 도움이 됐나 | report/get_run과 같은 task·TODO ID 병합으로 병렬 작업을 추적. root는 run 공통 상태, leads는 자기 팀 카드를 보고. 중요 정정 뒤 readback | 저장된 38개 카드·결정·리뷰·회고와 부합. 당시 모든 report 원문을 복구한 것은 아님 |
| 어디서 잘못했나 | reviewer 내부 `review-*`와 `root-verification` owner를 써 잘못 배치. 저장된 제목 정정을 화면 반영처럼 설명해 사용자가 재차 지적 | 현장 정정 문서와 회고 두 항목이 뒷받침. 실제 owner를 같은 task ID에 수정해 최종 기록 보존 |
| 완료 제목 문제의 조건은 | 진행중 task가 없는 완료 actor에서 제목이 사라짐. 기대는 현재 업무와 마지막 완료 업무를 실제 상태와 함께 보여주는 것 | 당시 배포 JS 조사 기록 및 현재 buildOffice 코드와 부합. 현재 UI 재현을 새로 수행한 것은 아님 |
| 반복 작업은 | lead 결과의 TODO를 root가 옮기는 작업, 같은 actor의 여러 카드에 확인된 모델·effort를 반영하는 작업 | 반복 비용은 자기 보고이며 호출 횟수·시간을 측정하지 않음. task가 actor·설정·배치를 겸하기 때문이라는 해석은 가설 |
| ask·회고는 | 실제 결정이 없어 ask를 호출하지 않음. 사용자 정정 두 사건을 retro로 제출 | 저장 asks는 0개. ask 대기·재개 품질은 이 인터뷰에서 평가할 수 없음. 회고 2항목과 일치 |
| 스킬에 지침이 없었나 | 현재 references에는 owner·관측 모델·readback·TODO·ask 미검증 구분이 상당수 이미 있음. 당시 설치본과 같았다고 단정할 수 없음 | 현재 설치본을 직접 읽어 확인. 해당 run의 skill_version은 `0.1.0`만 있어 사건 당시 commit 식별이 제한됨 |

인터뷰 대상은 title 재전송으로 UI 문제를 해결할 수 없으며, 완료를 진행중으로 위장하거나 가짜 task를 추가하지 않았다고 설명했다. 코드 결함과 Office 기록의 성공을 구별한 점은 유지할 원칙이다.

## 확인된 장점

| 관찰 | 근거 | 판단의 한계 |
| --- | --- | --- |
| 진행·리뷰·회고를 한 실행으로 보존했다 | 작업 카드 38개, 리뷰 2라운드, 회고 2항목이 get_run에 남음 | 실제 제품 품질을 Office가 보증하는 것은 아님 |
| 체크인에 실제 상태·막힌 점·다음 행동을 응답했다 | 13개 모두 answered, 무응답 종료 0, 평균 응답 31.702초 | 평균은 이 실행의 저장 시각 차이이며 도구 자체 지연이 아님 |
| TODO와 종료 시점을 수치로 돌아볼 수 있다 | get_retros: 완료 tick 172개, task 완료 patch와 동시에 tick 54개 | 54개는 run 최종 보고에 몰렸다는 뜻이 아니며 정상 task 마무리도 포함 |
| 회고가 사용자 정정을 구체적으로 남겼다 | owner 배치 오류·완료 제목 미표시가 별도 evidence/suggestion으로 저장됨 | category가 같은 서로 다른 문제를 동일 원인으로 합치면 안 됨 |

`get_retros.candidate:true`는 같은 skill+category가 서로 다른 2개 run에 있다는 의미다. 이 사례에서 다른 run의 문제는 동일 경로의 동시 실행 노출이었다. owner 오류가 2번 반복됐다는 증거로 사용하지 않는다. 현재 집계 구현은 [server/app.ts](../../server/app.ts)의 `getRetros`를 따른다.

## 개선 후보 — 미반영

| 우선순위 | 대상 | 문제와 근거 | 가장 작은 개선 및 완료 기준 |
| --- | --- | --- | --- |
| P1 | MCP 조회·보고 | native actor 이름을 owner로 보내도 저장 성공하므로 임시 자리 배치를 사후에 발견함 | 배포된 owner 규칙을 읽기 전용으로 조회하거나 기존 get_run에 계산된 부서·fallback 경고를 제공. report 성공과 배치 경고를 분리하고 unknown owner를 거부하지 않음. exact reviewer·plan lane·unknown fallback을 화면과 같은 resolver로 검증 |
| P1 | Office UI | 완료 작업은 actor.task에서 제외되어 업무 제목을 잃음 | 진행 작업과 마지막 완료 작업을 구분해 조회 가능하게 표시. 여러 완료 카드의 선택 기준을 finished 시각과 안정적인 동률 기준으로 명시하고 완료 상태를 유지. 현재 작업·이력 모두 없는 경우도 검증 |
| P1 | MCP 조회·동시 실행 UI | 같은 project_path의 새 run이 기존 층의 대표 노출을 바꿀 수 있음. 별도 run 회고 `3bc856b3-d971-41a6-9fd5-eb1af32947c5` | 실제 project_path를 유지하면서 활성 run 목록을 조회하고 실행 링크·선택을 안내. 기존 run_id 재개와 독립 신규 실행을 구분. 경로를 조작해 가짜 프로젝트를 만드는 안내는 피함. 같은 경로 2개 활성 run의 독립 보고·선택 검증 |
| P2 | 회고 해석 | candidate가 같은 category의 서로 다른 문제도 묶음 | 우선 스킬에서 각 evidence를 읽고 동일 원인인지 분류하도록 설명. 자동 원인 군집·추가 분류 필드는 반복 표본이 쌓인 뒤 검토 |
| P2 | TODO 보고 습관 | task 종료와 함께 tick한 항목 54/172개 | 실제 검증을 끝낸 checkpoint에서 끝낸 TODO만 반영. 숫자만으로 지연 보고를 단정하거나 서버 알림 빈도를 높이지 않음 |

에이전트가 제안한 필드별 오류와 advertised schema 안내는 현재 [server/app.ts](../../server/app.ts)의 strict schema·필드 설명에 이미 상당 부분 구현돼 있다. 실제 부족한 오류 사례를 더 확보하기 전 새 검증 API나 종료 전 일괄 검증 도구를 추가하지 않는다. 변경 필드만 보내는 patch와 `include_state:false`도 기존 기능이다.

actor 설정을 task에서 완전히 분리하는 계약은 반복 비용을 줄일 가능성이 있지만 이번 표본만으로는 우선 도입하지 않는다. 먼저 lead가 이미 보고한 TODO를 root가 중복 보고하지 않도록 기존 `Office 반영함/미반영` 인계를 활용하고, 남는 반복 비용을 측정한다.

현재 [office.ts](../../web/src/office.ts)의 buildOffice는 진행중 카드만 task로 연결한다. 또한 `158ed39`의 [Office.tsx](../../web/src/Office.tsx)는 밀집 문제 해결을 위해 말풍선을 이름·상태·TODO로 축약했고, task 제목은 있을 때 hover title에 넣는다. 따라서 당시의 “완료만 제목 누락”과 현재의 “기본 말풍선은 compact”를 같은 재현 조건으로 취급하면 안 된다. 후속 UI 개선은 compact 배치를 유지하면서 상세·이력의 접근성을 확보해야 한다.

## 스킬 수정 후보 — 미반영

대상 원본 저장소는 `/Users/chaejin/orca/PersonalAgentPlugins/skills/basic-team/`이다. 설치 캐시를 직접 수정하지 않는다.

| 파일 | 이미 있는 지침 | 필요한 보강 |
| --- | --- | --- |
| `references/office-operations.md` | native actor와 owner 분리, exact reviewer labels, API 저장과 화면 확인 분리 | 이미 있는 내용을 중복 추가하지 않고 최초 actor 게시 체크리스트·lead brief에서 해당 절로 연결. 완료 업무 제목의 당시 제한과 현재 compact UI를 구별 |
| `references/briefs.md` | 카드 ID·owner·실제 모델·TODO 인계, 끝낸 TODO 및 스킬 마찰 보고 | 최초 카드의 owner 매핑과 API/화면 확인 수준을 한 줄로 반환하도록 보강. 매 report마다 브라우저 확인을 요구하지 않음 |
| `references/reporting.md` | 동일 run_id 재개, include_state:false, 읽기는 get_run, 실제 시점 TODO tick | 신규 run 생성 전 같은 실제 경로의 활성 run 확인·독립 업무면 별도 run 링크 안내. 동일 경로라고 기존 실행을 자동 재사용하거나 중단하지 않음 |
| `references/reporting.md` Retro 절 | 최대 3개 구체적인 문제, skill_version 기록 | get_retros의 candidate는 검토 후보일 뿐 동일 원인 반복 확정이 아님을 명시. 설치 commit을 읽을 수 있으면 버전만 쓰지 않고 함께 기록 |

현재 설치본에는 owner·화면 검증 지침이 이미 있다. 따라서 두 사건을 곧바로 “스킬에 규칙이 없음”으로 판정하지 않는다. 당시 사용본·실제 체크포인트 이행·도구에서 규칙을 찾는 비용을 추가로 구별해야 한다.

인터뷰 전달 중 Office와 별개인 Orca `no_active_sender_terminal` 오류가 한 번 있었다. 대상 에이전트는 자기 CODEX_THREAD_ID와 terminal inventory를 대조하고 확인된 자기 handle을 명시해 회신했다. orchestration 스킬 개선 후보는 이 오류에서 자기 pane 식별 확인 후 명시 sender를 사용하는 복구와, 확인할 수 없으면 기존 pane 출력으로 회신하는 대안을 짧게 연결하는 것이다. 이 사건을 Office MCP의 실패 횟수로 집계하지 않는다. 별도 orchestration 스킬 원본은 이번에 수정하지 않았다.

## 검증 결과와 후속 구현 기준

- 지정 pane의 직접 회신을 수신했고, 현장 근거 파일 및 읽기 전용 get_run/get_retros와 대조했다. 질문·회신 ID로 추적할 수 있다.
- 문서 상대 링크와 diff 공백 검사를 수행했다. 코드·설정·스킬·실행 상태는 변경하지 않았으며 코드 테스트는 재실행하지 않았다.
- 현재 화면을 새로 재현하지 않았고, 당시 호출 전체 원문·소요 시간도 복구하지 않았다. ask는 실사용되지 않았다. 이 한계를 현재 기능의 성공·실패로 확대하지 않는다.
- 후속 제품 구현에서는 app의 MCP 계약 테스트, owner resolver·완료 업무 선택 테스트, 같은 경로 2개 활성 run 선택 및 실제 두 폭 브라우저 관찰을 수행한다. 조사 문서만으로 이를 통과했다고 주장하지 않는다.
