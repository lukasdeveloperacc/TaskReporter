# 시스템 아키텍처

## 구성과 경계

Node 24 프로세스 하나가 Express 5, MCP SDK의 Streamable HTTP, SQLite와 빌드된 React 19 화면을 제공한다. TypeScript 소스를 Node에서 직접 실행하고 Vite 8이 웹 정적 파일을 만든다. 배포는 [Dockerfile](../Dockerfile)과 [Compose](../docker-compose.yml)를 사용한다. 추가 큐·외부 DB·인증 서비스는 없다. localhost 전용이며 원격·다중 사용자 운영은 범위 밖이다.

| 위치 | 책임 |
| --- | --- |
| [shared/contract.ts](../shared/contract.ts) | MCP 입력·응답, 상태 타입과 공통 시간·상태 상수 |
| [server/main.ts](../server/main.ts) | 환경 검증, DB·HTTP 수명 주기와 정적 파일 제공 설정 |
| [server/app.ts](../server/app.ts) | MCP report/ask/get_run, HTTP API, SSE, 질문 대기와 문서 watcher 조정 |
| [server/progress.ts](../server/progress.ts) | progress.py 호환 검증·병합·시간·종료 규칙 |
| [server/store.ts](../server/store.ts) | SQLite 스키마·트랜잭션·스냅샷, 작업별 체크인 관찰 기준·쿨다운·요청 이력과 수명주기 조정 |
| [server/docs.ts](../server/docs.ts) | Markdown 읽기, 실제 경로 경계 검사, diff·변경 감시 |
| [web/src/App.tsx](../web/src/App.tsx) | hash 경로, 상태 갱신, 프로젝트·run 선택 |
| [web/src/Office.tsx](../web/src/Office.tsx), [Lobby.tsx](../web/src/Lobby.tsx), [Panels.tsx](../web/src/Panels.tsx) | 사무실·빌딩·결재·기획서·업무 일지 |

직접 둘러보기의 프런트엔드 확장을 구현했다. [visitor.ts](../web/src/visitor.ts)는 발 위치 기반 이동·벽·출입구·근접 대상 계산을, [floors.ts](../web/src/floors.ts)는 로비와 엘리베이터가 공유하는 층 정렬을 맡는다. App은 둘러보기 의도·실제 프로젝트 경로 전환을, Office는 위치·일시정지·직원 상세·엘리베이터·지도 카메라와 포커스를 관리한다. 실제 브라우저 검증과 독립 리뷰 결과는 [변경 기록 002](changes/002-keyboard-visitor.md)에 둔다.

## 데이터 흐름과 외부 경계

터미널의 basic-team(Office 모드) → `POST /mcp`의 report → 검증·병합 → SQLite 저장 → SSE `changed` → 화면이 `/api/state`를 다시 읽는다. ask는 SQLite에 질문을 저장하고 HTTP 호출을 대기시킨다. 브라우저 답변은 저장 후 대기 호출에 전달된다. 호출 취소·서버 재시작 뒤에도 질문은 DB에 남고 같은 ask_id로 재개한다. 상세 계약은 [결재 요구사항](requirements/decisions-integration.md)에 있다.

