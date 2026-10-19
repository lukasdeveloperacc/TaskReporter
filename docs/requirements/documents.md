# 기획서 열람과 변경

상태: 현재 구현. 사용자는 에디터에서 문서를 편집하고 앱에서는 읽는다. 리더는 변경 diff를 받고 재계획 여부를 물어본다.

## 접근과 계약

report의 `doc_path`는 프로젝트 기준 Markdown 경로다. 프로젝트·문서의 정규화 경로와 실제 symlink 해석 경로가 모두 workspace와 프로젝트 경계 안에 있어야 한다. `.md` 일반 파일만 허용하며 저장소 밖 문서·경계 이탈 symlink는 열지 않는다. workspace 밖 프로젝트도 진행을 표시하지만 문서 접근은 제공하지 않는다. 구현 기준은 [docs.ts](../../server/docs.ts)다.

`GET /api/runs/:id/doc`는 `{path,text}`를 반환한다. 존재하지 않는 run·문서·연결 문서는 404, 허용 경계 밖은 403이다. 읽기 전용 패널은 로딩·오류·접근 불가 상태를 표시한다.

## 변경과 복구

활성 run의 연결 문서를 약 1초 간격으로 감시한다. 변경 시 SSE `doc-changed`로 공지하고 문서 내용을 갱신한다. 다음 report는 저장된 baseline 대비 unified diff를 `doc_changes`로 반환하고 baseline을 갱신한다. 첫 연결과 문서 경로 전환은 baseline을 설정하며 이전 문서와 비교하지 않는다. 종료 run은 감시를 중지하고 재개·서버 시작 시 활성 run 감시를 복원한다.

스킬은 diff를 읽고 변경 요지를 알린 다음 `재계획`/`그대로 진행` 결재를 만든다. 답변 전에는 변경에 의존하는 구현을 기다리고 독립 작업을 계속한다. 재계획이면 원본 계획 흐름으로 돌아가 승인 후 계획 문서를 연결하고, 그대로 진행이면 이유를 report한다.

## 완료·검증 기준

파일 변경→공지→새 문서 표시→다음 report의 diff, 경로 변경·접근성 변경·재연결의 새로고침, 경계 이탈·symlink·누락 파일·종료 run 감시를 확인한다. 근거는 [docs 테스트](../../server/docs.test.ts), [app 테스트](../../server/app.test.ts), [패널 테스트](../../web/src/Panels.test.tsx), [App 테스트](../../web/src/App.test.tsx)다.
