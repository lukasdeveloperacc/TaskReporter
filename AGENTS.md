# TaskReporter

이 문서는 루트 바로 아래 항목의 역할만 간결하게 유지한다. 상세 설명과 규칙은 각 디렉터리의 `AGENTS.md`에서 관리한다.

- `README.md`: 프로젝트 소개와 Docker 실행·Claude Code 연결 방법.
- `docs/`: 제품·설계·요구사항·변경 문서. 규칙은 `docs/AGENTS.md`.
- `.gitignore`·`.dockerignore`: Git·Docker 추적 제외 설정.
- `.env.example`: `WORKSPACE_ROOT` 등 환경변수 예시.
- `Dockerfile`·`docker-compose.yml`: localhost 전용 컨테이너 이미지와 실행·SQLite 볼륨 설정.
- `package.json`·`package-lock.json`: 의존성과 스크립트(`dev`, `build`, `test`, `typecheck`, `golden`).
- `tsconfig.json`: TypeScript 설정.
- `vite.config.ts`·`index.html`: 웹 빌드 설정·진입 HTML과 vitest 설정.
- `server/`: Node 서버. Express 웹 API, MCP `report`·`ask`, 진행 patch 병합, 기획서 읽기, SQLite 저장. `fixtures/`는 progress 예제와 기대 결과.
- `shared/`: 서버·웹 공용 계약(타입, `PORT`·`ASK_WAIT_MS`·`STALE_MS` 등).
- `web/`: React 앱. `src/`는 로비·사무실·직접 둘러보기 화면과 `roles.json`, `public/sprites/`는 Kenney 픽셀 에셋.
- `scripts/`: `golden.sh`(원본 progress.py와 병합 결과 비교), `replay.ts`(MCP fixture·ask 재생).

테스트는 별도 폴더 없이 각 소스 옆의 `*.test.ts(x)`에 둔다.
