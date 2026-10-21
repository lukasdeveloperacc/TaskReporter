# 009 — 작업별 Phase TODO 보고·표시

상태: 구현·자동 검사·독립 리뷰·실제 브라우저 검증 완료. push와 배포는 하지 않는다.

## 이유와 범위

작업 안의 Phase별 할 일을 보고하고 직원 현재 업무·작업 기록과 업무 보드에서 완료 정도를 읽을 수 있게 한다. task의 선택적 todos에 id·text·phase·done·detail을 담으며 strict 입력 검증을 유지한다. 기존 작업 계약과 최상위 todo 문자열은 유지한다.

같은 task 안에서 todo id로 부분 병합한다. 최초 등장 순서와 보내지 않은 항목·필드를 보존하고 새 todo의 text를 생략하면 id를 쓴다. report의 state와 get_run의 tasks에 병합 결과를 노출한다. 직원 현재 업무는 계획·대기 작업도 포함하고 현재/기록 화면에 완료 표시·진행률 막대·기본 접힌 detail을 제공한다. note는 줄바꿈과 ` · `로 분리하며 업무 보드는 완료/전체(x/y)를 보여준다.

외부 progress.py·기존 golden fixture·신규 의존성·앱에서 TODO 상태 편집은 범위 밖이다. push·GHCR 배포는 하지 않는다.

## 관련 문서와 구현

- [작업별 TODO 계약과 화면 요구사항](../requirements/progress-office.md#작업별-phase-todo)
- 공용 task 타입, MCP 스키마·설명, TypeScript 병합과 report/get_run 테스트.
- 직원 현재 업무·작업 기록과 보드 표시, 관련 UI 회귀 테스트.

## 검증 기준과 결과

리더가 `npm test && npm run typecheck && npm run build && BASIC_TEAM_DIR=/Users/chaejinjeong/orca/PersonalAgentPlugins/skills/basic-team npm run golden` 전체 PASS를 확인했다. 전체 테스트는 18개 파일·180개를 통과했다. 독립 리뷰는 16개 파일에서 발견 0건이며 관련 101개 테스트·typecheck·diff 검사도 PASS다. 외부 progress.py와 golden fixture는 수정하지 않았다.

격리 서버 4795와 Orca 브라우저에서 데스크톱 1080×936·모바일 390×844로 Phase 묶음, 3/5 진행률, 완료 체크·흐림 표시, detail 기본 접힘과 Enter 열기, 현재 업무 탭 유지, 메모 3행 분리, 대기 작업 표시를 확인했다. 모바일 dialog의 clientWidth와 scrollWidth는 모두 344px로 가로 넘침이 없었다. 캡처는 로컬 `.omc/artifacts/todos-desktop.png`, `todos-mobile.png`, `todos-mobile-detail.png`에 보관한다.

Impeccable 검사에는 기존 사무실 canvas grid advisory 1건만 남았고 의도된 배치를 유지했다. 실제 Claude Code 클라이언트 호출·push·배포는 수행하지 않았다.
