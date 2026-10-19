# 진행 보고와 사무실

상태: 현재 구현. 목적은 여러 프로젝트의 basic-team 진행을 빌딩 층과 직원 작업으로 관찰하는 것이다. 제품 범위는 [제품 문서](../0-PRODUCT.md), 공통 UI 원칙은 [디자인](../2-DESIGN.md)을 따른다.

## 계약과 업무 규칙

`POST /mcp`의 `report`는 절대 `project_path`, `patch`와 선택적인 `run_id`, `doc_path`, `title`, `close_ask_ids`를 받는다. 새 실행은 run_id를 발급하고 기존 실행은 같은 id로 이어간다. 다른 프로젝트에 속한 run_id나 알 수 없는 id는 오류이며 자동으로 새 run을 만들지 않는다. 응답은 `{run_id, doc_changes}`다. 정확한 타입은 [contract.ts](../../shared/contract.ts), 검증·병합은 [progress.ts](../../server/progress.ts)를 따른다.

- 텍스트 patch는 title·stage·summary·todo·blockers만 받는다. task는 id, decision은 앞뒤 공백을 제거한 title, review는 round+reviewer로 병합한다. 보내지 않은 기존 항목을 보존한다.
- stage는 계획·구현·리뷰·수정·마무리·완료·중단으로 시작한다. task lane은 plan/build/review/fix/finish, status는 대기중·진행중·완료·중단이다. after는 존재하는 task id만 참조한다.
- 진행중 진입과 완료·중단 전환 때 task 시간을 기록한다. 열린 task가 있으면 완료 report를 거부한다. finish 종료의 자동 완료 규칙은 원본 progress.py와 맞춘다.
- review 이름은 Karpathy Agent, Ponytail Agent, Impeccable Agent, E2E Agent다. 라운드와 보고된 판정·note를 표시한다.

## 화면·상태

프로젝트 경로 순으로 빌딩 층을 정렬한다. 보고 도착 순서만으로 층을 재배치하지 않는다. 신규 프로젝트 추가 시 층 번호는 달라질 수 있다. 층은 지붕·간판·구조 프레임·창·지상 출입구가 이어진 하나의 빌딩 안에서 선택한다. 상태는 활성 run 없음 → 퇴근, pending 결재 있음 → 결재 대기, 활성 run 중 마지막 report가 30분 넘은 것이 있음 → 자리 비움, 나머지 → 불 켜짐 순으로 결정한다.

사무실에는 `대표 · 나`와 `부장 · leader`, 부서별 직원·임시 역할 자리를 둔다. owner 식별자를 보존하며 보고된 `task.model` ID와 effort를 DOM 텍스트로 보여준다. 누락 값은 미보고이며 추측하거나 직급으로 대체하지 않는다. stage·summary·todo·blockers도 일러스트 밖에서 읽을 수 있다. 전체 보기는 원래 픽셀 크기의 일반 보기와 별개로 전체 배치를 화면에 맞추며 닫기·Esc·포커스 복귀를 지원한다.

완료·중단 실행은 업무 일지에 남고 마지막 작업·리뷰·결정을 연다. 이는 마지막 스냅샷이며 전체 이벤트 재생이 아니다.

## 완료·검증 기준

report 후 상태 API와 사무실이 동일한 결과를 보여야 한다. 병합·시간·종료·의존성 검증, 다중 프로젝트와 run 선택, 모델·effort 누락/표시, 로비 정렬·상태, 전체 보기·키보드·업무 일지를 검증한다. 근거는 [progress 테스트](../../server/progress.test.ts), [app 테스트](../../server/app.test.ts), [Office 테스트](../../web/src/Office.test.tsx), [Lobby 테스트](../../web/src/Lobby.test.tsx), [App 테스트](../../web/src/App.test.tsx)와 원본 golden 비교다.
