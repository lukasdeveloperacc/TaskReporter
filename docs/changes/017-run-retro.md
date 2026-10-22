# run 회고 수집

상태: 완료 (로컬 구현·검증, 배포 전)

basic-* 스킬 실행이 끝날 때 스킬 지시·도구·프로세스에서 막힌 점을 기록하고, 나중에 스킬이나 MCP를 개선할 때 반복 패턴을 근거로 쓰기 위해 run 회고(retro)를 수집한다. 사실 신호(리뷰 라운드, 체크인 응답 지연, 중단 여부)는 서버가 기존 DB에서 계산하고, 에이전트는 서버가 볼 수 없는 내용만 최대 3개 보낸다. 코드 결함은 리뷰 몫이며 회고 대상이 아니다.

범위: 공유 계약, report 입력·응답, 회고 저장, 회고 요청 체크, 읽기 전용 `get_retros` 도구, `get_run` 회고 필드, MCP 사용 안내, 테스트, [결재·실행 요구사항](../requirements/decisions-integration.md), [데이터베이스](../3-DATABASE.md), README. 제외: 웹 화면, 회고 자동 요약·LLM 분석, ask 답변 시각 저장(아래 후속 참고), 회고 삭제·수정 UI, 외부 스킬 변경(PersonalAgentPlugins에서 별도 진행), 이미지 배포.

## 계약

report 최상위(`close_ask_ids`와 같은 위치)에 선택 필드 `retro`를 추가한다.

```ts
retro?: {
  skill: string          // 'basic-team', 'basic-frontend-team' 등. trim 후 1~64자
  skill_version: string  // '0.1.0+bb590a2' 또는 '0.1.0'. 불투명 문자열, 서버는 파싱하지 않음. 1~64자
  category: 'instruction_gap' | 'tool_friction' | 'user_correction' | 'review_miss' | 'other'
  evidence: string       // 무슨 일이 있었나. 1~500자
  suggestion?: string    // 개선 제안. 최대 500자
}[]                      // 0~3개. [] = 회고 없음을 명시
```

- 이 report의 patch 병합 후 run이 종료 상태일 때만 받는다. 기준은 병합된 stage가 `완료`·`중단`으로 시작하는지(`isEnded`)이며, finish task 완료로 stage가 자동으로 `완료`가 되는 경로(`server/progress.ts`)도 포함한다. 아니면 `retro requires ended run` 오류로 report 전체를 롤백한다.
- 종료 후에는 `patch:{}`와 `retro`만 보내는 report를 허용한다. 현재 schema에서 patch는 필수지만 빈 객체로 통과한다. 빈 patch는 stage를 바꾸지 않으므로 run을 재개하지 않으며, 기존 `ended_at`도 유지한다(`run.ended_at ?? 현재 시각`). 테스트로 고정한다.
- 다시 보내면 그 run의 회고 전체를 교체한다. 같은 내용 재전송(네트워크 재시도)은 행과 최초 제출 시각을 그대로 둔다.
- 작업 id `__retro__`는 회고 체크 전용 예약어로, patch.tasks에 쓰면 거부한다.
- 스킬은 `tools/list`에서 `report.inputSchema.properties.retro`를 확인한 뒤 사용한다. `include_state`와 같은 기능 감지 방식이다.

## 회고 요청 체크

- run을 끝내는 report(직전 상태가 종료가 아님)에서 그 run에 회고 제출 기록이 없고 회고 체크를 만든 적도 없으면, pending 체크를 **한 번만** 만든다. `task_id`는 `__retro__`이고 owner는 null이다. 질문은 "회고를 보내 주세요: 스킬 지시·도구·프로세스에서 막힌 점 최대 3개를 report 최상위 retro로, 없으면 retro:[]." 한두 줄이다.
- 기존 종료 처리(`reconcileChecks`의 ended 분기)는 pending 체크를 모두 닫는다. 이 정리에서 `__retro__`는 제외하고, 회고 체크는 정리가 끝난 뒤 만든다.
- 회고 제출(빈 배열 포함) 시 pending `__retro__` 체크는 answered로 바뀌고, answer는 `retro <n>건`, responded_at은 제출 시각이 된다. `check_replies`의 텍스트 답도 기존 규칙대로 answered 처리하며 회고 행은 만들지 않는다. 어느 쪽이든 다시 요청하지 않는다.
- run이 종료에서 다시 진행으로 바뀌면 pending `__retro__`를 닫는다. 이미 만든 적이 있으므로 다음 종료 때 다시 만들지 않는다.
- 답하지 않아도 완료를 막지 않는다.

## 저장

- 새 테이블 `retros(id TEXT PK, run_id TEXT NOT NULL REFERENCES runs(id), skill, skill_version, category CHECK(...), evidence, suggestion NULL, created_at TEXT NOT NULL)`, 인덱스 `(skill, category, created_at)`.
- 빈 배열 제출을 "미제출"과 구분하기 위해 `runs.retro_at TEXT NULL`을 `projects.hidden`과 같은 PRAGMA 확인 방식으로 추가한다.
- 회고 교체·체크 갱신은 기존 report 트랜잭션 안에서 처리한다. 검증 오류가 있으면 진행 patch를 포함해 전부 롤백한다.
- 보관 정책은 다른 이력과 같다. 자동 삭제하지 않는다.

