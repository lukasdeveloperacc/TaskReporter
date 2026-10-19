# 001 · Office Team Reporter

상태: 완료 — 구현·독립 리뷰·실제 클라이언트 전체 흐름과 최종 수용 조건을 확인했다. 문서 변경 리뷰와 커밋은 별도 마무리 절차다.

## 이유와 범위

터미널의 basic-team을 유지하면서 옆 화면에서 여러 프로젝트의 직원 작업·검수·결재·기획 변경·완료 기록을 확인하기 위해 로컬 관제실을 구현했다. localhost Docker·단일 Node 프로세스·SQLite, MCP report/ask, 빌딩 로비·픽셀 사무실·전체 보기, 모델/effort 직접 표시, 사용자 대표/리더 부장 구분, 문서 읽기·diff, 원본 스킬 래퍼와 HTML 폴백을 포함한다. 원본 basic-team 수정, 원격 접속·다중 사용자, 앱 내 편집, 3D·효과음·통계·제품 리플레이는 제외한다.

## 관련 기준

[제품](../0-PRODUCT.md) · [구조·명령](../1-SYSTEM-ARCHITECTURE.md) · [디자인](../2-DESIGN.md) · [저장소](../3-DATABASE.md) · [사용자 흐름](../4-USERFLOW.md) · [진행](../requirements/progress-office.md) · [결재](../requirements/decisions-integration.md) · [기획서](../requirements/documents.md)

문서는 SDDMaker의 docs 역할 구분을 따라 5개 고정 문서와 기능별 requirements, 변경 기록으로 정리했다. 기존 디자인 원칙을 보존하고 루트 PRODUCT/DESIGN은 도구 호환 안내로 남겼다. 실제 별도 화면 시안이 없어 screens 디렉터리는 만들지 않았으며 basic-team의 docs/inprogress는 런타임 예외로 명시했다.

## 구현과 검증 결과 · 2026-10-19

- 구현 R7에서 테스트 72개, TypeScript typecheck, Vite build, 원본 progress.py golden 비교 통과를 확인했다. 독립 lint 스크립트는 없다.
- 동일 구현 revision의 Karpathy Agent, Ponytail Agent, Impeccable Agent, E2E Agent 리뷰가 모두 PASS였다.
- 실제 Claude Code 2.1.303·sonnet·`MCP_TOOL_TIMEOUT=325000`에서 ask가 약 295초(295287ms) 후 pending을 반환했다. 같은 ask_id 재시도와 브라우저 선택 답변 전달도 확인했다. 해당 환경의 결과이며 모든 클라이언트의 타임아웃 동작을 보장하지 않는다.
- 실제 office-basic-team 전체 데모가 exit 0으로 종료되어 13개 task와 리뷰어 4종 PASS를 보고했다. 동일 run에서 typing·delivery 실제 위치, 문서 편집 공지·report diff·Claude 결재의 브라우저 답변, 실제 R1 승인 도장 4종을 확인했다. 업무 일지를 실제 클릭해 마지막 스냅샷의 task 13개와 review 4개도 대조했다.

## 최종 상태

전체 데모의 저장 상태와 사용자 수용 조건 대조를 마쳤다. 일반 Compose 실행 상태로 복귀했다. 문서 변경 리뷰와 커밋은 별도로 마무리하며 이 기록은 외부 배포·게시 완료를 의미하지 않는다.
