# 026 — 승인 집계 구분·선택 조회·리뷰 본문과 모델 표시

상태: 완료 — 로컬 구현·검증과 스킬 협업 완료. 실행 서버 배포·설치 캐시 갱신은 별도.

## 이유와 범위

[세 번째 인터뷰](025-office-mcp-third-interview.md)에서 단일 실행자가 없는 승인 집계에도 model/effort 누락 체크가 발생했고, 특정 리뷰 카드만 확인할 때 전체 실행을 읽어야 했다. 기존 작업자 보고·체크인·종료 조건을 유지하면서 집계 구분과 선택적 조회를 추가한다. 같은 조사에서 확인한 긴 직원 상세의 닫기 접근성과 최신 업무 탐색도 보완한다.

스킬 소스는 사용자 지정 PersonalAgentPlugins pane과 분담한다. TaskReporter의 계약·검증 결과를 먼저 공유하고 스킬 예제는 실제 지원되는 스키마에 맞춘다. 실행 중인 기존 클라이언트의 도구 목록을 서버가 강제로 갱신한다고 주장하지 않는다. 기존 실제 run·사용자 탭·데이터는 수정하지 않는다.

## 계약과 구현 작업

- `tasks[].kind`는 선택적인 `actor | aggregate`다. 생략은 기존 actor 동작이다. aggregate는 model/effort 누락 체크만 면제하며 TODO 정체·30분 정체·미완료 TODO 성공 종료 방지는 유지한다. actor↔aggregate 전환은 기존 pending 체크와 관찰 기준을 재평가한다.
- aggregate는 실행 중인 캐릭터나 모델 정보의 원천으로 사용하지 않는다. placements는 해당 카드에 null 부서·unassigned를 반환한다. owner가 있으면 책임 식별자로 보존하지만 새 작업자 실행을 의미하지 않는다.
- `get_run({run_id, task_ids})`는 선택적으로 1~100개의 비어 있지 않은 task ID를 받는다. 지정 시 tasks·state.tasks·placements·작업별 checks를 제한하고 run 수준 retro 체크는 보존한다. 실행 metadata·asks·reviews·decisions·retro는 유지한다. 생략 시 기존 전체 조회와 같고 미등록 ID는 빈 작업 목록이다. 조회는 상태를 변경하지 않는다.
- 직원 상세는 닫기를 항상 찾을 수 있게 하고 현재 업무의 진행·대기 작업과 최근 완료를 먼저 읽게 한다. 오래된 완료 업무와 TODO는 접어서 계속 확인할 수 있다. 집계는 실제 작업자의 model/effort 미보고로 오인하지 않도록 구분한다.
- 후속 사용자 피드백인 리뷰 내용 누락에 대응해 프로젝트 기록과 직원 현재 업무·실행 이력에 실제 reviews verdict·note 전문을 표시한다. 리뷰어별 최신 라운드 우선, 이전 라운드 접기, 정확한 reviewer 분리와 리뷰만 있는 실행을 지원한다. task 완료에서 판정을 유추하지 않는다.
- model·effort가 말풍선의 title에만 숨겨져 있던 문제를 고쳐 본문에 항상 표시한다. 조사한 실행 `3f69f9a0…`의 실제 작업 61개와 `b3970174…`의 24개에는 두 값이 저장돼 있었다. 후자의 유일한 미설정 항목은 단일 실행자가 없는 REVIEW 집계다. 이 증거를 모든 과거 실행의 무결성으로 확대하지 않으며 미보고 값은 추측하지 않는다.
- 독립 리뷰에서 잡힌 집계 완료의 실제 작업자 전달 애니메이션을 수정했다. 장면 계산의 이동·전달·반려 대상에서 집계를 함께 제외한다.

## 검증 기준

실제 작업자 누락 검사 유지, 집계 면제와 정체·종료 보호, kind 전환·병합·입력 오류, 필터 기본 호환·미등록 ID·읽기 전용 보장을 자동 검사한다. 전체 테스트·타입 검사·빌드·golden을 실행한다. 격리 DB의 실제 MCP report/get_run과 1185px·390px 직원 화면에서 동작과 포커스·닫기를 확인한다. 제품·스킬 각각 검증 후 커밋·푸시하고 결과를 연결한다.

## 검증 결과

- 전체 테스트 20개 파일·275개 통과, typecheck·build·golden·diff whitespace 검사 통과. 독립 최종 리뷰 APPROVE, 열린 필수 결함 없음.
- 격리 4781 MCP SDK: 집계는 model/effort가 없어도 불필요한 체크·캐릭터가 없고 placements는 unassigned다. 필터·미등록 ID·읽기 전용·tools/list 스키마를 실제 호출로 확인했다. 동일 fixture의 전체 응답 4726 bytes→두 task 조회 1494 bytes이며 토큰 측정값은 아니다.
- 1185×800·390×800 브라우저: 말풍선에서 모델·노력 본문을 읽을 수 있고 긴 모델 ID fixture는 99px 이내 높이로 120px 좌석 행 간격을 넘지 않는다. 실제 reviews 본문·이전 라운드·직원별 분리를 확인했다. 모바일 상세를 끝까지 스크롤해도 닫기 버튼은 y=80~124에서 유지되고 가로 넘침은 없다. Esc 후 상세를 닫고 지도에 포커스를 복귀한다.
- 격리 QA 증거는 추적 제외 `.omx/reports/office-third-implementation-20261024/`에 보관한다. 합성 데이터만 사용했으며 실제 사용자 run과 4780 서버는 수정하지 않았다. 실행 서버 배포와 기존 세션의 도구 catalog 갱신은 별도다.

## 지정 pane의 스킬 협업

PersonalAgentPlugins main에 [4a63aa2](https://github.com/lukasdeveloperacc/PersonalAgentPlugins/commit/4a63aa2f7fb87d2e6047c33945e6a883ae4c84a4)·[7d32328](https://github.com/lukasdeveloperacc/PersonalAgentPlugins/commit/7d32328726a9bb214ed74af36647e8b17381e09b)를 상대 pane이 커밋·푸시하고 원격 일치를 확인했다. 집계 schema-gating·종류 전환·root/leader 구분·필터 후 전체 종료 감사·신규 링크·오래된 세션 catalog 한계·role-fixed effort 반복 재생성 방지와 실제 리뷰 본문 보고를 보완했다.

Reviewer는 실제 결과를 root에게 반환하고 root가 정확한 round/reviewer/verdict/note를 다음 checkpoint에 게시한다. task 완료·task.note·근거 경로만으로 본문을 대신하지 않으며 미수집 결과를 PASS로 간주하지 않는다. 모델은 runtime 확인값만 기록하는 기존 규칙을 유지했다. 상대 검증은 두 스킬 형식·로컬 링크 9개·JSON 8블록·기존 portable patch 7개 순차 재생과 독립 행동 시나리오이며 제품 브라우저·실제 MCP 검증은 이 저장소에서 수행했다.
