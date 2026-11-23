# Blog Studio

블로그 글과 사이트 설정을 편집·발행하는 개인용 도구입니다.

- `server.py`, `web/` — Codespaces에서 실행하는 버전 (`bash tools/blog-studio/start.sh`)
- `webapp/` — 브라우저 버전. 빌드 결과는 `site/studio/`에 들어갑니다.

## 개발

이 폴더에서 실행합니다.

~~~bash
npm ci
npm run build        # Codespaces 버전 편집기 번들
npm run build:web    # 브라우저 버전
npm run test:web     # 브라우저 버전 테스트
.venv/bin/python -m unittest discover -s tests   # Codespaces 버전 테스트
~~~
