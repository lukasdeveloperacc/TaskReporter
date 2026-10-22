# 데이터베이스

SQLite를 Node 24의 `node:sqlite`로 사용한다. 현재 스키마와 모든 쿼리의 기준은 [server/store.ts](../server/store.ts)다. 별도 마이그레이션 파일은 없으며 시작 시 `CREATE TABLE IF NOT EXISTS`로 초기화하고, 기존 projects 테이블에 hidden 열, runs 테이블에 retro_at 열이 없으면 추가한다.

| 엔티티 | 키·관계 | 주요 데이터 |
| --- | --- | --- |
| projects | `path` 기본 키 | 절대 프로젝트 경로, 표시 이름, workspace 포함 여부, 최초 생성 시각, 층 숨김 여부 |
| runs | UUID `id`, `project_path` → projects.path 외래 키 | JSON 진행 상태, 문서 경로·baseline, 마지막 보고 시각, 종료 시각 |
| asks | UUID `id`, `run_id` → runs.id 외래 키 | 질문·JSON 선택지·추천값, 상태, 답변, 생성 시각 |
| task_clocks | `(run_id, task_id)` 복합 기본 키, run_id → runs.id | nullable owner, 업무 진척 기준 `observed_at`, 별도 누락 쿨다운 기준 `replied_at`(nullable); 시각은 epoch ms |
| checks | UUID `id`, `run_id` → runs.id 외래 키 | task id·nullable owner 스냅샷, question·상태·답변, ISO 생성·응답 시각. run 회고 요청은 task id `__retro__` |
| retros | UUID `id`, `run_id` → runs.id 외래 키, `(skill, category, created_at)` 인덱스 | 스킬·버전 문자열, CHECK로 제한한 category, evidence·nullable suggestion, ISO 제출 시각 |

외래 키 검사를 켠다. ask·check 상태는 DB CHECK로 `pending`, `answered`, `closed`만 허용한다. 기본 키 외에 `checks_one_pending_task` 부분 UNIQUE 인덱스가 pending 행의 `(run_id, task_id)` 중복을 막는다. JSON 진행 상태의 병합·검증은 [server/progress.ts](../server/progress.ts), 입력·출력 타입은 [shared/contract.ts](../shared/contract.ts)가 담당한다. 전체 스키마를 문서에 중복하지 않는다.

report는 프로젝트 등록·run 저장·질문 종료를 한 트랜잭션으로 처리한다. 질문 답변은 pending인 행에만 조건부로 반영해 중복 답변을 막는다. 답변 완료 후 같은 ask_id를 재조회하면 저장된 답을 반환한다. HTTP 대기 연결과 파일 watcher는 메모리에 있고, 재시작 시 활성 run의 watcher를 다시 만든다.

체크인 영속화는 로컬 구현되었다. 전체 검사·독립 리뷰는 진행 중이다. 새 테이블·인덱스도 `CREATE ... IF NOT EXISTS`로 추가하며 기존 projects·runs·asks를 보존한다. 작업 스냅샷을 별도 직렬화하지 않고 이전 run.state의 병합된 작업과 현재 작업을 비교한다. `observed_at`은 업무 진척, `replied_at`은 현재 owner의 수락 응답 쿨다운을 나타내며 owner 변경 시 replied_at을 비운다. 요청·응답 이력은 checks에 남기고 같은 응답 replay는 시각을 바꾸지 않는다. 보고 저장과 체크인 처리는 같은 트랜잭션이며 잘못된 응답이 있으면 함께 롤백한다. [체크인 요구사항](requirements/decisions-integration.md#에이전트-체크인)과 [변경 010](changes/010-agent-check-ins.md)에서 최종 검증 상태를 확인한다.

## run 회고 저장

[run 회고 요구사항](requirements/decisions-integration.md#run-회고)에 따라 retros 행과 nullable `runs.retro_at`(마지막 제출 시각; null이면 미제출, 빈 배열 제출도 기록)을 저장한다. 재제출은 같은 트랜잭션에서 그 run의 행을 지우고 다시 넣는다. 서버 신호는 저장하지 않고 조회 시 runs·checks에서 계산한다. runs 삽입은 열 이름을 명시해 추가 열과 호환한다. 결과는 [변경 017](changes/017-run-retro.md)을 따른다.

## 보관·삭제 정책

완료·중단 run, 질문, 체크인 요청·응답 이력, 마지막 진행 스냅샷은 자동 삭제하지 않는다. task_clocks는 작업별 기준을 저장하는 운영 데이터이며 전체 patch 이벤트 이력이나 제품 리플레이는 저장하지 않는다. 문서 baseline과 질문·체크인 설명·답변은 DB에 포함되므로 named volume도 로컬 작업 데이터로 관리한다. Markdown 원본은 DB가 소유하지 않고 에디터와 읽기 전용 마운트에서 읽는다.

Compose의 `office-data` volume에 DB를 보관하며 컨테이너 재시작과 `docker compose down`으로 유지된다. `docker compose down -v`는 저장 데이터를 삭제한다. 앱 내 삭제 기능·자동 만료·백업 복구 기능은 현재 없다.

## 층 숨김 저장

[층 숨김 요구사항](requirements/progress-office.md#building-층-숨김복원)에 따라 `projects.hidden INTEGER NOT NULL DEFAULT 0`을 저장한다. 시작 시 `PRAGMA table_info`로 기존 열을 확인하고 없을 때만 추가하여 기존 DB를 보존한다. 새 프로젝트는 표시 상태이며 프로젝트 upsert 자체는 hidden을 보존하지만, 종료되지 않은 작업의 report 성공 시 같은 트랜잭션에서 hidden을 해제한다. 숨김은 표시 정책으로만 적용하고 run·ask·문서 연결과 상태 snapshot의 프로젝트는 삭제하거나 제외하지 않는다. 숨김 상태는 DB 재개방 후에도 유지한다. 실제 반영·검증 결과는 [변경 007](changes/007-floor-visibility.md)을 따른다.
