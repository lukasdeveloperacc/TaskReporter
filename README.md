# Office Team Reporter

basic-team 진행을 회사 사무실로 보여주는 로컬 관제실입니다. 터미널이 팀을 지휘하고 앱은 프로젝트별 층, 직원의 작업·검수, 결재 요청, 기획 변경과 업무 일지를 보여줍니다. 웹 UI와 Streamable HTTP MCP(`report`, `ask`)가 Node 프로세스 하나에서 실행됩니다.

## Docker 실행

Docker와 Compose가 필요합니다. 저장소에서 실행합니다.

```sh
cp .env.example .env
```

`.env`의 `WORKSPACE_ROOT`를 **실제로 존재하는 절대 경로**로 바꾸세요. 예: `/Users/me/orca`. `~` 대신 전체 경로를 씁니다. `.env`를 만들지 않거나 해당 변수를 비우면 `${HOME}/orca`가 기본값입니다.

```sh
docker compose up -d --build
docker compose logs -f office
```

브라우저에서 [사무실 열기](http://127.0.0.1:4780)를 선택합니다. 이후 시작은 `docker compose up -d`, 변경 후 재빌드는 `docker compose up -d --build`입니다. `restart: unless-stopped`로 재시작하며 프로젝트·run·결재는 `office-data` named volume에 보존됩니다. 중지는 `docker compose down`입니다. `down -v`는 저장 데이터를 삭제하므로 초기화할 때만 사용하세요.

포트는 호스트의 `127.0.0.1:4780`에만 공개됩니다. 컨테이너 내부의 `HOST=0.0.0.0`은 이 localhost 공개 포트를 위한 설정입니다. 워크스페이스는 호스트와 **같은 절대 경로**에 읽기 전용으로 연결합니다. 이 범위 밖의 프로젝트도 층과 진행은 표시되지만 기획서 열람·변경 감지는 불가능합니다. 기획서는 사용자 에디터에서 수정하고 앱에서는 읽습니다.

## Claude Code 연결

다음 등록 명령은 사용자의 Claude Code MCP 설정을 변경합니다. 앱을 먼저 실행한 다음 사용자가 연결할 환경에서 실행합니다.

```sh
claude mcp add --transport http --scope user office http://127.0.0.1:4780/mcp
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/skills/office-basic-team" "$HOME/.claude/skills/office-basic-team"
MCP_TOOL_TIMEOUT=325000 claude
```

기존 링크가 있으면 설치 위치를 확인한 뒤 사용하세요. 원본 lukas-plugin `basic-team`도 설치되어 있어야 합니다. Claude Code에서 `/office-basic-team <작업 요청>`으로 실행하거나 같은 스킬로 기존 작업을 재개합니다. 원본 basic-team은 수정하지 않습니다.

## Codex 연결

저장소에서 다음 명령으로 Docker의 같은 MCP 서버와 스킬을 등록합니다.

```sh
codex mcp add office --url http://127.0.0.1:4780/mcp
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/skills/office-basic-team" "${CODEX_HOME:-$HOME/.codex}/skills/office-basic-team"
```

`${CODEX_HOME:-$HOME/.codex}/config.toml`의 생성된 `office` 항목에 도구 제한 시간을 추가합니다. 서버의 295초 결재 대기보다 길어야 합니다. 단위는 초입니다. [Codex MCP 설정](https://developers.openai.com/codex/mcp/)을 참고하세요.

```toml
[mcp_servers.office]
url = "http://127.0.0.1:4780/mcp"
tool_timeout_sec = 325
```

등록 후 새 Codex 세션에서 `$office-basic-team <작업 요청>`을 사용합니다. 이미 실행 중인 세션은 MCP와 스킬을 다시 불러오도록 재시작합니다. 서버는 Docker가 실행하며 클라이언트는 HTTP로 연결합니다. 작업할 저장소에서 스킬을 호출하면 그 저장소가 프로젝트 층으로 보고됩니다. 일반 `basic-team` 호출에는 Office 보고가 자동으로 추가되지 않습니다.

## 진행 보고와 결재

`report`가 진행을 보내고 `ask`가 대표실에 결재 선택지를 만듭니다. 기본 대기는 295,000ms이며 답이 없으면 `pending`과 `ask_id`를 반환합니다. 스킬은 같은 id로 재호출합니다. 터미널에서 답하려면 Esc로 도구 대기를 끊고 채팅에 답하세요. 리더가 다음 report의 `close_ask_ids`로 앱의 서류를 닫습니다. 기획서 변경 diff가 보고되면 스킬이 재계획 여부를 묻습니다.

2026-10-19에 Claude Code 2.1.303, sonnet, `MCP_TOOL_TIMEOUT=325000` 환경에서 실제 ask가 약 295초 후 `pending`을 반환하고 같은 `ask_id` 재호출 뒤 브라우저 답변을 전달하는 흐름을 확인했습니다. 이 결과는 해당 실행 환경의 검증이며 모든 클라이언트·전송 idle 제한을 보장하지 않습니다. 전체 실행과 검증 상태는 [변경 기록](docs/changes/001-office-team-reporter.md)에 기록합니다.

도구가 없거나 Office 연결이 실패하면 스킬은 기존 `progress.py` HTML 방식으로 폴백합니다. 중간 전환에는 tasks·decisions·reviews 전체와 task 의존성을 먼저 복원합니다. run id와 사무실 링크는 작업 저장소의 `docs/inprogress/<task-slug>.office.json`에 보관합니다.

## 개발과 검증

Node 24와 npm을 사용합니다. 개발 서버·환경변수·fixture/ask 재생·golden 명령은 [시스템 아키텍처](docs/1-SYSTEM-ARCHITECTURE.md)에 있습니다. 기본 검증은 다음과 같습니다.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## 문서

- [제품 범위](docs/0-PRODUCT.md)
- [시스템 아키텍처와 실행·검증](docs/1-SYSTEM-ARCHITECTURE.md)
- [디자인 기준](docs/2-DESIGN.md)
- [데이터베이스와 보관 정책](docs/3-DATABASE.md)
- [사용자 흐름](docs/4-USERFLOW.md)
- [진행 보고·사무실](docs/requirements/progress-office.md), [결재·실행 연동](docs/requirements/decisions-integration.md), [기획서](docs/requirements/documents.md)
- [구현·검증 변경 기록](docs/changes/001-office-team-reporter.md), [문서 관리 규칙](docs/AGENTS.md)

## 에셋

픽셀 사무실은 [Kenney Roguelike Indoors](https://kenney.nl/assets/roguelike-indoors), 캐릭터는 [Kenney Roguelike Characters](https://kenney.nl/assets/roguelike-characters)를 사용합니다. 두 팩은 CC0이며 원본 라이선스는 배포 에셋과 함께 보존합니다. 역할·부서·직급은 `web/src/roles.json`에서 관리합니다. 3D·효과음·제품 리플레이·통계·원격 접속은 v1 범위에 포함하지 않습니다.
