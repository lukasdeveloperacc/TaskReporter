# 회고 제출 현황

상태: 완료 (로컬 구현·검증, 배포 전)

[변경 017](017-run-retro.md)은 회고 미제출 시 한 번만 요청하고 완료를 막지 않는다. 강제 여부를 실제 데이터로 정하기 위해 `get_retros` 응답에 종료된 run의 제출 현황 `submission`을 추가한다. 계약은 [결재·실행 요구사항](../requirements/decisions-integration.md#run-회고)에 있다.

범위: 공유 타입, 저장소 집계 쿼리, get_retros 출력·설명, 테스트, 요구사항·README. 제외: DB 변경(기존 `runs.retro_at`·`ended_at` 사용), 미제출 시 완료 거부, 스킬별 미제출 집계(미제출 run에는 스킬 정보가 없음), 웹 화면.

검증 기준: 제출·빈 제출·미제출·진행 중 run 혼합에서 수치, 미제출 목록, skill 필터 무시, since(ended_at 기준) 적용, 조회 무변경, 전체 테스트·typecheck·build·git diff --check.

검증 결과: 전체 테스트 18개 파일·221개 통과(2회), npm run typecheck·npm run build·git diff --check 통과. get_retros 통합 테스트에 제출 2·빈 제출 1·미제출 1·진행 중 1 run 혼합 수치와 since 필터를 추가했다. 배포는 별도다.
