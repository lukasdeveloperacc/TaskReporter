# 결재 답 재전달과 대기 시간 단축

상태: 완료 (로컬 구현·검증, 배포 전)

결재 답을 늦게 확인한 사례를 줄이기 위해 기본 ask 대기를 295초에서 100초로 단축한다. pending에 retry_after_sec:0과 같은 ask_id 재호출 안내 message를 추가한다. run별 공통 조회를 통해 report.asks에는 answered를, get_run.asks에는 기존 pending과 answered를 전달한다. 기존 get_run 질문 필드는 보존하고 ask_id를 추가한다. 답은 매번 다시 전달하며 클라이언트가 ask_id로 중복 처리한다. 응답 전송을 수신 확인으로 취급하지 않는다.

범위: 공유 계약·서버·환경 기본값·MCP 출력 스키마·[결재 요구사항](../requirements/decisions-integration.md)·README. ack, DB 마이그레이션, wait_sec, 응답 축소, UI, 외부 스킬, 푸시·배포는 제외한다.

검증 기준: 기본 100초, pending 안내, run 격리, 반복 전달과 동일 id 답 재호출, 연결 종료·DB 재오픈 후 답 유지, MCP 출력 스키마, 전체 테스트·타입 검사·빌드.

검증 결과: 전체 테스트 18개 파일·214개 통과, npm run typecheck·npm run build·npm run golden·git diff --check 통과. 기본 타이머 100000ms는 실제 타이머 등록을 관찰해 확인했고, timeout 반환은 짧은 테스트 대기로 검증했다. MCP SDK/HTTP 통합 테스트에서 outputSchema 탐지, 답변 재전달·run 격리·중복 조회 무변경, 연결 종료 후 HTTP 답변·서버/SQLite 재오픈·동일 id 답 재호출을 확인했다. 기존 pending 조회·closed 제외·종료 후 answered 재조회도 보존한다. 전용 lint 스크립트는 없다. 실제 Claude/Codex 호스트의 100초 대기와 컨테이너 배포는 수행하지 않았다.

응답 예: ask pending은 `{status:"pending",ask_id:"…",retry_after_sec:0,message:"같은 ask_id로 ask를 다시 호출하세요. 새 질문을 만들지 마세요."}`, report는 기존 필드에 `asks:[{ask_id:"…",status:"answered",answer:"승인"}]`를 추가한다. get_run.asks는 기존 질문 필드와 ask_id를 제공한다. MCP tools/list의 outputSchema.properties.asks 및 outputSchema.properties.retry_after_sec로 기능을 감지한다. 기존 text content를 보존하고 같은 객체를 structuredContent에도 제공한다.
