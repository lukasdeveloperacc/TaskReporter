# Office Team Reporter

basic-team 진행을 회사 사무실로 보여주는 로컬 관제실입니다. 터미널이 팀을 지휘하고 앱은 프로젝트별 층, 직원의 작업·검수, 결재 요청, 기획 변경과 업무 일지를 보여줍니다. 웹 UI와 Streamable HTTP MCP(`report`, `ask`)가 Node 프로세스 하나에서 실행됩니다.

## 실행과 연결

[lukas-plugin](https://github.com/lukasdeveloperacc/PersonalAgentPlugins)이 이 앱을 Docker MCP로 실행하고, 같은 플러그인의 `basic-team` 스킬이 진행을 보고합니다. Docker가 실행 중이어야 합니다.

1. lukas-plugin을 설치한 Claude Code 또는 Codex에서 `office MCP 켜줘`라고 요청합니다. `mcp-setup` 스킬이 MCP(`http://127.0.0.1:4780/mcp`)를 등록하고 `ghcr.io/lukasdeveloperacc/taskreporter:latest`로 `lukas-office` 컨테이너를 `--restart unless-stopped`로 띄웁니다. 데이터는 `taskreporter_office-data` volume에 보존됩니다.
2. 워크스페이스는 `WORKSPACE_ROOT`(lukas-plugin 기본 `$HOME`)를 호스트와 **같은 절대 경로**에 읽기 전용으로 연결합니다. 다른 경로를 쓰려면 MCP를 켜기 전에 `WORKSPACE_ROOT`를 export합니다. 이 범위 밖의 프로젝트도 층과 진행은 표시되지만 기획서 열람·변경 감지는 불가능합니다.
3. 결재 대기(295초)보다 도구 제한 시간이 길어야 합니다. Claude는 `MCP_TOOL_TIMEOUT=325000 claude`로 시작하고, Codex는 `${CODEX_HOME:-$HOME/.codex}/config.toml`의 `[mcp_servers.office]`에 `tool_timeout_sec = 325`를 둡니다([Codex MCP 설정](https://developers.openai.com/codex/mcp/)).
4. 새 세션에서 Claude는 `/basic-team <작업 요청>`, Codex는 `$basic-team <작업 요청>`으로 실행합니다. office 도구가 있으면 basic-team이 Office 모드로 보고합니다. 작업할 저장소가 프로젝트 층으로 등록됩니다.

브라우저에서 [사무실 열기](http://127.0.0.1:4780)를 선택합니다. 이미지를 갱신하려면 `docker pull ghcr.io/lukasdeveloperacc/taskreporter:latest` 후 office MCP를 끄고 다시 켭니다. MCP를 끄면 컨테이너만 지우고 volume은 남깁니다. 포트는 호스트의 `127.0.0.1:4780`에만 공개되며 컨테이너 내부의 `HOST=0.0.0.0`은 이 localhost 공개 포트를 위한 설정입니다.

main에 push하면 [docker 워크플로](.github/workflows/docker.yml)가 amd64·arm64 이미지를 GHCR에 올립니다.

## 저장소에서 직접 실행

개발 중인 코드를 띄울 때는 Compose를 사용합니다. `lukas-office`와 같은 포트·volume을 쓰므로 먼저 `docker rm -f lukas-office`로 내립니다(volume은 유지).

```sh
cp .env.example .env   # WORKSPACE_ROOT를 실제 절대 경로로 수정
docker compose up -d --build
docker compose logs -f office
```

`.env`가 없거나 `WORKSPACE_ROOT`가 비어 있으면 `${HOME}/orca`가 기본값입니다. 중지는 `docker compose down`입니다. `down -v`는 저장 데이터를 삭제하므로 초기화할 때만 사용하세요. 4780에서 서버가 이미 응답하면 lukas-plugin은 새 컨테이너를 띄우지 않고 그 서버를 사용합니다.

## 진행 보고와 결재

`report`가 진행을 보내고 `ask`가 대표실에 결재 선택지를 만듭니다. 기본 대기는 295,000ms이며 답이 없으면 `pending`과 `ask_id`를 반환합니다. 스킬은 같은 id로 재호출합니다. 터미널에서 답하려면 Esc로 도구 대기를 끊고 채팅에 답하세요. 리더가 다음 report의 `close_ask_ids`로 앱의 서류를 닫습니다. 기획서 변경 diff가 보고되면 basic-team이 재계획 여부를 묻습니다.

2026-10-19에 Claude Code 2.1.303, sonnet, `MCP_TOOL_TIMEOUT=325000` 환경에서 실제 ask가 약 295초 후 `pending`을 반환하고 같은 `ask_id` 재호출 뒤 브라우저 답변을 전달하는 흐름을 확인했습니다. 이 결과는 해당 실행 환경의 검증이며 모든 클라이언트·전송 idle 제한을 보장하지 않습니다. 전체 실행과 검증 상태는 [변경 기록](docs/changes/001-office-team-reporter.md)에 기록합니다.

도구가 없거나 Office 연결이 실패하면 basic-team은 기존 `progress.py` HTML 방식으로 폴백합니다. 중간 전환에는 tasks·decisions·reviews 전체와 task 의존성을 먼저 복원합니다. run id와 사무실 링크는 작업 저장소의 `docs/inprogress/<task-slug>.office.json`에 보관합니다.

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
