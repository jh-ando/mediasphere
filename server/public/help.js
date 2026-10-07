// 도움말 · 자주 묻는 질문 - 맨 위 [? 도움말]로 여는 오른쪽 패널과, 화면 곳곳의 문맥 도움말
// (data-faq="질문 id"를 가진 버튼 → 그 질문 하나를 말풍선으로)을 담당한다. 대시보드를 보면서
// 읽을 수 있게 팝업이 아니라 오른쪽 패널로 연다. 문구를 고칠 때는 아래 FAQ만 고치면 된다 -
// 답의 [이름]은 화면의 버튼·칸 이름 표시(회색 바탕)로 바뀐다. 운영 매뉴얼 v2와 내용을 맞춘다.

const FAQ = [
  {
    cat: '화면·조작',
    items: [
      ['locked', '모드 전환 버튼이나 재생 버튼이 눌리지 않아요.',
        '무언가 실행 중(영상 재생, 점멸, 재생목록, 텍스트)이면 다른 모드로 바꿀 수 없습니다. 버튼 아래 노란 안내를 보고 먼저 정지하세요. 영상 교체·배포 중에도 같은 이유로 잠깁니다.'],
      ['auto-play', '아무것도 안 눌렀는데 영상으로 바뀌었다가 다시 돌아와요.',
        '정상입니다. 현장 이벤트(문 열림 등)로 외부 재생 신호가 오면 영상을 1회 재생한 뒤 원래 하던 모드로 자동 복귀합니다.'],
      ['trigger-ignored', '외부 재생 신호가 왔는데 영상이 재생되지 않아요.',
        '운영 시간 밖, 절전 중, 영상 교체 중에는 외부 재생 신호를 무시합니다. "지금 구체 화면"의 운영 시간 줄을 확인하세요.'],
      ['playlist-save', '재생목록을 고쳤는데 반영이 안 돼요.',
        '[저장]을 눌러야 반영됩니다. 저장 전이면 제목 옆에 "저장 안 된 변경 있음"이 보입니다. 재생 중에는 편집이 잠기니 먼저 정지하세요.'],
      ['schedule-apply', '운영 시간을 저장했더니 바로 영상이 켜지거나 꺼졌어요.',
        '타이머는 저장하는 즉시 지금 시각 기준으로 적용됩니다. 운영 시간이면 영상을 재생하고, 아니면 절전으로 바꿉니다. 그 뒤로는 시작·종료 시각에만 동작합니다.'],
      ['idle-stays', '운영 중에 절전을 눌렀는데 계속 꺼져 있어요.',
        '직접 누른 절전은 다음 운영 시작 시각까지 유지됩니다. 바로 다시 켜려면 영상·패턴·텍스트 모드 전환 버튼 중 하나를 누르세요.'],
    ],
  },
  {
    cat: '기기 상태',
    items: [
      ['offline', '그리드에 회색 칸이 생겼어요.',
        '10초 이상 응답이 없는 폰입니다. 교체·배포 중이면 잠시 후 돌아옵니다. 몇 분째 오프라인이면 앱 재시작 → 재부팅 순서로 진행하세요.'],
      ['restart', '"최근 재시작"이 떴는데 문제가 있는 건가요?',
        '앱이 저절로 꺼졌다가 자동으로 다시 켜진 기록입니다. 지금은 정상 동작 중입니다. 종료 사유와 직전 온도를 확인한 뒤 [확인]을 누르세요. 같은 폰이 자주 뜨면 설치 위치의 발열이나 전원을 점검하세요.'],
      ['heat', '"발열" 알림이 떠요.',
        '발열 단계가 "심각" 이상이거나 배터리가 45°C 이상인 폰입니다. 해당 폰 주변 환기와 온도를 확인하고, 계속되면 담당자에게 알려주세요.'],
      ['broken-screen', '화면이 초록 줄무늬나 검은 화면으로 깨졌어요.',
        '앱 재시작으로는 풀리지 않는 증상입니다. 관리 > 재시작·재부팅에서 그 폰만 [선택 재부팅]하세요(1~2분).'],
      ['player-error', '"재생 오류"(빨간 점)가 있어요.',
        '그 폰만 [선택 앱 재시작]을 해보세요. 그래도 남으면 [선택 재부팅]하세요.'],
      ['battery', '"충전 안 됨"이나 "배터리 낮음"이 떠요.',
        '현장 점검이 필요합니다. 해당 폰의 충전 케이블, 어댑터, 연결 상태를 확인하세요.'],
      ['reboot-fail', '"재부팅 실패" 알림이 떠요.',
        '원격 재부팅 권한(Device Owner)이 없는 폰입니다. 원격으로는 재부팅할 수 없으니 담당자에게 알려주세요.'],
      ['restart-vs-reboot', '앱 재시작과 재부팅은 언제 쓰나요?',
        '앱 재시작은 앱만 껐다 켭니다(몇 초) - 화면이 멈추거나 이상할 때 먼저 씁니다. 재부팅은 폰 자체를 다시 켭니다(1~2분) - 앱 재시작으로 안 풀리는 화면 깨짐일 때만 씁니다.'],
      ['fill-ids', '문제 있는 폰 번호를 한 번에 넣고 싶어요.',
        '기기 현황의 알림(예: 연결 끊김)을 누르면 번호 목록이 나옵니다. [재시작·재부팅 칸에 넣기]를 누르면 관리 영역의 번호 칸에 바로 들어갑니다.'],
    ],
  },
  {
    cat: '영상 교체',
    items: [
      ['replace-disabled', '[교체 시작] 버튼이 눌리지 않아요.',
        '영상 교체는 영상 모드에서만 할 수 있습니다. 영상 모드로 바꾼 뒤 다시 시도하세요. 이미 교체·배포가 진행 중이어도 눌리지 않습니다.'],
      ['replace-time', '교체는 얼마나 걸리나요?',
        '인코딩(439개 타일 만들기)에 수십 분 걸립니다. 진행 중에는 끝난 타일 수와 예상 남은 시간이 표시되고, 이후 폰마다 파일을 받는 데 시간이 더 걸립니다.'],
      ['replace-cancel', '교체를 취소하면 어떻게 되나요?',
        '지금까지 인코딩한 내용만 버려지고, 지금 배포된 영상과 폰의 영상은 그대로입니다.'],
      ['replace-mismatch', '교체가 끝났는데 "영상 파일 불일치"가 남아 있어요.',
        '잠시 지켜본 뒤에도 남으면 그 폰만 [선택 앱 재시작]하세요(알림 → [재시작·재부팅 칸에 넣기]).'],
      ['replace-fail', '교체가 실패했어요.',
        '빨간 글씨로 사유가 나오고 로그가 자동으로 펼쳐집니다. 로그 내용을 담당자에게 전달해주세요. 배포된 영상은 그대로입니다.'],
    ],
  },
  {
    cat: '현장',
    items: [
      ['show-id', '몇 번 폰인지 확인하고 싶어요.',
        '맨 위 [ID 표시]를 누르면 모든 폰 화면에 번호가 크게 뜹니다. 끄려면 [ID 끄기]를 누르세요.'],
      ['phone-settings', '폰 설정 화면에 들어가야 해요.',
        '폰 화면 왼쪽 위 구석을 빠르게 5번 탭 → [설정 열기]. 끝나면 폰의 홈 버튼을 누르면 앱으로 돌아와 다시 잠깁니다. 10분이 지나면 자동으로 돌아옵니다.'],
      ['kiosk', '"키오스크 해제"가 계속 떠 있어요.',
        '현장에서 정비 메뉴를 연 폰입니다. 그 폰의 홈 버튼을 누르면 다시 잠기고, 10분이 지나면 자동으로 돌아옵니다.'],
      ['server-down', '대시보드 맨 위에 "서버 연결 끊김"이 떠요.',
        '대시보드가 서버와 연결되지 않은 상태입니다. 같은 Wi-Fi(MEDIA01~10)에 연결돼 있는지, 서버 PC가 켜져 있는지 확인하세요. 연결되면 자동으로 다시 붙습니다.'],
    ],
  },
];

