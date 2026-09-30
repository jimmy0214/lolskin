/* ============================================================
 * LOL 皮肤拼图工坊 - UI 控制器
 * ============================================================ */
(function () {
  'use strict';
  const { DB, analyzeOwnership, parseAccountText, renderGrid, renderPoster, downloadCanvas,
    releaseCanvas, cardHTML, chromaCardHTML, esc, fmtTime } = window.CollageCore;

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  /** 阶段标记：只在带 ?selftest 自检时使用，方便无头浏览器定位问题 */
  function mark(m) { if (window.__selftest) window.__stage = m; }
  /** 非阻塞提示（不用 alert，避免打断操作） */
  function note(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(note._t);
    note._t = setTimeout(() => el.classList.remove('show'), 4200);
  }

  const state = {
    analysis: null,          // analyzeOwnership 结果
    ownedIds: null,          // Set
    previewHeroId: null,
    collages: [],            // 兼容旧字段
    cache: new Map(),        // 分页画布 LRU 缓存 pageIndex -> canvas
    cacheOrder: [],
    collageMeta: null,       // {render(i), count, nameFor(i), baseName}
    page: 0,
    zoom: 0.6,
    browseShown: 0,
    browseList: [],
    missingShown: 0,
    missingList: [],
  };
  const BROWSE_PAGE = 120;
  const BROWSE_MAX_DOM = 240;   // 关键：图鉴同时最多挂 240 张卡，否则解码位图会把渲染进程 OOM 掉
  const MISSING_PAGE = 60;

  /* ============================================================
   * 启动
   * ============================================================ */
  async function boot() {
    if (location.protocol === 'file:') $('#fileWarn').hidden = false;
    mark('boot:start');
    try {
      await DB.load((p, f) => {
        $('#bootBar').style.width = (p * 100).toFixed(0) + '%';
        $('#bootText').textContent = '正在加载本地皮肤数据… ' + f;
      });
    } catch (e) {
      $('#bootText').innerHTML = '<span style="color:#ff8080">' + esc(e.message) + '</span>';
      return;
    }
    mark('boot:data-loaded');
    const s = DB.stats;
    $('#bootText').textContent = `完成：${s.heroCount} 英雄 · ${s.skinCount} 皮肤 · ${s.chromaCount} 炫彩`;
    $('#dbStat').textContent =
      `${DB.meta.version || ''}　${s.heroCount} 英雄 · ${s.skinCount} 皮肤 · ${s.chromaCount} 炫彩`;
    setTimeout(() => {
      mark('boot:show-ui');
      $('#boot').hidden = true;
      $('#app').hidden = false;
      initUI();
      mark('boot:ready');
    }, 320);
  }

  /* ============================================================
   * Tab 切换
   * ============================================================ */
  function initTabs() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.toggle('is-active', x === t));
      $$('.page').forEach(p => p.classList.toggle('is-active', p.id === 'page-' + t.dataset.tab));
    }));
    const go = name => $$('.tab').find(t => t.dataset.tab === name).click();
    window.__goTab = go;
  }

  /* ============================================================
   * 皮肤图鉴
   * ============================================================ */
  function buildBrowseList() {
    const q = $('#q').value.trim().toLowerCase();
    const sort = $('#sort').value;
    const onlyChroma = $('#onlyChroma').checked;
    let list = DB.skins.slice();
    if (onlyChroma) list = list.filter(s => (DB.childrenChromas[s.skinId] || []).length);
    if (q) {
      list = list.filter(s => {
        const h = DB.heroById[s.heroId] || {};
        const hay = [s.name, h.title, h.name, h.alias, h.keywords].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    const heroIdx = {};
    DB.heroes.forEach((h, i) => heroIdx[h.heroId] = i);
    if (sort === 'hero') {
      list.sort((a, b) => (heroIdx[a.heroId] - heroIdx[b.heroId]) || (b.isBase - a.isBase));
    } else if (sort === 'chroma') {
      list.sort((a, b) => (DB.childrenChromas[b.skinId] || []).length - (DB.childrenChromas[a.skinId] || []).length);
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }
    state.browseList = list;
    state.browseShown = 0;
    dropGalleryCards($('#gallery'));
    $('#browseCount').textContent = `共 ${list.length} 款`;
    loadMoreBrowse();
  }

  function loadMoreBrowse() {
    const list = state.browseList;
    const from = state.browseShown;
    const to = Math.min(list.length, from + BROWSE_PAGE);
    if (from >= list.length) { renderBrowseExtras(); return; }
    const ownOpt = state.analysis
      ? { ownedIds: state.analysis.ownedSkinIds, ownedChromaIds: state.analysis.ownedChromaIds } : null;
    const chips = [];
    for (let i = from; i < to; i++) {
      // 每页前 12 张直接加载（首屏立刻可见），其余懒加载
      chips.push(cardHTML(list[i], Object.assign({ eager: i - from < 12 }, ownOpt || {})));
    }
    const gallery = $('#gallery');
    if (state.browseShown >= BROWSE_MAX_DOM) {
      // 超过上限：整段替换而不是继续追加，避免上千张解码图同时驻留内存
      gallery.innerHTML = chips.join('');
      state.browseShown = to;
    } else {
      gallery.insertAdjacentHTML('beforeend', chips.join(''));
      state.browseShown = to;
    }
    renderBrowseExtras();
  }

  /** 丢弃当前图鉴卡片：先清空 src 再移除节点，帮助浏览器尽快回收解码位图 */
  function dropGalleryCards(container) {
    container.querySelectorAll('img').forEach(im => { im.src = ''; });
    container.innerHTML = '';
  }

  /** 选中的皮肤 -> 在其下方展示该皮肤的全部炫彩（独立于 grid 容器，避免撑破布局） */
  function renderChromaStrip() {
    const box = $('#chromaStrip');
    const id = state.previewHeroId;
    if (!id) { box.hidden = true; box.innerHTML = ''; return; }
    const skin = DB.skinById[id];
    const chromas = DB.childrenChromas[id] || [];
    if (!skin || !chromas.length) { box.hidden = true; box.innerHTML = ''; return; }
    const ownOpt = state.analysis
      ? { ownedIds: state.analysis.ownedSkinIds, ownedChromaIds: state.analysis.ownedChromaIds } : null;
    box.hidden = false;
    box.innerHTML = `
      <div class="strip-head">
        <b>${esc(skin.name)}</b>
        <span class="muted small">${esc(DB.heroFullName(skin.heroId))} · ${chromas.length} 个炫彩</span>
        <button class="btn small" id="stripClose">收起</button>
      </div>
      <div class="gallery compact">${chromas.map(c =>
        chromaCardHTML(c, ownOpt && ownOpt.ownedChromaIds.has(c.skinId))).join('')}</div>`;
    $('#stripClose').onclick = () => { state.previewHeroId = null; renderChromaStrip(); };
  }

  function renderBrowseExtras() {
    const more = $('#loadMore');
    more.hidden = state.browseShown >= state.browseList.length;
    renderChromaStrip();
  }

  /* ============================================================
   * 账号数据
   * ============================================================ */
  function initMe() {
    const drop = $('#drop'), file = $('#file');
    $('#pickFile').addEventListener('click', () => file.click());
    drop.addEventListener('click', e => { if (e.target === drop) file.click(); });
    file.addEventListener('change', () => { if (file.files[0]) readFile(file.files[0]); });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', e => {
      const f = e.dataTransfer.files[0];
      if (f) readFile(f);
    });
    $('#demoBtn').addEventListener('click', () => {
      // 演示：构造与官方导出格式一致的假账号（championSkins + create_time + chromas 标志位）
      const entries = [];
      const ids = new Set();
      const now = Math.floor(Date.now() / 1000);
      DB.skins.forEach((s, i) => {
        if (!s.isBase && (i % 5 === 0 || /传说|终极|至臻|神话/.test(s.name))) {
          entries.push({ heroId: s.heroId, skinId: s.skinId, isChroma: false, createTime: now - i * 3600 });
          ids.add(s.skinId);
        }
      });
      DB.chromas.forEach((c, i) => {
        if (i % 21 === 0) {
          entries.push({ heroId: c.heroId, skinId: c.skinId, isChroma: true, createTime: now - i * 600 });
          ids.add(c.skinId);
        }
      });
      const res = {
        format: 'championSkins', ids, entries,
        heroIds: [...new Set(entries.map(e => e.heroId))],
        unknown: [], count: entries.length,
        skinEntries: entries.filter(e => !e.isChroma).length,
        chromaEntries: entries.filter(e => e.isChroma).length,
        declared: { championNum: new Set(entries.map(e => e.heroId)).size, skinNum: entries.length },
      };
      applyOwned(ids, { source: '内置演示账号（模拟官方导出格式）', res });
    });
  }

  function readFile(f) {
    const info = $('#parseInfo');
    info.hidden = false;
    info.textContent = `读取 ${f.name} …`;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const res = parseAccountText(String(fr.result));
        applyOwned(res.ids, {
          source: `文件 ${f.name}（${(f.size / 1024).toFixed(1)} KB）`,
          res,
        });
      } catch (e) {
        info.textContent = '解析失败：' + e.message;
      }
    };
    fr.onerror = () => { info.textContent = '文件读取失败'; };
    fr.readAsText(f, 'utf-8');
  }

  function applyOwned(ids, ctx) {
    const res = ctx.res || null;
    const a = analyzeOwnership(ids, {
      includeChroma: true, countBase: true, inferBase: true,
      entries: res && res.entries ? res.entries : null,
    });
    state.analysis = a;
    state.ownedIds = ids;
    state.accountFormat = res ? res.format : 'generic';

    const info = $('#parseInfo');
    info.hidden = false;
    const lines = [];
    lines.push('数据来源：' + (ctx.source || ''));
    if (res && res.format === 'championSkins') {
      const d = res.declared || {};
      lines.push('格式识别：英雄联盟账号导出（championSkins）' +
        (d.championNum != null ? '　文件声明 ' + d.championNum + ' 英雄 / ' + d.skinNum + ' 皮肤' : ''));
      lines.push('解析结果：' + res.heroIds.length + ' 个英雄，' + res.count + ' 条记录' +
        '（皮肤 ' + res.skinEntries + ' + 炫彩 ' + res.chromaEntries + '）');
      lines.push('说明：账号文件不含"原皮肤"条目（原皮肤随英雄赠送）。已按"该英雄有皮肤入账"推断 ' +
        a.inferredBase + ' 个原皮肤，另有 ' + (a.owned.filter(x => x.skin.isBase).length - a.inferredBase) +
        ' 个由炫彩父皮肤带入，合计 ' + a.owned.filter(x => x.skin.isBase).length + ' 个。');
      if (a.hasTime) {
        lines.push('获取时间：' + a.timeline[a.timeline.length - 1].date + ' ~ ' +
          a.timeline[0].date + '（可用于按获得时间排序拼图）');
      }
    } else {
      lines.push('格式识别：通用模式（未匹配官方导出结构）');
      lines.push('识别到 ' + res.count + ' 个 ID，其中 ' + ids.size + ' 个命中官方皮肤库');
    }
    if (res && res.unknown.length) {
      lines.push('未匹配 ' + res.unknown.length + ' 个 ID（前 8 个：' + res.unknown.slice(0, 8).join(', ') + '）');
    } else {
      lines.push('未匹配 ID：0');
    }
    info.textContent = lines.join('\n');

    $('#report').hidden = false;
    renderReport(a);
    buildBrowseList();
    updateSizeHint();
    $('#scopeOwnedHint').textContent = '（已识别 ' + a.ownedSkinCount + ' 款皮肤）';
    window.__goTab('me');
  }

  function renderReport(a) {
    $('#kpiSkin').textContent = a.ownedSkinCount;
    $('#kpiSkinSub').textContent = '/ 全库 ' + DB.stats.skinCount + ' 款 · 收集度 ' +
      (a.collectionRate * 100).toFixed(1) + '%' +
      (a.inferredBase ? '（含推断的 ' + a.inferredBase + ' 个原皮肤）' : '');
    $('#kpiChroma').textContent = a.ownedChromaCount;
    $('#kpiChromaSub').textContent = '/ 全库 ' + DB.stats.chromaCount + ' 款';
    $('#kpiScore').textContent = Math.round(a.score);
    $('#kpiScoreSub').textContent = '皮肤 ' + Math.round(a.skinValue) + ' + 炫彩 ' + Math.round(a.chromaValue);
    $('#kpiLevel').textContent = a.level.name;
    $('#kpiLevel').style.color = a.level.color;
    $('#kpiLevelSub').textContent = a.level.desc +
      (a.paidOwnedCount ? '（付费皮肤 ' + a.paidOwnedCount + ' 款）' : '');

    // 品质分布
    const maxR = Math.max(1, ...a.rarityAgg.map(r => r.count));
    $('#rarityList').innerHTML = a.rarityAgg.length ? a.rarityAgg.map(r => `
      <div class="bar-row">
        <span style="color:${r.color};font-weight:700">${esc(r.name)}</span>
        <span class="bar-track"><i class="bar-fill" style="width:${(r.count / maxR * 100).toFixed(1)}%;background:${r.color}"></i></span>
        <span class="bar-num">${r.count}</span>
        <span class="bar-tag">${r.chromaCount ? '含 ' + r.chromaCount + ' 炫彩' : ''}</span>
      </div>`).join('') : '<div class="muted small">没有识别到皮肤</div>';

    // 完成度
    const total = DB.stats.skinCount;
    const heroCover = a.heroCovered, heroTotal = a.heroTotal;
    const ownWithChroma = a.owned.filter(x => x.chromas.length > 0).length;
    const rows = [
      ['英雄覆盖', heroCover, heroTotal, '#63b3ff'],
      ['皮肤收集', a.ownedSkinCount, total, '#c8a24a'],
      ['炫彩收集', a.ownedChromaCount, DB.stats.chromaCount, '#a06bff'],
      ['整套齐全', a.completeSkins, ownWithChroma, '#4fd1c5'],
    ];
    $('#progressList').innerHTML = rows.map(([label, v, t, c]) => `
      <div class="bar-row" style="grid-template-columns:64px 1fr 96px">
        <span style="color:${c};font-weight:700">${label}</span>
        <span class="bar-track"><i class="bar-fill" style="width:${t ? (v / t * 100).toFixed(1) : 0}%;background:${c}"></i></span>
        <span class="bar-tag">${v} / ${t}</span>
      </div>`).join('');

    // 英雄榜
    const ranked = a.perHero.filter(h => h.own > 0);
    const maxScore = Math.max(1, ...ranked.map(h => h.score));
    $('#heroRank').innerHTML = ranked.map((h, i) => `
      <div class="hr-row" data-hero="${h.hero.heroId}">
        <span class="hr-rank">${i + 1}</span>
        <span class="hr-name">${esc(h.hero.title)}<small>${esc(h.hero.name)} · 最高 ${esc(h.maxRarity.name)}</small></span>
        <span class="muted small">${h.own}/${h.total} 款</span>
        <span class="hr-bar"><i style="width:${(h.score / maxScore * 100).toFixed(1)}%"></i></span>
        <span class="muted small">炫彩 ${h.chromaOwn}/${h.chromaTotal}</span>
        <span class="hr-score">${Math.round(h.score)}</span>
      </div>`).join('');
    $$('#heroRank .hr-row').forEach(row => row.addEventListener('click', () => {
      const hid = row.dataset.hero;
      const exist = row.nextElementSibling;
      if (exist && exist.classList.contains('hr-detail')) { exist.remove(); return; }
      const h = a.perHero.find(x => x.hero.heroId === hid);
      const own = h.rows.filter(r => r.owned && !r.skin.isBase);
      const html = `<div class="hr-detail"><div class="gallery compact">
        ${own.map(r => cardHTML(r.skin, { ownedIds: a.ownedSkinIds, ownedChromaIds: a.ownedChromaIds }) +
          r.ownedChromas.map(c => chromaCardHTML(c, true)).join('')).join('')}
      </div></div>`;
      row.insertAdjacentHTML('afterend', html);
    }));

    // 缺失皮肤
    const missing = [];
    for (const h of a.perHero) for (const r of h.rows) if (!r.owned && !r.skin.isBase) missing.push(r.skin);
    missing.sort((x, y) => DB.rarityOf(y).weight - DB.rarityOf(x).weight);
    state.missingList = missing;
    state.missingShown = 0;
    $('#missingGallery').innerHTML = '';
    $('#missingHint').textContent = '共 ' + missing.length + ' 款尚未拥有（按品质排序）';
    loadMoreMissing();
    renderTimeline(a);
  }

  function loadMoreMissing() {
    const list = state.missingList;
    const to = Math.min(list.length, state.missingShown + MISSING_PAGE);
    const part = list.slice(state.missingShown, to);
    $('#missingGallery').insertAdjacentHTML('beforeend',
      part.map((s, i) => cardHTML(s, { eager: i < 12 })).join(''));
    state.missingShown = to;
    $('#missingMore').hidden = state.missingShown >= list.length;
    $('#missingMore').textContent = '显示更多缺失皮肤（还有 ' + (list.length - state.missingShown) + ' 款）';
  }

  /** 最近获得的皮肤（账号文件带 create_time 时可用） */
  function renderTimeline(a) {
    const wrap = $('#timelinePanel');
    if (!wrap) return;
    if (!a.hasTime) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('#timelineGallery').innerHTML = a.timeline.slice(0, 24).map((x, i) =>
      cardHTML(x.skin, { ownedIds: a.ownedSkinIds, ownedChromaIds: a.ownedChromaIds, eager: true })
        .replace(/<figcaption>[\s\S]*?<\/figcaption>/,
          '<figcaption><b>' + esc(x.skin.name) + '</b><span>' + esc(x.date) + ' 获得</span></figcaption>')
    ).join('');
  }

  /* ============================================================
   * 拼图
   * ============================================================ */
  function buildGroups() {
    const scope = document.querySelector('input[name=scope]:checked').value;
    const incChroma = $('#optChroma').checked;
    const incBase = $('#optBase').checked;
    const group = $('#optGroup').checked;
    const a = state.analysis;

    let skins = [];
    let chromasOf = id => [];

    if (scope === 'all') {
      skins = DB.skins.slice();
      chromasOf = id => incChroma ? (DB.childrenChromas[id] || []) : [];
    } else {
      if (!a) throw new Error('请先在「我的皮肤」上传账号数据，或选择「全图鉴」');
      skins = a.owned.map(o => o.skin);
      chromasOf = id => {
        if (!incChroma) return [];
        const o = a.owned.find(x => x.skin.skinId === id);
        return o ? o.chromas : [];
      };
    }
    if (!incBase) skins = skins.filter(s => !s.isBase);
    if (scope === 'legendary') {
      skins = skins.filter(s => ['ultimate', 'mythic', 'prestige', 'legendary'].includes(DB.rarityOf(s).key));
      if (!skins.length) throw new Error('没有传说及以上品质的皮肤');
    }
    skins.sort((x, y) => DB.rarityOf(y).weight - DB.rarityOf(x).weight || Number(x.skinId) - Number(y.skinId));

    const toItem = (skin) => ({
      skinId: skin.skinId,
      name: skin.name,
      sub: DB.heroFullName(skin.heroId) + (skin.isBase ? ' · 原皮肤' : ''),
      rarity: DB.rarityOf(skin),
      tag: $('#optTag').checked
        ? (skin.isBase ? '' : (DB.rarityOf(skin).key === 'other' ? '' : DB.rarityOf(skin).name)) : '',
    });
    const toChroma = (c) => ({
      skinId: c.skinId,
      name: c.name,
      sub: DB.heroName(c.heroId) + ' · 炫彩',
      rarity: { key: 'chroma', name: '炫彩', color: '#63b3ff' },
      tag: $('#optTag').checked ? '炫彩' : '',
    });

    const groups = [];
    if (group) {
      const byHero = new Map();
      for (const s of skins) {
        if (!byHero.has(s.heroId)) byHero.set(s.heroId, []);
        byHero.get(s.heroId).push(s);
      }
      const heroOrder = [...byHero.keys()].sort((x, y) => {
        const sx = Math.max(...byHero.get(x).map(s => DB.rarityOf(s).weight));
        const sy = Math.max(...byHero.get(y).map(s => DB.rarityOf(s).weight));
        return sy - sx || Number(x) - Number(y);
      });
      for (const hid of heroOrder) {
        const arr = byHero.get(hid);
        const items = [];
        for (const s of arr) {
          items.push(toItem(s));
          for (const c of chromasOf(s.skinId)) items.push(toChroma(c));
        }
        const h = DB.heroById[hid] || {};
        groups.push({
          label: h.title || ('英雄' + hid),
          sub: `${arr.length} 款皮肤` + (items.length > arr.length ? ` · ${items.length - arr.length} 个炫彩` : ''),
          items,
        });
      }
    } else {
      const items = [];
      for (const s of skins) {
        items.push(toItem(s));
        for (const c of chromasOf(s.skinId)) items.push(toChroma(c));
      }
      groups.push({ label: '', sub: '', items });
    }
    // 去掉空组
    return groups.filter(g => g.items.length);
  }

  async function generate(kind) {
    mark('generate:start');
    let groups;
    try { groups = buildGroups(); } catch (e) { alert(e.message); return; }
    mark('generate:groups=' + groups.length);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (!total) { alert('没有可拼图的皮肤'); return; }
    mark('generate:total=' + total);

    let cols = +$('#cols').value;
    const cellW0 = +$('#cellW').value;
    let cellW = cellW0;
    let scale = +$('#scale').value;
    const pageMode = $('#pages').value;              // 'auto' 或 页数
    const wantOptimize = $('#optOptimize').checked;
    const a = state.analysis;
    const subtitle = $('#subtitle').value.trim() ||
      (a ? `${a.ownedSkinCount} 款皮肤 · ${a.ownedChromaCount} 个炫彩 · 收藏评分 ${Math.round(a.score)} · ${a.level.name}`
        : `${DB.stats.skinCount} 款皮肤 · ${DB.stats.chromaCount} 个炫彩（全图鉴）`);
    const title = $('#title').value.trim() || '我的皮肤收藏';

    let plan = null;      // {pages, cols, cellW, scale, opts}
    if (kind === 'grid') {
      plan = planGridPages(groups, { cols, cellW, scale, pageMode, wantOptimize, total });
      if (plan.error) { alert(plan.error); return; }
      cols = plan.cols; cellW = plan.cellW; scale = plan.scale;
      if (plan.note) note(plan.note);
      if (plan.pages.length > 1 && total > 400) {
        const go = confirm(`本次共 ${total} 张，会分成 ${plan.pages.length} 页（每页约 ${plan.perPage} 张）导出，继续吗？`);
        if (!go) return;
      }
    }
    mark('generate:size-ok');

    showProgress(true, `准备渲染 ${total} 张图片…`);

    try {
      if (kind === 'grid') {
        const opt = { cols, cellW, scale };
        const N = plan.pages.length;
        const renderOne = async (i) => {
          const pg = plan.pages[i];
          const n = pg.reduce((s, g) => s + g.items.length, 0);
          showProgress(true, `第 ${i + 1}/${N} 页：准备渲染 ${n} 张…`);
          const cv = await renderGrid({
            title, subtitle,
            pageIndex: i + 1, pageCount: N,
            rightText: `${n} 张`,
            footer: `LOL 皮肤拼图工坊 · 数据版本 ${DB.meta.version || ''} · ${new Date().toLocaleString('zh-CN')}`,
            groups: pg,
            opt,
          }, (d, t, phase) => showProgress(true,
            `第 ${i + 1}/${N} 页：` + (phase === 'draw' ? `绘制 ${d}/${t}` : `加载图片 ${d}/${t}`)));
          showProgress(false);
          return cv;
        };
        // 只在需要时渲染当前页（47 页一次性全渲染会占掉数 GB 内存）
        await openCollage({
          render: renderOne,
          count: N,
          nameFor: i => `${title}_第${i + 1}页共${N}页.png`,
          baseName: title,
        });
      } else {
        const featPool = (a ? a.owned : DB.skins.map(s => ({ skin: s, rarity: DB.rarityOf(s) })))
          .filter(o => !o.skin.isBase)
          .sort((x, y) => y.rarity.weight - x.rarity.weight);
        const featured = featPool.slice(0, 4).map(o => ({
          skinId: o.skin.skinId, name: o.skin.name, rarity: o.rarity,
        }));
        const bgIds = featPool.slice(0, 64).map(o => o.skin.skinId);
        const rarityRows = a ? a.rarityAgg : aggregateAllRarity();
        const heroRows = a
          ? a.perHero.filter(h => h.own > 0).slice(0, 8)
            .map(h => ({ name: h.hero.title, own: h.own, total: h.total, chromaOwn: h.chromaOwn, score: h.score }))
          : topHeroesAll();
        const canvas = await renderPoster({
          width: 1600, scale,
          kicker: '英雄联盟 皮肤收藏',
          bigNumber: String(a ? a.ownedSkinCount : DB.stats.skinCount),
          bigLabel: a ? `款皮肤 · 另有 ${a.ownedChromaCount} 个炫彩` : '款皮肤（全图鉴）',
          levelName: a ? a.level.name : '全图鉴',
          levelColor: a ? a.level.color : '#c8a24a',
          score: a ? a.score : 0,
          featured, bgIds, rarityRows, heroes: heroRows,
          footer: `数据版本 ${DB.meta.version || ''} · 生成于 ${new Date().toLocaleString('zh-CN')} · LOL 皮肤拼图工坊`,
        });
        showCollage([canvas], [`LOL皮肤海报_${a ? a.ownedSkinCount : '全图鉴'}.png`]);
      }
    } catch (e) {
      console.error(e);
      alert('生成失败：' + e.message);
    } finally {
      showProgress(false);
    }
  }

  /**
   * 决定分页方案：先尝试优化尺寸以便一页装下，再按需要分页。
   * 返回 {pages, cols, cellW, scale, note, perPage} 或 {error}
   */
  function planGridPages(groups, cfg) {
    const { pageMode, wantOptimize, total } = cfg;
    let cols = cfg.cols, cellW = cfg.cellW, scale = cfg.scale;
    let note = '';

    const fitNow = () => window.CollageCore.estimateGrid(groups, { cols, cellW, scale });

    // 1) 先看当前设置是否放得下；放不下且允许优化时，尝试缩小格子/增加列数
    let est = fitNow();
    if (est.over && wantOptimize) {
      const best = window.CollageCore.optimizeGrid(groups, { cols, cellW, scale });
      if (best) {
        note = `内容较多，已自动调整为 ${best.cols} 列 / 格子宽 ${best.cellW}px，以便一页放下`;
        cols = best.cols; cellW = best.cellW;
        est = fitNow();
      }
    }
    // 2) 仍然超限：降倍率
    if (est.over) {
      const ms = window.CollageCore.fitScale(groups, { cols, cellW });
      if (ms >= 1 && ms < scale) {
        scale = ms;
        note = (note ? note + '；' : '') + `已把导出倍率调整为 ${ms}x`;
        est = fitNow();
      }
    }

    // 3) 需要分页吗
    const C = window.CollageCore;
    const needSplit = est.over;
    let pages;
    if (pageMode === 'auto') {
      pages = C.splitPages(groups, { cols, cellW, scale }).pages;
    } else {
      const want = Math.max(1, Number(pageMode));
      if (want === 1) {
        if (needSplit) {
          return { error: `当前设置下一页放不下（需要 ${est.W} × ${est.H}px，上限 ${est.limit}px）。\n` +
            `请减少内容、减小格子宽，或把「分页」设为自动/多页。` };
        }
        pages = [groups.filter(g => g.items.length)];
      } else {
        pages = C.splitEvenly(groups, { cols, cellW, scale }, want);
        const minPages = C.splitPages(groups, { cols, cellW, scale }).pages.length;
        if (minPages > want) {
          note = (note ? note + '；' : '') +
            `按当前格子宽，${want} 页装不下，最少需要 ${minPages} 页，已按 ${pages.length} 页导出`;
        }
      }
    }
    if (!pages.length) return { error: '没有可拼图的内容' };

    // 每页都必须能放下，否则提示用户
    for (let i = 0; i < pages.length; i++) {
      const e2 = C.estimateGrid(pages[i], { cols, cellW, scale });
      if (e2.over) {
        return { error: `第 ${i + 1} 页仍然超限（${e2.W}×${e2.H}px）。请减小格子宽、增加列数，或增加页数。` };
      }
    }
    const perPage = Math.round(total / pages.length);
    if (pages.length > 1) {
      note = (note ? note + '；' : '') + `已分成 ${pages.length} 页，每页约 ${perPage} 张`;
    }
    return { pages, cols, cellW, scale, note, perPage };
  }

  function aggregateAllRarity() {
    const m = new Map();
    for (const s of DB.skins) {
      const r = DB.rarityOf(s);
      const cur = m.get(r.key) || { ...r, count: 0, chromaCount: 0 };
      cur.count++;
      cur.chromaCount += (DB.childrenChromas[s.skinId] || []).length;
      m.set(r.key, cur);
    }
    return [...m.values()].sort((a, b) => b.weight - a.weight);
  }
  function topHeroesAll() {
    return DB.heroes.map(h => {
      const list = DB.childrenSkins[h.heroId] || [];
      return {
        name: h.title, own: list.length, total: list.length,
        chromaOwn: list.reduce((n, s) => n + (DB.childrenChromas[s.skinId] || []).length, 0),
        score: list.reduce((n, s) => n + DB.rarityOf(s).weight, 0),
      };
    }).sort((a, b) => b.score - a.score).slice(0, 8);
  }

  /**
   * 打开拼图查看器。分页时采用"按需渲染 + LRU 缓存"：
   * 47 页一次性全渲染会同时占住数十张巨幅画布（数 GB），必须只保留当前页和最近几页。
   */
  async function openCollage(cfg) {
    resetStage();
    state.collageMeta = cfg;
    state.cache = new Map();
    state.cacheOrder = [];
    state.page = 0;
    const N = cfg.count;
    const tabs = $('#pageTabs');
    tabs.innerHTML = N > 1
      ? Array.from({ length: N }, (_, i) => `<button data-p="${i}">第 ${i + 1} 页</button>`).join('')
      : '';
    if (N > 1) tabs.querySelectorAll('button').forEach(b => b.onclick = () => gotoPage(+b.dataset.p));
    $('#downloadAll').hidden = N < 2;
    $('#downloadAll').onclick = downloadAllPages;
    await gotoPage(0);
  }

  function resetStage() {
    const body = $('#stageBody');
    body.querySelectorAll('canvas').forEach(cv => releaseCanvas(cv));
    dropGalleryCards(body);
    state.collages = [];
    state.cache = new Map();
    state.cacheOrder = [];
    state.collageMeta = null;
    $('#pageTabs').innerHTML = '';
    $('#download').hidden = true;
    $('#downloadAll').hidden = true;
  }

  /** 取第 i 页画布：命中缓存直接用，否则渲染并做 LRU 淘汰 */
  async function getPage(i) {
    const meta = state.collageMeta;
    if (!meta) return null;
    if (state.cache.has(i)) return state.cache.get(i);
    const cv = await meta.render(i);
    state.cache.set(i, cv);
    state.cacheOrder.push(i);
    const MAX_CACHED = 3;
    while (state.cacheOrder.length > MAX_CACHED) {
      const old = state.cacheOrder.shift();
      if (old === state.page) { state.cacheOrder.push(old); continue; }  // 当前页不淘汰
      const oc = state.cache.get(old);
      state.cache.delete(old);
      releaseCanvas(oc);
    }
    return cv;
  }

  async function gotoPage(i) {
    const meta = state.collageMeta;
    if (!meta) return;
    i = Math.max(0, Math.min(meta.count - 1, i));
    state.page = i;
    $('#pageTabs').querySelectorAll('button').forEach(b =>
      b.classList.toggle('is-active', +b.dataset.p === i));
    $('#stageTitle').textContent = meta.nameFor(i).replace(/\.png$/, '');
    if (!state.cache.has(i)) $('#stageSub').textContent = `正在渲染第 ${i + 1} 页…`;
    let canvas;
    try {
      canvas = await getPage(i);
    } catch (e) {
      console.error(e);
      $('#stageSub').textContent = '渲染失败：' + e.message;
      return;
    }
    const body = $('#stageBody');
    body.querySelectorAll('canvas').forEach(cv => { cv.style.display = 'none'; });
    if (!canvas.parentNode) body.appendChild(canvas);
    canvas.style.display = 'block';
    canvas.style.width = '';
    state.zoom = Math.min(1, 1400 / canvas.width);
    applyZoom();
    const N = meta.count;
    $('#download').hidden = false;
    $('#download').textContent = N > 1 ? `下载第 ${i + 1} 页 PNG` : '下载 PNG';
    $('#download').onclick = async () => {
      const size = await downloadCanvas(canvas, meta.nameFor(i));
      $('#stageSub').textContent = `已下载 ${(size / 1048576).toFixed(1)} MB`;
    };
    const perf = canvas.__perf;
    $('#stageSub').textContent = (N > 1 ? `第 ${i + 1}/${N} 页 · ` : '') +
      `${canvas.width} × ${canvas.height} px` + (perf ? ` · 共 ${perf.cells} 格` : '');
  }

  /** 下载全部页：按需逐页渲染 → 导出 → 立即释放，内存始终只留一页 */
  async function downloadAllPages() {
    const meta = state.collageMeta;
    if (!meta) return;
    const N = meta.count;
    let total = 0;
    const btn = $('#downloadAll');
    btn.disabled = true;
    try {
      for (let i = 0; i < N; i++) {
        const cv = await getPage(i);
        $('#stageSub').textContent = `正在导出第 ${i + 1}/${N} 页…`;
        total += await downloadCanvas(cv, meta.nameFor(i));
        await new Promise(r => setTimeout(r, 350));   // 连续下载太快会被浏览器拦截
      }
      $('#stageSub').textContent = `已下载全部 ${N} 页，共 ${(total / 1048576).toFixed(1)} MB`;
    } catch (e) {
      alert('批量下载中断：' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function showCollage(canvases, names) {
    // 海报等单页场景仍走这里
    resetStage();
    state.collageMeta = {
      render: () => canvases[0], count: canvases.length,
      nameFor: i => names[i], baseName: names[0].replace(/\.png$/, ''),
    };
    state.cache = new Map([[0, canvases[0]]]);
    state.cacheOrder = [0];
    $('#pageTabs').innerHTML = '';
    const meta = state.collageMeta;
    const body = $('#stageBody');
    const canvas = canvases[0];
    body.appendChild(canvas);
    canvas.style.display = 'block';
    state.page = 0;
    state.zoom = Math.min(1, 1400 / canvas.width);
    applyZoom();
    $('#download').hidden = false;
    $('#download').textContent = '下载 PNG';
    $('#download').onclick = async () => {
      const size = await downloadCanvas(canvas, meta.nameFor(0));
      $('#stageSub').textContent = `已下载 ${(size / 1048576).toFixed(1)} MB`;
    };
    $('#stageTitle').textContent = meta.nameFor(0).replace(/\.png$/, '');
    const perf = canvas.__perf;
    $('#stageSub').textContent = `${canvas.width} × ${canvas.height} px` +
      (perf ? ` · 共 ${perf.cells} 格` : '');
  }

  function applyZoom() {
    const cv = $('#stageBody canvas');
    if (!cv) return;
    cv.style.width = Math.round(cv.width * state.zoom) + 'px';
    $('#zoomVal').textContent = Math.round(state.zoom * 100) + '%';
  }

  /** 让预览宽度贴合可视区 */
  function zoomToFit() {
    const cv = $('#stageBody canvas');
    if (!cv) return;
    const body = $('#stageBody');
    const avail = body.clientWidth - 36;
    state.zoom = Math.max(0.05, Math.min(1, avail / cv.width));
    applyZoom();
  }

  function showProgress(on, text) {
    const bar = $('#progressBar');
    bar.hidden = !on;
    if (!on) return;
    bar.querySelector('.ptext').textContent = text || '';
    const m = /(\d+)\/(\d+)/.exec(text || '');
    const p = m ? (+m[1] / +m[2] * 100) : 8;
    bar.querySelector('.track i').style.width = Math.min(100, p) + '%';
  }

  /* ============================================================
   * initUI
   * ============================================================ */
  function initUI() {
    initTabs();
    initMe();

    // 图鉴交互
    let t = null;
    const rerun = () => { clearTimeout(t); t = setTimeout(buildBrowseList, 180); };
    $('#q').addEventListener('input', rerun);
    $('#sort').addEventListener('change', buildBrowseList);
    $('#onlyChroma').addEventListener('change', buildBrowseList);
    $('#loadMore').addEventListener('click', loadMoreBrowse);
    $('#missingMore').addEventListener('click', loadMoreMissing);

    // 图鉴点击卡片：在下方展开该皮肤的全部炫彩
    $('#gallery').addEventListener('click', e => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.skin;
      if (!DB.skinById[id]) return;
      const chromas = DB.childrenChromas[id] || [];
      if (!chromas.length) return;
      state.previewHeroId = state.previewHeroId === id ? null : id;
      renderChromaStrip();
      const strip = $('#chromaStrip');
      if (!strip.hidden) strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // 拼图控件
    const bindRange = (id, suffix, fn) => {
      const el = $('#' + id);
      el.addEventListener('input', () => {
        $('#' + id + 'Val').textContent = el.value + (suffix || '');
        if (fn) fn();
      });
    };
    bindRange('cols', '', updateSizeHint);
    bindRange('cellW', '', updateSizeHint);
    bindRange('scale', 'x', updateSizeHint);
    ['optChroma', 'optBase', 'optGroup', 'optTag', 'optOptimize'].forEach(id =>
      $('#' + id).addEventListener('change', updateSizeHint));
    $('#pages').addEventListener('change', () => {
      const v = $('#pages').value;
      if (v === '1') $('#optOptimize').checked = true;
      updateSizeHint();
    });
    $$('input[name=scope]').forEach(r => r.addEventListener('change', updateSizeHint));
    $('#genGrid').addEventListener('click', () => generate('grid'));
    $('#genPoster').addEventListener('click', () => generate('poster'));
    $('#zoomIn').addEventListener('click', () => { state.zoom = Math.min(3, state.zoom * 1.25); applyZoom(); });
    $('#zoomOut').addEventListener('click', () => { state.zoom = Math.max(0.05, state.zoom / 1.25); applyZoom(); });
    $('#zoomFit').addEventListener('click', zoomToFit);
    $('#zoom100').addEventListener('click', () => { state.zoom = 1; applyZoom(); });

    buildBrowseList();
    updateSizeHint();
    runSelfTest();
  }

  /* ---- 自检钩子：?selftest=account|me|images|grid|poster [&limit=N] ---- */
  async function runSelfTest() {
    const qs = new URLSearchParams(location.search);
    const mode = qs.get('selftest');
    if (!mode) return;
    // 自检模式下弹窗会永久阻塞主线程（无头浏览器没人点确认），改为记录
    const dialogs = [];
    window.alert = m => { dialogs.push('alert: ' + m); };
    window.confirm = m => { dialogs.push('confirm: ' + m); return true; };
    window.__dialogs = dialogs;
    window.__selftest = 'running';
    try {
      // ---- 分支 1：真实账号文件（走完整 UI 流程）----
      if (mode === 'account') {
        const text = await (await fetch('_real_gets.json', { cache: 'no-store' })).text();
        const res = parseAccountText(text);
        if (!res) throw new Error('解析失败');
        applyOwned(res.ids, { source: '真实账号文件（自检）', res });
        window.__account = {
          format: res.format,
          heroes: res.heroIds.length,
          skins: res.skinEntries,
          chromas: res.chromaEntries,
          unknown: res.unknown.length,
          kpiSkin: $('#kpiSkin').textContent,
          kpiChroma: $('#kpiChroma').textContent,
          kpiScore: $('#kpiScore').textContent,
          kpiLevel: $('#kpiLevel').textContent,
          heroRows: document.querySelectorAll('#heroRank .hr-row').length,
          timelineCards: document.querySelectorAll('#timelineGallery .card').length,
        };
        window.__selftest = 'done';
        return;
      }

      // ---- 其余分支基于内置演示账号 ----
      const demoIds = new Set();
      const demoEntries = [];
      const now = Math.floor(Date.now() / 1000);
      DB.skins.forEach((s, i) => {
        if (!s.isBase && (i % 5 === 0 || /传说|终极|至臻|神话/.test(s.name))) {
          demoIds.add(s.skinId);
          demoEntries.push({ heroId: s.heroId, skinId: s.skinId, isChroma: false, createTime: now - i * 3600 });
        }
      });
      DB.chromas.forEach((c, i) => {
        if (i % 41 === 0) {
          demoIds.add(c.skinId);
          demoEntries.push({ heroId: c.heroId, skinId: c.skinId, isChroma: true, createTime: now - i * 600 });
        }
      });
      const demoRes = {
        format: 'championSkins', entries: demoEntries, count: demoEntries.length,
        heroIds: [...new Set(demoEntries.map(e => e.heroId))], unknown: [],
        skinEntries: demoEntries.filter(e => !e.isChroma).length,
        chromaEntries: demoEntries.filter(e => e.isChroma).length,
      };
      mark('selftest:apply-owned');
      applyOwned(demoIds, { source: '自检演示数据', res: demoRes });
      mark('selftest:applied');
      if (mode === 'me') { window.__selftest = 'done'; return; }

      window.__goTab('collage');
      if (qs.get('all')) {
        // 模拟"全图鉴"路径
        $$('input[name=scope]').forEach(r => { r.checked = r.value === 'all'; });
      }
      if (mode === 'grid') {
        const c = Number(qs.get('cols') || 8);
        const cw = Number(qs.get('cellw') || 200);
        const sc = Number(qs.get('scale') || 1);
        $('#cols').value = c; $('#cellW').value = cw; $('#scale').value = sc;
        $('#colsVal').textContent = c; $('#cellWVal').textContent = cw; $('#scaleVal').textContent = sc + 'x';
        if (qs.get('pages')) $('#pages').value = qs.get('pages');
      }
      const limit = Number(qs.get('limit') || 0);
      if (limit) {
        // 限量子集：只保留前 limit 款皮肤，用于受控性能测量
        const picked = [...demoIds].slice(0, limit);
        const sub = new Set();
        for (const id of picked) {
          sub.add(id);
          const c = DB.chromaById[id];
          if (c && c.parentId) sub.add(c.parentId);
        }
        state.analysis = analyzeOwnership(sub, { includeChroma: true, countBase: true });
        state.ownedIds = sub;
        updateSizeHint();   // 子集变更后要同步侧栏预估
      }
      mark('selftest:before-generate');
      if (mode === 'images') {
        // 只测图片批量加载，不渲染
        const ids = [...new Set([...state.analysis.ownedSkinIds, ...state.analysis.ownedChromaIds])];
        const t0 = performance.now();
        let ok = 0, fail = 0;
        const queue = ids.slice();
        await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
          while (queue.length) {
            const sid = queue.shift();
            const bm = await window.CollageCore.loadBitmap(sid, 200, 364);
            if (bm) { ok++; if (bm.close) bm.close(); } else fail++;
          }
        }));
        window.__imgProbe = { total: ids.length, ok, fail, ms: Math.round(performance.now() - t0) };
        window.__selftest = 'done';
        return;
      }
      await generate(mode === 'grid' ? 'grid' : 'poster');
      mark('selftest:after-generate');
      if (/poster|grid/.test(mode)) {
        // 自检可指定停留页：?page=2
        const wantPage = Number(qs.get('page') || 1);
        if (wantPage > 1 && state.collageMeta) await gotoPage(wantPage - 1);
        $('#stageBody').scrollTop = 0; $('#stageBody').scrollLeft = 0;
      }
      const perf = window.CollageCore.lastPerf;
      if (perf) $('#stageSub').textContent += ` · 图片 ${perf.loadMs}ms / 绘制 ${perf.drawMs}ms（共 ${perf.cells} 格）`;
      if (qs.get('export')) {
        // 验证导出链路真的能产出 PNG（无头环境下走 downloadCanvas 会弹下载框，所以只测 toBlob）
        const cv = $('#stageBody canvas');
        window.__exportSize = cv ? await new Promise(res => cv.toBlob(b => res(b ? b.size : 0), 'image/png')) : 0;
      }
      window.__selftest = 'done';
    } catch (e) {
      console.error(e);
      window.__selftest = 'error: ' + e.message;
    }
  }

  /** 实时预估网格成品尺寸 / 页数 */
  function updateSizeHint() {
    const el = $('#sizeHint');
    let groups;
    try { groups = buildGroups(); } catch (e) { el.textContent = e.message; el.style.color = '#ff8f8f'; return; }
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    const opt = { cols: +$('#cols').value, cellW: +$('#cellW').value, scale: +$('#scale').value };
    const est = window.CollageCore.estimateGrid(groups, opt);
    const mode = $('#pages').value;
    let pages = 1;
    if (mode === 'auto') pages = window.CollageCore.splitPages(groups, opt).pages.length || 1;
    else pages = Math.max(1, Number(mode));
    const over = est.over;
    el.style.color = over && pages <= 1 ? '#ff8f8f' : '';
    el.textContent = `共 ${total} 张 · ${pages > 1 ? pages + ' 页 · ' : ''}` +
      `单页 ${est.W} × ${est.H} px（${(est.pixels / 1e6).toFixed(0)} 百万像素）` +
      (over && pages <= 1 ? '　超出上限，请降低倍率或缩小格子' : '');
  }

  boot();
})();