## 조회

- `get_run` 응답에 `retro: {submitted_at: string|null, items: [...]}`를 추가한다. 기존 필드는 유지한다.
- 새 읽기 전용 도구 `get_retros({skill?, category?, since?, project_path?})`를 추가한다. since는 ISO 시각이며 created_at 기준이다. 응답:
  - `groups[]`: skill+category별 `{skill, category, run_count, skill_versions[], last_at, candidate, items[{run_id, project_path, skill_version, evidence, suggestion, created_at}]}`. `candidate`는 서로 다른 run이 2개 이상일 때 true다. 정렬은 candidate, run_count, last_at 내림차순이다.
  - `signals[]`: 해당 회고가 있는 run별 `{run_id, project_path, stage, ended_at, review_rounds, checks_answered, checks_closed_unanswered, avg_check_reply_ms}`. `review_rounds`는 state.reviews의 최대 round, 체크 수치는 `__retro__`를 제외한 checks 행에서 계산한다.
  - 기본 제한은 최근 200개 회고 행이다. 이를 넘으면 `truncated:true`를 표시한다.
- 스킬 수정 전후 구분은 since로 한다. skill_version 목록은 참고용이다.

## 구현 작업

1. `shared/contract.ts`: `RETRO_CATEGORIES`, `RetroItem`, `ReportArgs.retro`, get_run·get_retros 결과 타입. 계약 테스트 보강.
2. `server/store.ts`: retros 테이블·인덱스, `runs.retro_at` 열 추가, `replaceRetro(runId, items, stamp)`, `retroCheck` 생성·answered 처리, ended 정리에서 `__retro__` 제외, `retros(filter)`·`retroSignals(runIds)` 조회.
3. `server/app.ts`: report schema에 `retro`(strict, max 3, 길이 제한), 종료 상태 검증, 트랜잭션 연결, usage 안내 한 줄, `get_run` 회고 필드, `get_retros` 등록(readOnlyHint, outputSchema).
4. 테스트(`server/app.test.ts`, `server/store.test.ts`): 아래 검증 기준.
5. 문서: 요구사항 "run 회고" 절, `3-DATABASE.md` 엔티티 행, README MCP 절. 완료 시 이 기록에 결과를 남긴다.

## 검증 기준

- 진행 중 run에 retro 전송 → 오류, patch 롤백
- 완료 report와 retro 동시 전송 → 저장, 회고 체크 미생성
- 완료 report만 → `__retro__` pending 1건, 다음 report에서 닫히지 않음, 재종료해도 중복 생성 없음
- `retro:[]` → retro_at 기록, 체크 answered, 행 0
- 재전송 → 교체, 같은 입력 재전송 시 결과 동일
- 잘못된 category, 4개 이상, 빈 evidence, 알 수 없는 키 → 거부
- check_replies로 회고 체크에 텍스트 답 → answered, 재요청 없음
- 종료→진행 전환 시 pending 회고 체크 closed
- get_retros 필터·그룹·candidate·since·signals 계산, readOnly이며 상태 무변경
- DB 재오픈 후 유지, 기존 DB(retro_at 열 없음)에 열 추가
- 기존 체크인 테스트 전부 통과, 전체 테스트·typecheck·build·golden·git diff --check

## 후속(이번 범위 아님)

- ask 대기 시간: asks에 답변 시각 열이 없어 계산할 수 없다. 필요해지면 `asks.answered_at`을 추가한다.
- 웹에서 회고 보기: 수정 후보가 쌓여 실제로 쓰게 되면 로비 탭을 검토한다.

## 결과

로컬 구현 완료. 계획 대비 변경: 독립 리뷰 지적에 따라 회고 요청은 종료로 바뀌는 report에서만 만든다(배포 전에 이미 끝난 run에는 요청하지 않음). 같은 회고 재전송은 제출 시각을 유지한다. `__retro__` 작업 id를 거부한다. get_retros의 since는 시간대가 있는 ISO만, project_path는 절대 경로만 받는다. DB category CHECK는 `RETRO_CATEGORIES` 상수로 만든다.

검증: 전체 테스트 18개 파일·221개 통과(2회 연속). 한 번은 기존 문서 감시 테스트가 부하로 4초 타임아웃이 났고, 재실행 3회에서 통과했다. npm run typecheck·npm run build·npm run golden·git diff --check 통과. 독립 코드 리뷰 결과 CRITICAL·HIGH는 없었고, MEDIUM(문서·테스트 누락)과 LOW 지적은 위와 같이 반영했다. 200행 제한에서 run 항목이 잘리는 것과 run별 신호 조회 비용은 그대로 두고 문서화했다. 스킬 쪽(lukas-plugin `reporting.md` Retro 절, basic-team Finish 문장, lead 브리프 `스킬 마찰` 줄)은 PersonalAgentPlugins에서 별도로 진행했다. 컨테이너 이미지 배포와 실제 Claude/Codex run에서의 end-to-end 확인은 하지 않았다.