// 기기 현황 알림 종류(app.js PROBLEMS key) → 그 알림을 설명하는 질문
const FAQ_FOR_ALERT = {
  off: 'offline', mis: 'replace-mismatch', perr: 'player-error', rerr: 'reboot-fail',
  heat: 'heat', kiosk: 'kiosk', batt: 'battery', low: 'battery', restart: 'restart',
};

(() => {
  const byId = {};
  FAQ.forEach((c) => c.items.forEach(([id, q, a]) => { byId[id] = { q, a, cat: c.cat }; }));
  const total = Object.keys(byId).length;

  const drawer = document.getElementById('help');
  const listEl = document.getElementById('help-list');
  const catsEl = document.getElementById('help-cats');
  const searchEl = document.getElementById('help-search');
  const popEl = document.getElementById('help-pop');
  let activeCat = null; // null = 전체

  // 답 글자 → 안전한 HTML([이름]은 화면 이름 표시)
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rich = (s) => escape(s).replace(/\[([^\]]+)\]/g, '<span class="help-ui">$1</span>');

  function renderCats() {
    const chip = (label, cat, n) => `<button type="button" class="help-cat" data-cat="${cat ?? ''}" aria-pressed="${activeCat === cat}">${label}<b>${n}</b></button>`;
    catsEl.innerHTML = chip('전체', null, total) + FAQ.map((c) => chip(c.cat, c.cat, c.items.length)).join('');
  }

  function renderList(openId) {
    const words = searchEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (q, a) => words.every((w) => `${q} ${a}`.toLowerCase().includes(w));
    let html = '';
    FAQ.forEach((c) => {
      if (activeCat && c.cat !== activeCat) return;
      const shown = c.items.filter(([, q, a]) => match(q, a));
      if (!shown.length) return;
      html += `<div class="help-grp">${c.cat}</div>`;
      shown.forEach(([id, q, a]) => {
        html += `<div class="help-item${id === openId ? ' open' : ''}" data-id="${id}">`
          + `<button type="button" class="help-q" aria-expanded="${id === openId}">${rich(q)}</button>`
          + `<div class="help-a">${rich(a)}</div></div>`;
      });
    });
    listEl.innerHTML = html || '<p class="help-empty">찾는 내용이 없습니다. 다른 낱말로 찾아보거나 담당자에게 문의하세요.</p>';
  }

  // 열 때마다 처음(전체, 검색어 없음)부터 - 지난번에 고른 분류가 남아 있으면 찾는 질문이 안 보인다
  function openDrawer(focusId) {
    closePop();
    activeCat = null;
    searchEl.value = '';
    renderCats();
    renderList(focusId);
    drawer.hidden = false;
    if (focusId) {
      const el = listEl.querySelector(`[data-id="${focusId}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
    } else {
      searchEl.focus();
    }
  }
  const closeDrawer = () => { drawer.hidden = true; };

  // 문맥 도움말 말풍선 - 누른 버튼 바로 아래에, 화면 밖으로 안 나가게
  function openPop(id, anchor) {
    const item = byId[id];
    if (!item) return;
    popEl.innerHTML = `<b>${rich(item.q)}</b><div>${rich(item.a)}</div>`
      + `<button type="button" class="help-more" data-open="${id}">자주 묻는 질문에서 더 보기 →</button>`;
    popEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = popEl.offsetWidth;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    popEl.style.left = `${left + window.scrollX}px`;
    popEl.style.top = `${r.bottom + window.scrollY + 8}px`;
  }
  const closePop = () => { popEl.hidden = true; };

  document.getElementById('btn-help').addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
  document.getElementById('help-close').addEventListener('click', closeDrawer);
  searchEl.addEventListener('input', () => renderList());
  catsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.help-cat');
    if (!b) return;
    activeCat = b.dataset.cat || null;
    renderCats();
    renderList();
  });
  listEl.addEventListener('click', (e) => {
    const q = e.target.closest('.help-q');
    if (!q) return;
    const item = q.parentElement;
    item.classList.toggle('open');
    q.setAttribute('aria-expanded', String(item.classList.contains('open')));
  });
  // 화면 곳곳의 [data-faq] 버튼(문맥 도움말)과 말풍선의 "더 보기"
  document.addEventListener('click', (e) => {
    const more = e.target.closest('.help-more');
    if (more) { openDrawer(more.dataset.open); return; }
    const ctx = e.target.closest('[data-faq]');
    if (ctx) {
      e.stopPropagation();
      if (!popEl.hidden && popEl.dataset.for === ctx.dataset.faq) { closePop(); return; }
      popEl.dataset.for = ctx.dataset.faq;
      openPop(ctx.dataset.faq, ctx);
      return;
    }
    if (!popEl.hidden && !popEl.contains(e.target)) closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.getElementById('modal').hidden) return;
    if (!popEl.hidden) closePop();
    else if (!drawer.hidden) closeDrawer();
  });
  window.addEventListener('resize', closePop);

  // app.js가 기기 현황 알림 목록을 그릴 때 "이게 무슨 뜻인가요?"에 연결할 질문을 고른다
  window.helpFaqForAlert = (key) => FAQ_FOR_ALERT[key] || null;
})();
