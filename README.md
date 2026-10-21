# Office Team Reporter

basic-team 진행을 회사 사무실로 보여주는 로컬 관제실입니다. 터미널이 팀을 지휘하고 앱은 프로젝트별 층, 직원의 작업·검수, 결재 요청, 기획 변경과 업무 일지를 보여줍니다. 웹 UI와 Streamable HTTP MCP(`report`, `ask`, `get_run`)가 Node 프로세스 하나에서 실행됩니다.

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

첫 `report`에서 받은 `run_id`를 이후 보고·질문·조회에 재사용합니다. `close_ask_ids`는 `patch` 밖 최상위 인자이며, stage는 계획·구현·리뷰·수정·마무리·완료·중단으로 시작합니다. task는 id, decision은 title, review는 round+reviewer로 병합합니다. owner가 좌석을 정하며 `reviewer-*`는 감사팀, `plan-*`는 회의실에 배치합니다. model은 전체 모델 ID, effort는 host에서 확인한 값만 보내고 모르면 생략합니다.

타입이 있는 strict 스키마로 알 수 없는 필드를 거부하며, `ask.recommended`는 options 안에 있어야 합니다. `report` 응답은 병합된 `state`와 `ended_at`을 포함하고, 읽기 전용 `get_run({run_id})`으로 해당 실행과 pending 질문을 조회합니다.

### 에이전트 체크인

이 저장소에 로컬 구현된 계약입니다. 전체 검사와 독립 리뷰는 진행 기록에서 확인해야 합니다. 배포된 `latest` 이미지 반영과 실제 Claude/Codex 호스트 대응을 확인한 결과는 아닙니다. 아래 예제의 `<...>`는 응답 ID·실제 경로·관찰값으로 바꿔야 하는 자리표시입니다.

`report`는 진행중 작업이 30분 이상 변하지 않거나 model·effort가 누락되면 `checks`로 설명을 요청합니다. 누락 요청은 기다리지 않고 보고 시점에 만들며 타이머나 에이전트 깨우기는 없습니다. 응답의 추가 필드 예시는 다음과 같습니다.

```json
{
  "run_id": "<report에서 받은 run_id>",
  "checks": [{
    "id": "<check ID>",
    "run_id": "<report에서 받은 run_id>",
    "task_id": "BE",
    "owner": "backend-agent",
    "question": "누락된 model·effort를 실제 런타임 근거로 확인해 보고하고 설명을 답해주세요.",
    "status": "pending",
    "created_at": "2026-10-21T00:00:00.000Z",
    "answer": null,
    "responded_at": null
  }]
}
```

적응된 클라이언트/basic-team은 `checks`를 읽고 해당 담당자의 런타임 근거를 확인한 뒤 다음 `report`에 실제 값을 보충하고 명시적으로 답해야 합니다. 다음은 확인에 성공한 경우의 입력 예시입니다.

```json
{
  "project_path": "<프로젝트 절대 경로>",
  "run_id": "<report에서 받은 run_id>",
  "patch": {"tasks": [{"id": "BE", "model": "<런타임에서 확인한 전체 모델 ID>", "effort": "<런타임에서 확인한 effort>"}]},
  "check_replies": [{"check_id": "<check ID>", "answer": "해당 담당자의 런타임 기록에서 model과 effort를 확인해 함께 보고했습니다."}]
}
```

확인할 수 없으면 모르는 필드는 생략하고 실제 이유를 설명합니다. 다음 이유도 해당 환경에서 사실인 경우에만 사용합니다. 기본값이나 요청받은 설정을 관찰값으로 대신 보내지 않습니다.

```json
{
  "project_path": "<프로젝트 절대 경로>",
  "run_id": "<report에서 받은 run_id>",
  "patch": {},
  "check_replies": [{"check_id": "<check ID>", "answer": "현재 호스트가 해당 담당자의 실제 model·effort 런타임 기록을 제공하지 않아 확인할 수 없습니다."}]
}
```

값 보충·요청 수신만으로 요청은 닫히지 않으며 ID와 설명의 수락이 필요합니다. 미응답 요청은 같은 ID로 반복됩니다. 유효 응답은 설명을 저장하고 30분 재요청 쿨다운을 적용하지만 작업 완료·정상 작동을 입증하지 않습니다. 동일 응답 재전송은 쿨다운을 연장하지 않습니다. `report.checks`는 pending만, 읽기 전용 `get_run.checks`는 전체 이력을 반환합니다. 기존 클라이언트는 새 입력 없이 계속 보고할 수 있지만 호스트나 설치된 외부 basic-team이 자동으로 대응한다고 보장하지 않습니다. 이 변경은 외부 스킬을 수정하지 않습니다. 상세 수명주기·오류는 [체크인 요구사항](docs/requirements/decisions-integration.md#에이전트-체크인), 실제 반영·검증 상태는 [변경 010](docs/changes/010-agent-check-ins.md)을 따릅니다.

체크인 질문에 남은 TODO가 있으면 최신 작업 목록을 읽고 실제 업무를 해결한 뒤 `done:true`를 보고합니다. 미완료 TODO가 있는 task 완료와 명시/자동 run 완료는 거부합니다. 명시적인 run 중단은 비성공 종료이며 TODO를 자동 완료하지 않습니다. 사무실 UI에는 엘리베이터까지 걸어간 뒤 층 선택을 여는 동작과 층/run 전환의 전체/일반 보기 유지가 로컬 반영되었습니다. UI 대상 검사 4개 파일·80개 테스트는 통과했으며 전체 검사·독립 리뷰 결과는 변경 010의 실행 증거를 따릅니다.

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
