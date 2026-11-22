# 김건형의 개인 홈페이지

구릿빛 포인트의 소개·프로젝트·기술 노트·일기 사이트. Python으로 Markdown을 정적 HTML로 변환하고 GitHub Pages에 배포합니다. 방문자 서버나 데이터베이스는 필요하지 않습니다.

## 처음 배포하기 (GitHub 웹)

1. GitHub에서 **geon0407.github.io**라는 새 public 저장소를 만듭니다. 기존 Algorithm_Practice는 그대로 둡니다.
2. 압축을 푼 `geon-blog` 폴더 **안의 내용**을 저장소 루트에 올립니다. `build.py`, `site.json`, `content`, `assets` 등이 최상단에 있어야 합니다. `dist`는 업로드할 필요가 없습니다.
3. `.github/workflows/pages.yml`이 업로드되었는지 꼭 확인합니다. 숨김 폴더가 빠지면 Add file → Create new file에서 경로를 `.github/workflows/pages.yml`로 입력하고 파일 내용을 붙여 넣습니다.
4. Settings → Pages → Build and deployment → Source에서 **GitHub Actions**를 선택합니다.
5. Actions → Deploy blog → Run workflow로 실행합니다. 성공하면 `https://geon0407.github.io`에서 확인합니다.

다른 저장소 이름이면 site.json의 `base_path`를 `/저장소이름`으로 바꿉니다. url은 `https://geon0407.github.io`로 유지합니다.

## 무엇을 수정하나요?

- 소개 본문: `content/about.md`
- 이름·소속·연락처·사진: `site.json`
- 색상·여백: `assets/style.css`의 색상 변수
- 프로젝트: `content/projects/*.md`
- 기술 글: `content/notes/*.md`
- 일기: `content/journal/*.md`

사진은 `assets/images` 폴더를 만들어 넣고 site.json의 photo에 `assets/images/profile.jpg`처럼 경로를 적습니다. 이미지가 없으면 가짜 프로필 사진이나 빈 자리 없이 이름과 소속만 표시합니다.

## 새 글 쓰기

`examples/journal.md`를 복사해 `content/journal/wbc-trip.md`처럼 영문 파일명으로 저장하세요. 제목은 한국어여도 됩니다. 파일명은 게시 주소가 되므로 게시 후에는 가급적 바꾸지 마세요.

```yaml
---
title: 글 제목
date: 2026-11-23
summary: 짧은 소개
tags: [야구, 여행]
draft: true
cover: ""
location: ""
---
```

본문은 일반 Markdown입니다. 코드 블록, 표, 이미지, 제목이 지원됩니다. 기술 글의 제목은 목차가 됩니다. 수식은 블록 `$$ ... $$`, 인라인 `\( ... \)`를 쓰세요. 수식 렌더링은 jsDelivr의 KaTeX를 불러옵니다(인터넷 연결 필요).

이미지: `![설명]({{base}}/assets/images/photo.jpg)`

`draft: true`는 빌드·검색·사이트맵에서 제외됩니다. 검토가 끝나면 false로 바꾸세요. **공개 저장소의 초안 소스는 누구나 볼 수 있습니다. 비공개 연구나 개인 정보는 저장소에 올리지 마세요.**

현재 기술 글은 검토용 초안입니다. WBC·학회 방문을 실제 경험처럼 만들어 올리지 않았으며, 일기는 처음에 빈 목록으로 표시됩니다. 프로젝트 소개와 자기소개도 공개 전 확인하세요.

## 로컬 실행

Python 3.12 이상:

```sh
python -m pip install -r requirements.txt
python build.py --drafts
python -m http.server 8000 --directory dist
```

브라우저에서 http://localhost:8000 을 엽니다. 실제 공개 빌드는 `python build.py`입니다. dist는 매번 새로 생성되므로 직접 수정하지 마세요.

## 테마와 기능

- 자동 모드: 시스템 설정과 변경을 따라갑니다.
- 라이트·다크: 방문자 선택을 브라우저에 저장합니다. 자동을 누르면 저장 설정을 해제합니다.
- 저장이 차단되어도 현재 페이지의 테마 전환은 동작합니다.
- 페이지별 고유 URL, 목록 검색·태그 필터, 기술 글 목차, 코드 강조·복사, 수식, 모바일 레이아웃, sitemap.xml, 기본 메타데이터를 제공합니다.
- 검색은 현재 목록의 제목·요약·태그를 대상으로 합니다.
- 코드 복사는 HTTPS 또는 localhost에서 지원되는 브라우저에서 동작합니다.

## 배포 상태

이 패키지는 로컬 빌드 검증을 마친 소스입니다. GitHub 저장소 생성·업로드 및 공개 배포는 아직 수행하지 않았습니다.