체크인은 로컬 구현되었으며 전체 검사·독립 리뷰는 진행 중이다. 진행중 task의 정체·model/effort 누락을 다음 report에서 검사하고 같은 트랜잭션에 관찰 기준·요청·명시 응답·종료를 저장한다. `report.checks`는 pending, 읽기 전용 `get_run.checks`는 전체 이력을 전달한다. 별도 타이머·push·UI 없이 적응된 클라이언트가 응답을 읽고 `check_replies`와 확인한 task 값을 보고해야 한다. 실제 원격 런타임 정보는 서버가 알아내지 않는다. [체크인 요구사항](requirements/decisions-integration.md#에이전트-체크인)과 [변경 010](changes/010-agent-check-ins.md)에서 확정 계약과 검증 상태를 관리한다.

등록된 Markdown은 읽기 전용으로 감시한다. `doc-changed` 공지는 화면을 갱신하고 다음 report가 이전 baseline과 diff를 반환한다. [문서 경계와 복구](requirements/documents.md)를 따른다.

MCP와 API는 localhost Host와 허용된 HTTP origin을 검사한다. Compose 공개 포트는 `127.0.0.1:4780:4780`이다. 워크스페이스를 같은 절대 경로에 읽기 전용으로 연결하며 DB만 `/data` named volume에 쓴다. 앱은 에이전트·터미널·에디터를 실행하지 않는다.

## 환경변수

| 이름 | 용도·기본값 |
| --- | --- |
| `WORKSPACE_ROOT` | 서버 실행 시 필수인 문서 접근 루트. Compose는 미설정 시 `${HOME}/orca` 사용 |
| `HOST` | Node 바인딩 주소, 기본 `127.0.0.1`; Docker 내부는 `0.0.0.0` |
| `PORT` | 기본 `4780`; 1–65535 정수 |
| `DB_PATH` | 기본 `./data/office.db`; Docker는 `/data/office.db` |
| `ASK_WAIT_MS` | ask 1회 대기, 기본 `100000`; 0 초과·300000 이하 |
| `OFFICE_DEV_ORIGIN` | Vite 개발 화면에 허용할 정확한 localhost HTTP origin |
| `OFFICE_URL` | replay 드라이버의 MCP 주소, 기본 `http://127.0.0.1:4780/mcp` |
| `MCP_TOOL_TIMEOUT` | Claude Code 프로세스의 MCP 도구 타임아웃. 검증 실행값 `325000` |

비밀값은 문서에 기록하지 않는다. 배포·클라이언트 설치 빠른 시작은 [README](../README.md)에 있다.

## 개발과 검증

Node 24와 npm을 사용합니다. 배포 경로는 Docker이며 아래 명령은 개발용입니다.

```sh
npm ci
npm run build
OFFICE_DEV_ORIGIN=http://localhost:5173 WORKSPACE_ROOT="$HOME/orca" npm run dev
```

별도 터미널에서 `npm run dev:web`을 실행하고 `http://localhost:5173`을 열면 Vite 개발 화면을 사용할 수 있습니다. `OFFICE_DEV_ORIGIN`은 개발 화면에서 보내는 요청을 허용하는 명시적 개발 설정입니다. Vite가 다른 포트로 시작하거나 `127.0.0.1`로 접속하면 브라우저의 실제 origin과 정확히 일치하도록 값을 바꾸고 백엔드를 다시 시작하세요. 검사와 fixture 재생은 다음과 같습니다.

```sh
npm run typecheck
npm test
npm run build
node scripts/replay.ts replay "$PWD" 3000
```

재생 명령은 실행 중인 앱에 fixture의 모든 진행 패치를 보내므로 실제 프로젝트 데이터에 데모 run이 생성됩니다. 출력에서 run id를 확인할 수 있습니다. 문서 변경도 보려면 마지막 인자로 워크스페이스 안의 Markdown 경로를 추가하고 run이 진행 중일 때 에디터로 수정하세요.

종료된 run에는 질문을 만들 수 없습니다. ask 검증에는 활성 run id를 사용합니다.

```sh
node scripts/replay.ts ask <active-run-id> "계속 진행할까요?" "진행" "중단"
node scripts/replay.ts ask <active-run-id> "계속 진행할까요?" "진행" "중단" --ask-id <pending-ask-id>
```

짧은 pending 재현은 별도 개발 서버와 동일한 드라이버 대기 설정으로 확인할 수 있습니다.

```sh
WORKSPACE_ROOT="$HOME/orca" PORT=4781 ASK_WAIT_MS=10000 npm start
# 별도 터미널
OFFICE_URL=http://127.0.0.1:4781/mcp ASK_WAIT_MS=10000 node scripts/replay.ts replay "$PWD" 0
```

위 재생이 완료되면 그 run은 종료됩니다. 질문 테스트는 별도 활성 run을 report로 만들거나 해당 run을 `stage: "수정"`으로 재개한 뒤 실행합니다. Docker의 대기 시간을 바꾸는 검증은 `ASK_WAIT_MS=10000 docker compose up -d`로도 가능합니다. SDK 드라이버의 pending/retry 성공은 실제 Claude Code 클라이언트의 타임아웃 검증을 대신하지 않습니다.

원본 progress.py와의 golden 비교는 저장소의 고정 fixture를 설치된 원본으로 재생하여 기대 JSON과 비교합니다. 인자가 없으면 BASIC_TEAM_DIR 또는 기본 설치 경로를 탐색하며, basic-team 경로를 명시할 수도 있습니다.

```sh
npm run golden
# 설치 경로를 명시할 때
npm run golden -- /absolute/path/to/basic-team
```


## 검증 범위

테스트는 patch 병합, 실제 경로 경계, DB 영속성, MCP/API, UI 상태·접근성 동작을 검증한다. golden은 설치된 원본 basic-team progress.py와 fixture 병합 결과를 비교한다. SDK 재생과 실제 Claude Code 실행 결과는 구분해서 [변경 기록](changes/001-office-team-reporter.md)에 남긴다. 독립 lint 스크립트는 현재 없으며 `typecheck`, 테스트, build를 사용한다.
