# geon0407.github.io

김건형의 개인 블로그 겸 포트폴리오입니다. → https://geon0407.github.io

CloudCannon의 [Vonge](https://github.com/CloudCannon/vonge-jekyll-bookshop-template) Jekyll 템플릿(MIT)을 바탕으로, 한/영 전환·다크 모드·GIST 색상 테마를 더하고 개인 편집기(Blog Studio)를 붙였습니다.

## 구조

- `site/` — Jekyll 소스 (`_config.yml`, `_data/studio.yml`, `collections/`의 페이지·게시글·프로젝트)
- `component-library/` — Bookshop 컴포넌트와 SCSS
- `tools/blog-studio/` — 비공개 편집·발행 도구 ([사용법](tools/blog-studio/README.md))
- `.github/workflows/pages-deploy.yml` — `main` 푸시 시 GitHub Pages 배포

## 로컬 실행

~~~bash
npm ci                 # Bookshop 의존성
npm run jekyll:install # Ruby/Bundler 의존성
npm start              # http://localhost:6060
npm run build          # _site/ 로 빌드
~~~

## 라이선스

템플릿 원본은 [LICENSE](LICENSE)(MIT, CloudCannon)를 따릅니다.
