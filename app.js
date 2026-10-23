/* ═══════════════════════════════════════════════════════════════
   Another Hero 빌드 포털 - 동작 로직
   ───────────────────────────────────────────────────────────────
   흐름 요약
   1) 사용자가 Unity WebGL 빌드 zip(또는 폴더)을 선택
   2) 브라우저에서 zip을 풀고, 파일마다 GitHub에 blob(파일 데이터)으로 업로드
   3) builds/<빌드ID>/ 경로에 파일들을 넣고 builds.json 목록도 갱신하는
      "커밋 1개"를 만들어 브랜치에 반영
   4) GitHub Pages가 자동으로 다시 배포 → 1~2분 뒤 목록에서 실행 가능

   서버 없이 GitHub API(Git Data API)만 사용합니다.
   토큰은 각자 브라우저 localStorage에만 저장됩니다.
   ═══════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ───────── 상수 ───────── */
  const STORAGE_KEY = 'ah-build-portal-config';   // 설정 저장 키 (localStorage)
  const BUILDS_DIR = 'builds';                     // 빌드가 저장될 폴더
  const LIST_FILE = 'builds.json';                 // 빌드 목록 파일
  const MAX_FILE_BYTES = 100 * 1024 * 1024;        // GitHub 단일 파일 한도 100MB
  const UPLOAD_CONCURRENCY = 4;                    // 동시에 올릴 파일 수
  const COMMIT_RETRY = 3;                          // 동시 업로드 충돌 시 재시도 횟수
  const API = 'https://api.github.com';

  /* ───────── 화면 요소 ───────── */
  const $ = (id) => document.getElementById(id);
  const el = {
    btnSettings: $('btnSettings'), dlg: $('dlgSettings'),
    cfgOwner: $('cfgOwner'), cfgRepo: $('cfgRepo'), cfgBranch: $('cfgBranch'), cfgToken: $('cfgToken'),
    cfgResult: $('cfgResult'), btnTest: $('btnTest'), btnClear: $('btnClear'), btnSave: $('btnSave'),
    needToken: $('needToken'), dropZone: $('dropZone'), fileZip: $('fileZip'), fileFolder: $('fileFolder'),
    pickedInfo: $('pickedInfo'), inTitle: $('inTitle'), inUploader: $('inUploader'), inMemo: $('inMemo'),
    btnUpload: $('btnUpload'), progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressText: $('progressText'),
    btnRefresh: $('btnRefresh'), buildList: $('buildList'), emptyMsg: $('emptyMsg'), toast: $('toast'),
  };

  /* ───────── 상태 ───────── */
  let picked = null;      // 선택된 빌드: { files: [{path, size, base64()}], sourceName }
  let busy = false;       // 업로드/삭제 진행 중 여부 (중복 클릭 방지)

  /* ═════════ 1. 설정 (레포 정보 + 토큰) ═════════ */

  // 저장된 설정 읽기. 저장값이 없으면 현재 주소(owner.github.io/repo)에서 추측
  function loadConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { saved = {}; }
    const guess = guessRepoFromLocation();
    return {
      owner: saved.owner || guess.owner || '',
      repo: saved.repo || guess.repo || '',
      branch: saved.branch || 'main',
      token: saved.token || '',
      uploader: saved.uploader || '',
    };
  }

  // 설정 저장 (localStorage가 막힌 환경에서도 에러 없이 넘어가도록 try/catch)
  function saveConfig(cfg) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* 저장 불가 환경 */ }
  }

  // https://<owner>.github.io/<repo>/ 형태의 주소에서 owner, repo 추출
  function guessRepoFromLocation() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return {};
    const repo = location.pathname.split('/').filter(Boolean)[0] || `${m[1]}.github.io`;
    return { owner: m[1], repo };
  }

  let config = loadConfig();
  const hasToken = () => !!(config.token && config.owner && config.repo);

  // 설정 모달 열기
  el.btnSettings.addEventListener('click', () => {
    el.cfgOwner.value = config.owner;
    el.cfgRepo.value = config.repo;
    el.cfgBranch.value = config.branch;
    el.cfgToken.value = config.token;
    el.cfgResult.textContent = '';
    el.dlg.showModal();
  });

  // 모달 입력값 → config 객체
  function readConfigForm() {
    return {
      ...config,
      owner: el.cfgOwner.value.trim(),
      repo: el.cfgRepo.value.trim(),
      branch: el.cfgBranch.value.trim() || 'main',
      token: el.cfgToken.value.trim(),
    };
  }

  // 저장 버튼
  el.btnSave.addEventListener('click', () => {
    config = readConfigForm();
    saveConfig(config);
    updateUploadState();
    toast('설정을 저장했습니다.', 'ok');
  });

  // 토큰 지우기 (공용 PC에서 쓴 뒤 정리용)
  el.btnClear.addEventListener('click', () => {
    el.cfgToken.value = '';
    config = { ...readConfigForm(), token: '' };
    saveConfig(config);
    updateUploadState();
    el.cfgResult.textContent = '토큰을 지웠습니다.';
  });

  // 연결 테스트: 레포 접근 + 쓰기 권한 확인
  el.btnTest.addEventListener('click', async () => {
    const test = readConfigForm();
    el.cfgResult.textContent = '확인 중…';
    try {
      const info = await gh('GET', `/repos/${test.owner}/${test.repo}`, null, test);
      await gh('GET', `/repos/${test.owner}/${test.repo}/git/ref/heads/${encodeURIComponent(test.branch)}`, null, test);
      const canPush = info.permissions ? info.permissions.push : true;
      el.cfgResult.textContent = canPush
        ? `✅ 연결 성공: ${info.full_name} (${test.branch} 브랜치, 쓰기 가능)`
        : '⚠ 레포는 보이지만 쓰기 권한이 없습니다. 토큰의 Contents 권한을 Read and write로 설정하세요.';
    } catch (err) {
      el.cfgResult.textContent = '❌ ' + err.message;
    }
  });

  /* ═════════ 2. GitHub API 호출 도우미 ═════════ */

  // GitHub REST API 호출. 실패하면 이해하기 쉬운 한국어 메시지로 에러를 던짐
  async function gh(method, path, body, cfg = config) {
    const res = await fetch(API + path, {
      method,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;              // 내용 없는 성공 응답
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(explainError(res.status, data.message));
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // HTTP 상태 코드별 안내 문구
  function explainError(status, msg) {
    const raw = msg ? ` (${msg})` : '';
    if (status === 401) return '토큰이 잘못되었거나 만료되었습니다.' + raw;
    if (status === 403) return '권한이 없거나 API 호출 한도를 넘었습니다. 토큰 권한(Contents: Read and write)을 확인하세요.' + raw;
    if (status === 404) return '레포 또는 브랜치를 찾을 수 없습니다. owner/repo/브랜치 이름과 토큰의 레포 선택을 확인하세요.' + raw;
    if (status === 409) return '레포가 비어 있습니다. README 등 파일을 하나 먼저 커밋해 주세요.' + raw;
    if (status === 422) return '요청이 거부되었습니다. 파일이 너무 크거나 동시에 다른 업로드가 진행 중일 수 있습니다.' + raw;
    return `GitHub 오류 ${status}` + raw;
  }

  // 문자열(UTF-8, 한글 포함) → base64
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // File/Blob → base64 (브라우저 내장 기능 사용, 큰 파일도 빠름)
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /* ═════════ 3. 빌드 목록 읽기 / 표시 ═════════ */

  // builds.json 읽기
  // - 토큰이 있으면 API로 읽음 (방금 올린 것도 바로 보임)
  // - 없으면 Pages에 배포된 파일을 읽음 (보기 전용 팀원)
  async function fetchBuildList() {
    if (hasToken()) {
      try {
        const res = await fetch(`${API}/repos/${config.owner}/${config.repo}/contents/${LIST_FILE}?ref=${encodeURIComponent(config.branch)}`, {
          headers: { 'Authorization': `Bearer ${config.token}`, 'Accept': 'application/vnd.github.raw+json' },
        });
        if (res.status === 404) return [];
        if (res.ok) return normalizeList(await res.json());
      } catch (e) { /* API 실패 시 아래 Pages 방식으로 대체 */ }
    }
    const res = await fetch(`${LIST_FILE}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return [];
    return normalizeList(await res.json());
  }

  // 목록 형식 보정 + 최신순 정렬
  function normalizeList(data) {
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.builds) ? data.builds : []);
    return arr.filter((b) => b && b.id).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }

  // 목록 화면 그리기
  async function renderList() {
    el.buildList.innerHTML = '<li class="muted">불러오는 중…</li>';
    let list = [];
    try { list = await fetchBuildList(); } catch (e) { list = []; }
    el.buildList.innerHTML = '';
    el.emptyMsg.hidden = list.length > 0;

    list.forEach((b, i) => {
      const playUrl = `${BUILDS_DIR}/${encodeURIComponent(b.id)}/index.html`;
      const li = document.createElement('li');
      li.className = 'item' + (i === 0 ? ' latest' : '');
      li.innerHTML = `
        <div>
          <div class="title">${esc(b.title || b.id)}${i === 0 ? '<span class="badge">최신</span>' : ''}</div>
          <div class="meta">${esc(b.uploader || '익명')} · ${formatDate(b.uploadedAt)} · ${formatSize(b.size)} · ${b.fileCount || '?'}개 파일</div>
        </div>
        <div class="actions">
          <a class="primary" href="${playUrl}" target="_blank" rel="noopener">▶ 실행</a>
          <button class="ghost small" data-act="copy">링크 복사</button>
          ${hasToken() ? '<button class="ghost small danger" data-act="del">삭제</button>' : ''}
        </div>
        ${b.memo ? `<div class="memo">${esc(b.memo)}</div>` : ''}`;

      // 링크 복사: 팀 채팅방에 바로 붙여넣기용 전체 주소
      li.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const full = new URL(playUrl, location.href).href;
        try { await navigator.clipboard.writeText(full); toast('실행 링크를 복사했습니다.', 'ok'); }
        catch (e) { prompt('아래 링크를 복사하세요', full); }
      });
      // 삭제
      const del = li.querySelector('[data-act="del"]');
      if (del) del.addEventListener('click', () => deleteBuild(b));

      el.buildList.appendChild(li);
    });
  }

  el.btnRefresh.addEventListener('click', renderList);

  /* ═════════ 4. 파일 선택 (zip / 폴더) ═════════ */

  // zip 선택 → 브라우저에서 압축 해제 → 빌드 루트(index.html 위치) 찾기
  async function pickZip(file) {
    if (!window.JSZip) { toast('zip 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.', 'err'); return; }
    setPicked(null, '압축 여는 중…');
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = [];
      zip.forEach((path, entry) => {
        if (!entry.dir && !path.startsWith('__MACOSX/')) entries.push({ path, entry });
      });
      const root = findRoot(entries.map((e) => e.path));
      if (root === null) throw new Error('zip 안에 index.html이 없습니다. Unity WebGL 빌드 폴더를 묶었는지 확인하세요.');

      const files = entries
        .filter((e) => e.path.startsWith(root))
        .map((e) => ({
          path: e.path.slice(root.length),
          size: e.entry._data ? e.entry._data.uncompressedSize : 0,   // 압축 해제 후 크기
          base64: () => e.entry.async('base64'),                     // 필요할 때만 base64로 변환
        }));
      setPicked({ files, sourceName: file.name });
    } catch (err) {
      setPicked(null);
      toast(err.message, 'err');
    }
  }

  // 폴더 선택 (webkitdirectory) → 같은 방식으로 빌드 루트 찾기
  function pickFolder(fileList) {
    const all = Array.from(fileList).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    const root = findRoot(all.map((a) => a.path));
    if (root === null) { toast('선택한 폴더에 index.html이 없습니다.', 'err'); return; }
    const files = all
      .filter((a) => a.path.startsWith(root))
      .map((a) => ({ path: a.path.slice(root.length), size: a.file.size, base64: () => blobToBase64(a.file) }));
    setPicked({ files, sourceName: (all[0] && all[0].path.split('/')[0]) || '폴더' });
  }

  // 경로 목록에서 가장 얕은 index.html의 상위 폴더를 빌드 루트로 판단
  // 예) "MyGame/index.html" → "MyGame/"
  function findRoot(paths) {
    const idx = paths
      .filter((p) => /(^|\/)index\.html$/i.test(p))
      .sort((a, b) => a.split('/').length - b.split('/').length)[0];
    if (!idx) return null;
    return idx.slice(0, idx.length - 'index.html'.length);
  }

  // 선택 결과 반영 + 검사 (용량, Unity 빌드 여부)
  function setPicked(p, statusText) {
    picked = p;
    el.dropZone.classList.toggle('picked', !!p);
    if (!p) {
      el.pickedInfo.textContent = statusText || '선택된 파일 없음';
      updateUploadState();
      return;
    }
    const total = p.files.reduce((s, f) => s + (f.size || 0), 0);
    const tooBig = p.files.filter((f) => f.size > MAX_FILE_BYTES);
    const isUnity = p.files.some((f) => /^Build\/.+\.loader\.js$/i.test(f.path));

    let msg = `${p.sourceName} · ${p.files.length}개 파일 · ${formatSize(total)}`;
    if (!isUnity) msg += ' · ⚠ Unity 빌드 파일(Build/*.loader.js)이 안 보입니다';
    if (tooBig.length) {
      msg += ` · ❌ 100MB 넘는 파일: ${tooBig.map((f) => f.path).join(', ')} (Unity에서 Compression을 Gzip으로 바꿔 주세요)`;
      picked = null;
    }
    el.pickedInfo.textContent = msg;

    // 빌드 이름이 비어 있으면 파일 이름으로 채워 줌
    if (picked && !el.inTitle.value) el.inTitle.value = p.sourceName.replace(/\.zip$/i, '');
    updateUploadState();
  }

  el.fileZip.addEventListener('change', (e) => { if (e.target.files[0]) pickZip(e.target.files[0]); e.target.value = ''; });
  el.fileFolder.addEventListener('change', (e) => { if (e.target.files.length) pickFolder(e.target.files); e.target.value = ''; });

  // 드래그&드롭 (zip 파일만 지원, 폴더는 "폴더로 선택" 버튼 사용)
  ['dragenter', 'dragover'].forEach((t) => el.dropZone.addEventListener(t, (e) => { e.preventDefault(); el.dropZone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => el.dropZone.addEventListener(t, () => el.dropZone.classList.remove('over')));
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.zip$/i.test(f.name)) pickZip(f);
    else toast('zip 파일만 끌어다 놓을 수 있습니다. 폴더는 "📁 폴더로 선택"을 사용하세요.', 'err');
  });

  // 업로드 버튼 활성/비활성
  function updateUploadState() {
    el.needToken.hidden = hasToken();
    el.btnUpload.disabled = busy || !hasToken() || !picked;
  }

  /* ═════════ 5. 업로드 ═════════ */

  el.btnUpload.addEventListener('click', uploadBuild);

  async function uploadBuild() {
    if (!picked || busy) return;
    busy = true; updateUploadState();
    const { owner, repo } = config;
    const files = picked.files;
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0) || 1;
    const id = makeBuildId();
    const uploader = el.inUploader.value.trim();
    config.uploader = uploader; saveConfig(config);   // 다음에 이름 다시 안 써도 되게 저장

    try {
      // (1) 파일마다 blob 생성 - 동시에 몇 개씩 올리면서 진행률 표시
      let doneBytes = 0, doneCount = 0;
      showProgress(0, `파일 업로드 준비 중… (0/${files.length})`);
      const treeItems = await runPool(files, UPLOAD_CONCURRENCY, async (f) => {
        const content = await f.base64();
        const blob = await gh('POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'base64' });
        doneBytes += f.size || 0; doneCount += 1;
        showProgress(doneBytes / totalBytes * 0.9, `파일 업로드 중… (${doneCount}/${files.length}) ${f.path}`);
        return { path: `${BUILDS_DIR}/${id}/${f.path}`, mode: '100644', type: 'blob', sha: blob.sha };
      });

      // (2) builds.json 갱신 + 커밋 (다른 사람이 동시에 올리면 최신 상태로 다시 시도)
      const entry = {
        id,
        title: el.inTitle.value.trim() || id,
        memo: el.inMemo.value.trim(),
        uploader,
        uploadedAt: new Date().toISOString(),
        size: totalBytes,
        fileCount: files.length,
      };
      showProgress(0.93, '커밋 만드는 중…');
      await commitWithRetry(
        `빌드 업로드: ${entry.title}`,
        (list) => [entry, ...list],     // 목록 맨 앞에 새 빌드 추가
        () => treeItems                 // 이번 커밋에 넣을 파일들
      );

      showProgress(1, '완료! GitHub Pages 배포에 1~2분 걸립니다.');
      toast('업로드 완료! 1~2분 뒤 실행할 수 있습니다.', 'ok');
      // 입력 초기화
      el.inTitle.value = ''; el.inMemo.value = '';
      setPicked(null);
      renderList();
    } catch (err) {
      showProgress(0, '❌ ' + err.message);
      toast('업로드 실패: ' + err.message, 'err');
    } finally {
      busy = false; updateUploadState();
    }
  }

  // 커밋 공통 처리
  // - editList(list): 현재 builds.json 목록을 받아 새 목록을 돌려주는 함수
  // - makeItems(headTreeSha): 커밋에 추가/삭제할 트리 항목을 돌려주는 함수
  async function commitWithRetry(message, editList, makeItems) {
    const { owner, repo, branch } = config;
    const base = `/repos/${owner}/${repo}`;
    for (let attempt = 1; attempt <= COMMIT_RETRY; attempt++) {
      // 현재 브랜치 최신 커밋과 트리
      const ref = await gh('GET', `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
      const headSha = ref.object.sha;
      const head = await gh('GET', `${base}/git/commits/${headSha}`);

      // 해당 커밋 시점의 builds.json 읽기 (없으면 빈 목록)
      let list = [];
      try {
        const f = await gh('GET', `${base}/contents/${LIST_FILE}?ref=${headSha}`);
        list = normalizeList(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)))));
      } catch (e) { if (e.status && e.status !== 404) throw e; }

      const newList = editList(list);
      const items = await makeItems(head.tree.sha);
      items.push({
        path: LIST_FILE, mode: '100644', type: 'blob',
        content: JSON.stringify(newList, null, 2),   // 텍스트는 content로 바로 넣을 수 있음
      });

      const tree = await gh('POST', `${base}/git/trees`, { base_tree: head.tree.sha, tree: items });
      const commit = await gh('POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [headSha] });
      try {
        await gh('PATCH', `${base}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
        return commit;
      } catch (e) {
        // 422 = 그 사이에 다른 커밋이 생김 → 처음부터 다시
        if (e.status === 422 && attempt < COMMIT_RETRY) { await sleep(800 * attempt); continue; }
        throw e;
      }
    }
  }

  /* ═════════ 6. 삭제 ═════════ */

  async function deleteBuild(b) {
    if (busy) return;
    if (!confirm(`"${b.title || b.id}" 빌드를 삭제할까요?\n(GitHub 기록에는 남지만 사이트에서는 사라집니다)`)) return;
    busy = true; updateUploadState();
    const { owner, repo } = config;
    try {
      toast('삭제 중…');
      await commitWithRetry(
        `빌드 삭제: ${b.title || b.id}`,
        (list) => list.filter((x) => x.id !== b.id),
        async (treeSha) => {
          // 해당 빌드 폴더의 모든 파일을 찾아 sha:null(=삭제)로 지정
          const t = await gh('GET', `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
          const prefix = `${BUILDS_DIR}/${b.id}/`;
          return t.tree
            .filter((n) => n.type === 'blob' && n.path.startsWith(prefix))
            .map((n) => ({ path: n.path, mode: '100644', type: 'blob', sha: null }));
        }
      );
      toast('삭제했습니다.', 'ok');
      renderList();
    } catch (err) {
      toast('삭제 실패: ' + err.message, 'err');
    } finally {
      busy = false; updateUploadState();
    }
  }

  /* ═════════ 7. 작은 도우미 함수들 ═════════ */

  // 동시 실행 개수를 제한하며 작업 실행 (결과 순서 유지)
  async function runPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    });
    await Promise.all(runners);
    return results;
  }

  // 빌드 ID: 20261023-225130-x7k 형태 (영문/숫자만 → URL에 안전)
  function makeBuildId() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 5);
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`;
  }

  function showProgress(ratio, text) {
    el.progressWrap.hidden = false;
    el.progressBar.style.width = `${Math.round(ratio * 100)}%`;
    el.progressText.textContent = text;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = kind || '';
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3500);
  }

  // HTML 특수문자 처리 (메모에 <script> 등이 들어가도 안전하게)
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatSize(bytes) {
    if (!bytes) return '-';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  function formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d)) return '-';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ═════════ 시작 ═════════ */
  el.inUploader.value = config.uploader || '';
  updateUploadState();
  renderList();
})();
