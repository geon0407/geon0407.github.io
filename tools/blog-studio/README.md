# Blog Studio

공개 GitHub Pages와 분리된 개인 편집 화면입니다. 접근은 Codespaces의 Private 포트와 터미널에 표시되는 관리 키로 제한합니다. 키가 포함된 주소는 공유하지 마세요.

## 시작

1. 저장소의 Codespaces에서 `main`을 열고 `bash tools/blog-studio/start.sh`를 실행합니다.
2. Ports 탭에서 8787 포트가 **Private**인지 확인한 뒤 터미널에 표시된 관리 화면 주소를 새 탭에 엽니다. 401이 나오면 Codespaces를 연 GitHub 계정으로 같은 브라우저에 로그인했는지 확인하고 Ports 탭에서 포트를 먼저 엽니다.
3. 미리보기와 발행에는 이 Codespace에 기존 Jekyll 빌드 환경이 필요합니다. 먼저 기존 사이트의 `npm ci`, Ruby/Bundler 및 `site/Gemfile` 의존성 설치를 마치고 `npm run build`가 정상 동작하는지 확인하세요.

## 작성과 발행

- 게시글/프로젝트: 새 글 → 작성 → 초안 저장 → 공개할 글로 저장 → 발행.
- 사이트 설정: 변경 저장 → 사이트 미리보기 → 발행. 미리보기는 안전을 위해 사이트 스크립트를 실행하지 않습니다.
- 첨부파일은 파일당 20MB까지이며, 공개할 글이나 저장된 설정에서 참조한 파일만 빌드·발행에 포함합니다. 초안과 백업은 현재 Codespace에 저장되므로 Codespace 삭제 전 필요한 초안은 별도로 내보내세요.
- 발행은 기존 GitHub 인증으로 main에 커밋·푸시하고 Actions가 배포합니다. 원격 변경이나 빌드 오류가 있으면 발행을 중단합니다.
- 시각 편집기가 표현하지 못하는 특수 Markdown은 원문 모드에서 유지하세요.

편집기 번들을 갱신할 때만 이 폴더에서 `npm ci && npm run build`를 실행합니다.
