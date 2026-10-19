# 데이터베이스

SQLite를 Node 24의 `node:sqlite`로 사용한다. 현재 스키마와 모든 쿼리의 기준은 [server/store.ts](../server/store.ts)다. 별도 마이그레이션 파일은 없으며 시작 시 `CREATE TABLE IF NOT EXISTS`로 초기화한다.

| 엔티티 | 키·관계 | 주요 데이터 |
| --- | --- | --- |
| projects | `path` 기본 키 | 절대 프로젝트 경로, 표시 이름, workspace 포함 여부, 최초 생성 시각 |
| runs | UUID `id`, `project_path` → projects.path 외래 키 | JSON 진행 상태, 문서 경로·baseline, 마지막 보고 시각, 종료 시각 |
| asks | UUID `id`, `run_id` → runs.id 외래 키 | 질문·JSON 선택지·추천값, 상태, 답변, 생성 시각 |

외래 키 검사를 켠다. ask 상태는 DB CHECK로 `pending`, `answered`, `closed`만 허용한다. 별도 보조 인덱스는 없고 기본 키 인덱스를 사용한다. JSON 진행 상태의 병합·검증은 [server/progress.ts](../server/progress.ts), 입력·출력 타입은 [shared/contract.ts](../shared/contract.ts)가 담당한다. 전체 스키마를 문서에 중복하지 않는다.

report는 프로젝트 등록·run 저장·질문 종료를 한 트랜잭션으로 처리한다. 질문 답변은 pending인 행에만 조건부로 반영해 중복 답변을 막는다. 답변 완료 후 같은 ask_id를 재조회하면 저장된 답을 반환한다. HTTP 대기 연결과 파일 watcher는 메모리에 있고, 재시작 시 활성 run의 watcher를 다시 만든다.

## 보관·삭제 정책

완료·중단 run, 질문, 마지막 진행 스냅샷은 자동 삭제하지 않는다. 전체 patch 이벤트 이력이나 제품 리플레이는 저장하지 않는다. 문서 baseline과 질문·답변은 DB에 포함되므로 named volume도 로컬 작업 데이터로 관리한다. Markdown 원본은 DB가 소유하지 않고 에디터와 읽기 전용 마운트에서 읽는다.

Compose의 `office-data` volume에 DB를 보관하며 컨테이너 재시작과 `docker compose down`으로 유지된다. `docker compose down -v`는 저장 데이터를 삭제한다. 앱 내 삭제 기능·자동 만료·백업 복구 기능은 현재 없다.
