# Chirpy 새 출발

공식 Chirpy Starter beffc88(v7.6.0)을 바탕으로 이름, GitHub 주소와 소개만 설정한 새 프로젝트입니다. 기존 공개 저장소와 글은 변경하지 않았습니다.

## 먼저 미리보기

압축을 새 폴더에 풉니다. Ruby 3.4 및 Bundler가 있는 환경에서 다음을 실행합니다.

```sh
bundle install
bundle exec jekyll serve --drafts
```

홈, 카테고리, 태그, 아카이브와 예시 글을 확인하세요. 예시 글은 _drafts의 미리보기 전용이므로 기본 빌드에 게시되지 않습니다. assets/lib는 공식 서브모듈의 파일을 포함한 상태이므로 별도 서브모듈 설치가 필요 없습니다.

## GitHub에서 따로 시험하기

기존 geon0407.github.io 저장소에 덮어쓰지 마세요. 예를 들어 새 저장소 blog-preview를 사용하면 _config.yml에서 baseurl을 "/blog-preview"로 바꾸세요. 압축 안의 파일을 저장소의 루트에 반영하고 Settings → Pages → Source에서 GitHub Actions를 선택합니다. 숨김 경로 .github/workflows/pages-deploy.yml이 누락되지 않았는지 확인합니다. 이후 Actions → Build and Deploy를 실행합니다.

이 버전의 메인은 Chirpy 기본 글 목록입니다. 기존 소개형 홈을 연결할지, 어떤 색을 사용할지와 비공개 글 편집기 연동은 테마를 본 뒤 별도로 결정합니다.
