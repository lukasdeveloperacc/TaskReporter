# 진행 중 TODO 표시와 갱신 유도

상태: 완료 (로컬 구현·검증, 배포 전)

TODO 체크가 빠지거나 작업 완료 직전에 몰아서 체크되는 일이 잦아 진척을 읽기 어렵다. 기존 장치는 완료 시점 검증(미완료 TODO가 있으면 완료 거부)과 30분 정체 체크인뿐이라 중간 누락을 잡지 못했고, `include_state:false` 응답에서는 남은 TODO를 다시 볼 기회도 없었다. 계약은 [진행 보고 요구사항](../requirements/progress-office.md#진행-중-todo와-todo-갱신-유도)에 있다.

범위: 업무기록의 진행 중 TODO 표시(추론), report 응답 `open_todos`, 15분 TODO 미체크 체크인, TODO 체크 시각·몰아서 체크 기록과 get_retros 신호, 테스트, 요구사항·DB·README. 스킬 쪽(lead 결과의 `끝낸 TODO` 줄, root 즉시 체크, open_todos 대조)은 PersonalAgentPlugins에서 별도로 진행한다. 제외: 새 TODO 필드(active 등), 완료 거부 강화, progress.py·golden 변경, 업무 보드 표시 변경.

검증 기준: 첫 미완료만 표시·대기 작업 미표시, open_todos 대상·next·빈 목록, 15분 조건(작업 변화 있음/없음, TODO 체크 시 리셋, TODO 없는 작업 제외), 체크·해제·완료 동시 체크 기록, 기존 task_clocks 열 추가, 전체 테스트·typecheck·build·golden·git diff --check.

독립 리뷰(CRITICAL·HIGH 없음)에서 대기→진행중 재개 시 오탐이 지적되어, 작업이 다시 진행중이 되는 report에서 기준 시각을 새로 시작하도록 고치고 재개·담당자 변경·쿨다운·롤백 테스트를 추가했다(수정 전 코드에서 실패 확인). 기존 run의 이미 완료된 TODO는 체크 기록이 없어 todos_ticked가 적게 집계된다.

검증 결과: 전체 테스트 18개 파일·225개 통과, npm run typecheck·npm run build·npm run golden·git diff --check 통과. 브라우저 화면 확인과 배포는 별도다.
