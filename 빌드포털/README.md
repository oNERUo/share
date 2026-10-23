# Another Hero 빌드 포털

Unity WebGL 빌드 zip을 올리면 GitHub Pages에서 바로 실행되는 팀 공유 사이트입니다.
서버 없이 GitHub만 사용합니다.

```
build-portal/
├─ index.html     화면 구조
├─ style.css      디자인
├─ app.js         업로드 / 목록 / 삭제 로직 (GitHub API)
├─ builds.json    빌드 목록 (자동 갱신되니 직접 수정하지 않기)
├─ .nojekyll      GitHub Pages가 파일을 가공하지 않게 하는 빈 파일 (지우지 말 것)
└─ builds/        업로드된 빌드가 풀려 저장되는 곳 (자동 생성)
```

---

## 1. 레포 만들기 (1회, 관리자 1명)

1. GitHub에서 **New repository**를 누르고 이름을 정합니다. 예: `anotherhero-builds`
2. **Public**으로 만듭니다. 무료 계정의 GitHub Pages는 공개 레포에서만 쓸 수 있습니다.
3. **Add a README file**을 체크해서 만듭니다. 빈 레포면 업로드가 실패합니다.
4. 이 폴더의 파일을 모두 레포에 올립니다. `.nojekyll`도 포함해야 합니다.
   - 웹에서 올릴 때: **Add file → Upload files**로 드래그합니다. `.nojekyll`이 숨김 파일이라 안 보이면 **Add file → Create new file**로 이름만 `.nojekyll`인 빈 파일을 만드세요.
5. **Settings → Pages**에서 **Source**를 **Deploy from a branch**, **Branch**를 `main` / `(root)`로 하고 Save를 누릅니다.
6. 1~2분 뒤 `https://<아이디>.github.io/<레포이름>/` 주소로 접속되면 완료입니다.

## 2. 업로드할 사람: 토큰 만들기 (각자 1회)

빌드를 **보기만** 하는 팀원은 이 단계가 필요 없습니다.

1. GitHub에서 프로필 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**으로 들어갑니다.
2. 다음과 같이 설정합니다.
   - **Expiration**: 프로젝트 기간에 맞게 설정 (예: 90일)
   - **Resource owner**: 레포를 소유한 계정 또는 조직
   - **Repository access**: **Only select repositories**에서 이 레포만 선택
   - **Permissions → Repository permissions → Contents**: **Read and write**
3. 생성된 `github_pat_...` 토큰을 복사합니다. 토큰은 다시 볼 수 없습니다.
4. 사이트에서 **⚙ 업로드 설정**을 열고 owner, repo, 브랜치(`main`), 토큰을 입력한 뒤 **연결 테스트**와 **저장**을 누릅니다.

> 다른 사람 레포에 올리려면 레포 주인이 **Settings → Collaborators**에서 초대해야 합니다. 조직(Organization)으로 만들면 관리가 편합니다.
> 토큰은 각자 브라우저에만 저장됩니다. 공용 PC에서는 사용 후 **토큰 지우기**를 누르세요.

## 3. Unity 빌드 설정 (개발 담당)

`File > Build Profiles > Web` → **Player Settings > Publishing Settings**

| 항목 | 설정 | 이유 |
|---|---|---|
| Compression Format | **Gzip** | GitHub 파일 한도(100MB)를 넘지 않게 용량을 줄입니다 |
| Decompression Fallback | **체크 (필수)** | GitHub Pages는 압축 헤더를 설정할 수 없어서, 이 옵션이 없으면 실행되지 않습니다 |
| Name Files As Hashes | 해제 | 파일명이 고정되어 관리가 쉽습니다 |

빌드 결과 폴더(`index.html`, `Build/`, `TemplateData/`가 있는 폴더)를 zip으로 묶어 업로드하거나, **📁 폴더로 선택**으로 폴더를 그대로 고르면 됩니다.

## 4. 사용 방법

- **업로드**: zip을 끌어다 놓고 이름, 올린 사람, 메모를 적은 뒤 **업로드**를 누릅니다. 1~2분 뒤 실행할 수 있습니다.
- **실행**: 목록에서 **▶ 실행**을 누릅니다. 새 탭에서 게임이 열립니다.
- **공유**: **링크 복사**로 복사한 주소를 팀 채팅방에 붙여넣습니다.
- **삭제**: 토큰을 등록한 사람에게만 **삭제** 버튼이 보입니다.

## 5. 제한 사항

| 항목 | 한도 | 대처 |
|---|---|---|
| 파일 1개 크기 | 100MB | Gzip 압축 사용 |
| 레포 전체 크기 | 1GB 권장 | 오래된 빌드를 주기적으로 **삭제** |
| Pages 트래픽 | 월 100GB 정도 | 팀 내부 공유 용도로는 충분합니다 |
| 공개 범위 | 주소를 아는 사람은 누구나 볼 수 있음 | 주소를 외부에 올리지 않기 |

> 삭제해도 Git 기록에는 남기 때문에 레포 용량이 바로 줄지는 않습니다. 용량이 1GB에 가까워지면 레포를 새로 만드는 게 가장 간단합니다.

## 6. 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| 실행하면 흰 화면 또는 "Unable to parse Build/..." 오류 | Decompression Fallback이 꺼져 있습니다. 켜고 다시 빌드하세요 |
| 실행하면 404 | 업로드 직후라 아직 배포 중입니다. 1~2분 기다리세요 (레포의 **Actions** 탭에서 진행 확인 가능) |
| 업로드 시 401 / 403 | 토큰 만료 또는 Contents 권한 부족 |
| 업로드 시 404 | owner, repo 이름 오타 또는 토큰에 레포가 선택되지 않음 |
| 업로드 시 409 | 레포가 비어 있습니다. README를 하나 커밋하세요 |
| "100MB 넘는 파일" 경고 | Compression Format을 Gzip으로 바꾸세요 |
