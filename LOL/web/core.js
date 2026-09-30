/* ============================================================
 * LOL 皮肤拼图 - 核心逻辑层 (无依赖)
 *  - 数据加载 (heroes/skins/chromas/images/icons)
 *  - 账号数据解析 (格式自适应)
 *  - 拥有判定 + 品质分级
 *  - Canvas 拼图渲染 (grid / poster) + PNG 导出
 * ============================================================ */
(function (global) {
  'use strict';

  const DATA = '../data/';
  const RARITIES = [
    { key: 'ultimate', name: '终极', color: '#ff5f5f', weight: 100, regex: /终极|ultimate/i },
    { key: 'mythic', name: '神话', color: '#ff7a18', weight: 60, regex: /神话|mythic/i },
    { key: 'prestige', name: '至臻', color: '#ffd45e', weight: 50, regex: /至臻|prestige/i },
    { key: 'legendary', name: '传说', color: '#ffb545', weight: 30, regex: /传说|legendary/i },
    { key: 'epic', name: '史诗', color: '#a06bff', weight: 12, regex: /史诗|epic/i },
    { key: 'legacy', name: '限定', color: '#4fd1c5', weight: 10, regex: /限定|limited/i },
    { key: 'other', name: '普通', color: '#8b9bb4', weight: 0, regex: null },
  ];
  const CHROMA_RARITY = { key: 'chroma', name: '炫彩', color: '#63b3ff', weight: 1.5 };
  const BASE_RARITY = { key: 'base', name: '原皮肤', color: '#5a6b82', weight: 0 };

  /** 账号文件里的获取时间戳 -> ISO 日期字符串 */
  function tsToDate(t) {
    if (!t) return '';
    const d = new Date(t * 1000);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* ---------- 工具 ---------- */
  const byId = (arr, k) => arr.reduce((m, x) => (m[x[k]] = x, m), {});
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }
  function jsonp(url) {
    return fetch(url).then(r => { if (!r.ok) throw new Error(url + ' -> ' + r.status); return r.json(); });
  }

  /* ============================================================
   * 数据库
   * ============================================================ */
  const DB = {
    heroes: [], skins: [], chromas: [], images: {}, icons: {}, meta: {}, stats: {},
    heroById: {}, skinById: {}, chromaById: {},
    childrenChromas: {},          // parentId -> [chroma]
    childrenSkins: {},            // heroId  -> [skin]
    loaded: false,

    async load(onProgress) {
      const steps = [
        ['heroes.json', 'heroes', false], ['skins.json', 'skins', false],
        ['chromas.json', 'chromas', false], ['images.json', 'images', true],
        ['icons.json', 'icons', true], ['meta.json', 'meta', false],
      ];
      let i = 0;
      for (const [file, key, optional] of steps) {
        try {
          this[key] = await jsonp(DATA + file);
        } catch (e) {
          if (optional) { this[key] = {}; }
          else throw new Error(`加载 ${file} 失败：${e.message}\n请先运行 tools/organize_data.py`);
        }
        if (onProgress) onProgress(++i / steps.length, file);
      }
      this.imageMissing = Object.keys(this.images).length === 0;
      this.stats = this.meta.stats || {};
      // 本地图片缺失时的在线兜底地址
      this.remote = {};
      for (const s of this.skins) this.remote[s.skinId] = s.loadingImg || s.mainImg || s.centerImg || s.iconImg || '';
      for (const c of this.chromas) if (c.img) this.remote[c.skinId] = c.img;
      this.heroById = byId(this.heroes, 'heroId');
      this.skinById = byId(this.skins, 'skinId');
      this.chromaById = byId(this.chromas, 'skinId');
      this.childrenChromas = {};
      for (const c of this.chromas) (this.childrenChromas[c.parentId] ||= []).push(c);
      this.childrenSkins = {};
      for (const s of this.skins) (this.childrenSkins[s.heroId] ||= []).push(s);
      for (const hid in this.childrenSkins) {
        this.childrenSkins[hid].sort((a, b) => (b.isBase - a.isBase) || (Number(a.skinId) - Number(b.skinId)));
      }
      this.loaded = true;
      return this;
    },

    /** 取本地图片路径; 找不到返回 '' */
    imageFor(skinId) { return this.images[skinId] || ''; },
    iconFor(skinId) { return this.icons[skinId] || ''; },
    remoteFor(skinId) { return this.remote[skinId] || ''; },
    /** 卡片 src：优先本地，缺失时用在线图 */
    srcFor(skinId, preferRemote) {
      const local = this.images[skinId];
      if (local && !preferRemote) return '../' + local;
      return this.remote[skinId] || (local ? '../' + local : '');
    },

    heroName(hid) {
      const h = this.heroById[hid];
      return h ? h.title : '英雄' + hid;
    },
    heroFullName(hid) {
      const h = this.heroById[hid];
      return h ? `${h.title} · ${h.name}` : '英雄' + hid;
    },

    /** 判定一款皮肤的品质 */
    rarityOf(item) {
      const isChroma = !!this.chromaById[item.skinId];
      if (isChroma) return CHROMA_RARITY;
      if (item.isBase) return BASE_RARITY;
      const hay = [item.name, item.emblems, item.label].join(' ');
      for (const r of RARITIES) if (r.regex && r.regex.test(hay)) return r;
      return RARITIES[RARITIES.length - 1];
    },

    /** 把任意 id 解析成可展示的"拥有项" */
    resolve(id) {
      if (this.skinById[id]) return { kind: 'skin', item: this.skinById[id] };
      if (this.chromaById[id]) return { kind: 'chroma', item: this.chromaById[id] };
      return null;
    },
  };

  /* ============================================================
   * 账号数据解析 —— 格式自适应
   * ============================================================ */
  const ID_KEYS = ['skinId', 'skin_id', 'skinID', 'id', 'skinid', 'SkinID', 'skinIds', 'skin_ids'];
  const WRAP_KEYS = ['skins', 'skinList', 'skin_list', 'data', 'list', 'items', 'result', 'ownSkins',
    'ownedSkins', 'userSkins', 'skinData', 'skin_data', 'assets', 'champions', 'loot', 'records'];

  function extractIds(node, out, depth) {
    if (node == null || depth > 8) return;
    if (typeof node === 'number') {
      if (Number.isInteger(node) && node > 0) out.push(String(node));
      return;
    }
    if (typeof node === 'string') {
      const s = node.trim();
      if (/^\d{3,}$/.test(s)) { out.push(s); return; }
      // "1001,1002,1003" / "skinId=1001" 之类
      const ms = s.match(/\d{3,}/g);
      if (ms && ms.length && s.split(',').length > 1) ms.forEach(m => out.push(m));
      return;
    }
    if (Array.isArray(node)) { node.forEach(n => extractIds(n, out, depth + 1)); return; }
    if (typeof node === 'object') {
      // 优先取明确的 id 字段
      let hit = false;
      for (const k of ID_KEYS) {
        if (k in node && (typeof node[k] === 'string' || typeof node[k] === 'number')) {
          const v = String(node[k]).trim();
          if (/^\d{3,}$/.test(v)) { out.push(v); hit = true; break; }
        }
      }
      for (const k of Object.keys(node)) {
        if (WRAP_KEYS.includes(k) || Array.isArray(node[k]) || typeof node[k] === 'object') {
          extractIds(node[k], out, depth + 1);
        }
      }
      if (!hit) return;
    }
  }

  /**
   * 识别"英雄联盟账号皮肤导出"格式（Getskin.js / WeGame / 掌盟导出）。
   *
   * 真实结构：
   * {
   *   "result": { "error_code": 0, "error_message": "success" },
   *   "championSkins": [
   *     { "id": 101, "skins": [ { "id": 101002, "create_time": "1630746527", "chromas": 0 }, ... ] },
   *     ...
   *   ],
   *   "champion_num": 173, "skin_num": 1623
   * }
   *
   * 要点（实测）：
   *   - `chromas` 是标志位：1 = 这一条本身就是炫彩条目，0 = 普通皮肤；不是"可用炫彩数量"
   *   - 账户文件里**不含原皮肤**条目（原皮肤随英雄赠送，不单独列出）
   *   - 炫彩条目能通过 chromas.json 精确挂回父皮肤
   *   - create_time 是获取时间戳，可用来做"收藏时间线"
   */
  function parseChampionSkins(parsed) {
    const list = parsed && (parsed.championSkins || parsed.champion_skins);
    if (!Array.isArray(list)) return null;

    const entries = [];          // { heroId, skinId, isChroma, createTime }
    const heroIds = new Set();
    for (const champ of list) {
      if (!champ || typeof champ !== 'object') continue;
      const hid = String(champ.id == null ? '' : champ.id).trim();
      if (!/^\d+$/.test(hid)) continue;
      const skins = Array.isArray(champ.skins) ? champ.skins : [];
      let heroHas = false;
      for (const s of skins) {
        if (!s || typeof s !== 'object') continue;
        const sid = String(s.id == null ? '' : s.id).trim();
        if (!/^\d+$/.test(sid)) continue;
        const t = Number(s.create_time) || 0;
        entries.push({
          heroId: hid,
          skinId: sid,
          isChroma: Number(s.chromas) === 1,
          createTime: t,
          expireDay: Number(s.expire_day) || 0,
        });
        heroHas = true;
      }
      if (heroHas) heroIds.add(hid);
    }
    if (!entries.length) return null;

    const ids = new Set();
    const unknown = [];
    for (const e of entries) {
      if (DB.resolve(e.skinId)) ids.add(e.skinId);
      else unknown.push(e.skinId);
    }
    return {
      format: 'championSkins',
      ids,
      raw: entries.map(e => e.skinId),
      entries,
      heroIds: [...heroIds],
      unknown: [...new Set(unknown)],
      declared: {
        championNum: parsed.champion_num,
        skinNum: parsed.skin_num,
        errorCode: parsed.result && parsed.result.error_code,
      },
      count: entries.length,
      skinEntries: entries.filter(e => !e.isChroma).length,
      chromaEntries: entries.filter(e => e.isChroma).length,
    };
  }

  /**
   * 解析账号文件文本。
   * 优先识别官方导出格式（championSkins），否则退回通用递归提取。
   * @returns {{ids:Set, raw:[], unknown:[], entries?:[], format:string, ...}}
   */
  function parseAccountText(text) {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    let parsed = null, parseErr = null;
    const attempts = [
      () => JSON.parse(trimmed),
      () => JSON.parse(trimmed.replace(/^[^[{]*/, '').replace(/;\s*$/, '')),
      () => { const m = trimmed.match(/[\[{][\s\S]*[\]}]/); if (!m) throw new Error('no json'); return JSON.parse(m[0]); },
    ];
    for (const a of attempts) { try { parsed = a(); break; } catch (e) { parseErr = e; } }

    if (parsed !== null) {
      const champ = parseChampionSkins(parsed);
      if (champ) return champ;
    }

    const raw = [];
    if (parsed !== null) extractIds(parsed, raw, 0);
    else raw.push(...(trimmed.match(/\d{3,}/g) || []));

    const ids = new Set(), unknown = [];
    for (const id of raw) {
      if (DB.resolve(id)) ids.add(id);
      else unknown.push(id);
    }
    return {
      format: 'generic', ids, raw, entries: null,
      unknown: [...new Set(unknown)], parsed, parseErr, count: raw.length,
    };
  }

  /* ============================================================
   * 拥有分析
   * ============================================================ */
  /**
   * @param {Set<string>} ownIds
   * @param {{
   *   includeChroma?:boolean, countBase?:boolean,
   *   entries?:Array<{skinId,heroId,isChroma,createTime}>,
   *   inferBase?:boolean
   * }} opt
   *   countBase  原皮肤是否计入统计
   *   inferBase  账号文件不含原皮肤时，是否把"已有该英雄皮肤"视作拥有原皮肤（默认开）
   *   entries    账号导出格式的明细，用于获取时间与精确炫彩数量
   */
  function analyzeOwnership(ownIds, opt) {
    const o = Object.assign({ includeChroma: true, countBase: false, inferBase: true }, opt || {});
    const entries = o.entries || null;
    const timeOf = {};        // skinId -> createTime
    if (entries) for (const e of entries) if (e.createTime) timeOf[e.skinId] = e.createTime;

    const ownedSkinIds = new Set();
    const ownedChromaIds = new Set();
    for (const id of ownIds) {
      const r = DB.resolve(id);
      if (!r) continue;
      if (r.kind === 'chroma') {
        if (o.includeChroma) ownedChromaIds.add(id);
      } else ownedSkinIds.add(id);
    }
    // 有炫彩即视为拥有父皮肤
    for (const cid of ownedChromaIds) {
      const p = DB.chromaById[cid].parentId;
      if (p) ownedSkinIds.add(p);
    }
    // 账号文件天生不含原皮肤（原皮肤随英雄赠送）：
    // 只要该英雄有任意一款皮肤/炫彩入账，就推断其原皮肤也拥有。
    let inferredBase = 0;
    if (o.inferBase && entries) {
      const heroesWithSkin = new Set();
      for (const sid of ownedSkinIds) {
        const sk = DB.skinById[sid];
        if (sk && !sk.isBase) heroesWithSkin.add(sk.heroId);
      }
      for (const hid of heroesWithSkin) {
        for (const sk of (DB.childrenSkins[hid] || [])) {
          if (sk.isBase && !ownedSkinIds.has(sk.skinId)) { ownedSkinIds.add(sk.skinId); inferredBase++; }
        }
      }
    }
    const effCountBase = o.countBase || inferredBase > 0;

    const perHero = [];
    const rarityAgg = {};
    let ownedSkinCount = 0, ownedChromaCount = ownedChromaIds.size, missingCount = 0;
    let score = 0, skinValue = 0, chromaValue = 0;

    for (const h of DB.heroes) {
      const list = DB.childrenSkins[h.heroId] || [];
      if (!list.length) continue;
      const rows = list.map(s => {
        const own = ownedSkinIds.has(s.skinId);
        const chromas = DB.childrenChromas[s.skinId] || [];
        const ownChromas = chromas.filter(c => ownedChromaIds.has(c.skinId));
        return {
          skin: s, chromas, owned: own, ownedChromas: ownChromas,
          ownChromaCount: ownChromas.length, chromaCount: chromas.length,
          createTime: timeOf[s.skinId] || 0,
          rarity: DB.rarityOf(s),
          complete: chromas.length > 0 && ownChromas.length === chromas.length,
        };
      }).filter(r => effCountBase || !r.skin.isBase);

      const ownRows = rows.filter(r => r.owned);
      const total = rows.length;
      const own = ownRows.length;
      if (own === 0) { perHero.push({ hero: h, total, own: 0, rows, chromaOwn: 0, chromaTotal: 0, score: 0 }); continue; }

      let heroScore = 0, heroChromaOwn = 0, heroChromaTotal = 0;
      for (const r of ownRows) {
        ownedSkinCount++;
        const rar = r.rarity;
        score += rar.weight; skinValue += rar.weight;
        heroScore += rar.weight;
        const agg = rarityAgg[rar.key] || (rarityAgg[rar.key] = { ...rar, count: 0, chromaCount: 0 });
        agg.count++;
        for (const c of r.ownedChromas) {
          const w = CHROMA_RARITY.weight;
          score += w; chromaValue += w; heroScore += w;
          agg.chromaCount++;
        }
        heroChromaOwn += r.ownedChromas.length;
      }
      for (const r of rows) {
        if (r.skin.isBase && !effCountBase) continue;
        if (!r.owned) missingCount++;
        heroChromaTotal += r.chromaCount;
      }
      perHero.push({
        hero: h, total, own, rows, score: heroScore,
        rate: total ? own / total : 0,
        chromaOwn: heroChromaOwn, chromaTotal: heroChromaTotal,
        maxRarity: ownRows.reduce((best, r) => (r.rarity.weight > best.weight ? r.rarity : best), BASE_RARITY),
      });
    }

    perHero.sort((a, b) => b.score - a.score || b.own - a.own);

    const owned = [], ownedChromaList = [];
    for (const hid of Object.keys(DB.childrenSkins)) {
      for (const s of DB.childrenSkins[hid]) {
        if (ownedSkinIds.has(s.skinId)) {
          const chromas = (DB.childrenChromas[s.skinId] || []).filter(c => ownedChromaIds.has(c.skinId));
          owned.push({
            skin: s, chromas, rarity: DB.rarityOf(s),
            createTime: timeOf[s.skinId] || 0,
            date: tsToDate(timeOf[s.skinId]),
            inferredBase: s.isBase && !o.countBase && inferredBase > 0 && !(entries && entries.some(e => e.skinId === s.skinId)),
          });
        }
      }
    }
    owned.sort((a, b) => b.rarity.weight - a.rarity.weight || Number(a.skin.skinId) - Number(b.skin.skinId));
    for (const c of DB.chromas) if (ownedChromaIds.has(c.skinId)) ownedChromaList.push(c);

    // 按获取时间排序的"收藏时间线"（账号导出格式才带时间戳）
    const timeline = owned.filter(x => x.createTime).slice().sort((a, b) => b.createTime - a.createTime);

    const rarList = Object.values(rarityAgg).sort((a, b) => b.weight - a.weight);
    const level = scoreTier(score);
    const paidOwned = owned.filter(x => !x.skin.isBase).length;

    return {
      ownedSkinIds, ownedChromaIds, owned, ownedChromaList, ownedSkinCount, ownedChromaCount,
      paidOwnedCount: paidOwned, inferredBase, countBase: effCountBase,
      missingCount, perHero, rarityAgg: rarList, score, skinValue, chromaValue, level,
      heroCovered: perHero.filter(h => h.own > 0).length, heroTotal: perHero.length,
      collectionRate: DB.stats.skinCount ? ownedSkinCount / DB.stats.skinCount : 0,
      completeSkins: perHero.reduce((n, h) => n + h.rows.filter(r => r.owned && r.complete).length, 0),
      timeline,
      hasTime: timeline.length > 0,
    };
  }

  function scoreTier(score) {
    const T = [
      [9000, '荣耀收藏家', '#ffd45e', '皮肤收藏已接近全服顶尖水准'],
      [5000, '资深召唤师', '#a06bff', '皮肤数量与品质都相当可观'],
      [2500, '活跃玩家', '#63b3ff', '已有不少心仪皮肤，继续扩充吧'],
      [1000, '入门召唤师', '#4fd1c5', '收藏刚刚起步，未来可期'],
      [0, '新手上路', '#8b9bb4', '从第一款传说皮肤开始'],
    ];
    for (const [min, name, color, desc] of T) if (score >= min) return { min, name, color, desc };
    return T[T.length - 1];
  }

  /* ============================================================
   * 图片加载
   * 内存要点：一张 308×560 的图解码后约 690 KB。全量图鉴有 9158 张，
   * 绝不能把它们全部留在缓存里，否则渲染进程会被 OOM 杀掉。
   * 因此：
   *   - 图鉴卡片不加 loading="lazy" 依赖（懒加载在滚动容器里不可靠）
   *   - 缓存可通过 setCacheEnabled(false) 关闭，长任务结束后必须 clearImageCache()
   * ============================================================ */
  const imgCache = new Map();
  const MAX_CACHE = 400;          // 最多缓存 400 张（约 270 MB 上限）
  let cacheEnabled = true;

  function setCacheEnabled(on) { cacheEnabled = !!on; }
  function clearImageCache() { imgCache.clear(); }
  function cacheStats() { return { size: imgCache.size, enabled: cacheEnabled }; }

  /** 释放画布占用的显存/内存（大画布动辄几百 MB，必须显式回收） */
  function releaseCanvas(cv) {
    if (!cv) return;
    try { cv.width = 0; cv.height = 0; } catch (e) { /* ignore */ }
    if (cv.parentNode) cv.parentNode.removeChild(cv);
  }

  function loadImage(src, timeoutMs) {
    if (!src) return Promise.resolve(null);
    if (cacheEnabled && imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((resolve, reject) => {
      const im = new Image();
      const timer = setTimeout(() => {
        im.onload = im.onerror = null;
        im.src = '';
        reject(new Error('图片加载超时: ' + src));
      }, timeoutMs || 25000);
      im.onload = () => { clearTimeout(timer); resolve(im); };
      im.onerror = () => { clearTimeout(timer); reject(new Error('图片加载失败: ' + src)); };
      im.src = src;
    }).catch(e => { if (cacheEnabled) imgCache.delete(src); throw e; });
    if (cacheEnabled) {
      if (imgCache.size >= MAX_CACHE) {
        // 简单 FIFO 淘汰，避免缓存无限增长
        const first = imgCache.keys().next();
        if (!first.done) imgCache.delete(first.value);
      }
      imgCache.set(src, p);
    }
    return p;
  }

  /** 圆角矩形路径 */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 等比裁剪填充（object-fit: cover），保证 308x560 与 270x303 视觉一致 */
  function drawCover(ctx, im, x, y, w, h, anchor) {
    if (!im) return;
    const iw = im.width, ih = im.height;
    if (!iw || !ih) return;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    const ay = anchor === 'top' ? 0 : anchor === 'bottom' ? 1 : 0.5;
    ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) * ay, dw, dh);
  }

  function ellipsis(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  /** 本地图优先，本地缺失/损坏时回退在线图 */
  async function loadImageSmart(skinId) {
    const local = DB.images[skinId];
    if (local) {
      try { return await loadImage('../' + local); } catch (e) { /* 回退 */ }
    }
    const remote = DB.remote[skinId];
    if (remote) { try { return await loadImage(remote); } catch (e) { return null; } }
    return null;
  }

  /**
   * 按"目标显示尺寸"加载图片（内存关键优化）。
   * createImageBitmap 带 resize 选项时可以做到「缩略解码」，避免先把 308×560 全尺寸位图
   * 放进内存再缩放；一张全尺寸图解码约 690 KB，上千张就会把渲染进程 OOM 杀掉。
   * 浏览器不支持时退回普通 Image。
   */
  async function loadBitmap(skinId, w, h) {
    const local = DB.images[skinId];
    const remote = DB.remote[skinId];
    const urls = [];
    if (local) urls.push('../' + local);
    if (remote) urls.push(remote);
    if (!urls.length) return null;
    if (typeof createImageBitmap === 'function') {
      for (const url of urls) {
        try {
          const r = await fetch(url, { cache: 'force-cache' });
          if (!r.ok) continue;
          const blob = await r.blob();
          if (w && h) {
            return await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
          }
          return await createImageBitmap(blob);
        } catch (e) { /* 试下一个来源 */ }
      }
    }
    for (const url of urls) {
      try { return await loadImage(url); } catch (e) { /* 试下一个来源 */ }
    }
    return null;
  }

  /** 在 #gallery 轮询等待所有 img 解码完成 */
  function waitForImages(root, timeout) {
    const imgs = [...root.querySelectorAll('img')];
    const t0 = Date.now();
    return new Promise(resolve => {
      (function tick() {
        const pending = imgs.filter(i => !i.complete);
        if (!pending.length || Date.now() - t0 > (timeout || 20000)) return resolve();
        setTimeout(tick, 80);
      })();
    });
  }

  /* ============================================================
   * 卡片 DOM
   * ============================================================ */
  function cardHTML(skin, opt) {
    const src = DB.srcFor(skin.skinId);
    const remote = DB.remoteFor(skin.skinId);
    const hero = DB.heroById[skin.heroId];
    const rarity = DB.rarityOf(skin);
    const chromas = DB.childrenChromas[skin.skinId] || [];
    const own = opt && opt.ownedIds ? opt.ownedIds.has(skin.skinId) : false;
    // 首屏卡片用 eager：lazy 在滚动容器里常常不触发，看起来就像"图片没出来"
    const lazyAttr = (opt && opt.eager) ? '' : ' loading="lazy"';
    const badge = skin.isBase ? '原皮肤'
      : (chromas.length ? `+${chromas.length} 炫彩` : (rarity.key === 'other' ? '' : rarity.name));
    return `
      <figure class="card r-${rarity.key} ${own ? 'is-owned' : ''}" data-skin="${skin.skinId}"
              title="${esc(DB.heroFullName(skin.heroId))} · ${esc(skin.name)}">
        <div class="thumb">
          ${src ? `<img${lazyAttr} src="${esc(src)}" data-remote="${esc(remote)}" alt="${esc(skin.name)}"
                 onerror="if(this.dataset.remote&&this.src!==this.dataset.remote){this.src=this.dataset.remote}else{this.style.display='none'}">` : '<div class="noimg">无图</div>'}
          ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
          ${own ? `<span class="own-mark">✓</span>` : ''}
        </div>
        <figcaption>
          <b>${esc(skin.name)}</b>
          <span>${esc(hero ? hero.title : '')}</span>
        </figcaption>
      </figure>`;
  }

  function chromaCardHTML(chroma, owned) {
    const src = DB.srcFor(chroma.skinId);
    const remote = DB.remoteFor(chroma.skinId);
    return `
      <figure class="card c-chroma ${owned ? 'is-owned' : ''}" data-skin="${chroma.skinId}"
              title="${esc(chroma.name)}">
        <div class="thumb"><img loading="lazy" src="${esc(src)}" data-remote="${esc(remote)}" alt="${esc(chroma.name)}"
          onerror="if(this.dataset.remote&&this.src!==this.dataset.remote){this.src=this.dataset.remote}else{this.style.display='none'}">
          ${owned ? '<span class="own-mark">✓</span>' : ''}</div>
        <figcaption><b>${esc(chroma.name)}</b><span>炫彩</span></figcaption>
      </figure>`;
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ============================================================
   * 拼图渲染：整齐网格长图
   * ============================================================ */
  const GRID_PRESET = {
    cols: 8, cellW: 200, cellH: 0, gap: 12, pad: 32,
    headerH: 168, groupGap: 30, groupHeaderH: 56, footerH: 62, scale: 1,
  };

  /**
   * @param {object} p
   *   items: [{type:'skin'|'chroma'|'group', label, sub, items:[...]}]
   *   opt:   GRID_PRESET 覆盖 + { title, subtitle, bgColor, cardBg, textColor, accent }
   */
  // 浏览器画布硬上限是 16384px，但一旦接近这个值，光栅化会慢到把主线程钉死（表现为整页假死）。
  // 所以这里用一个更保守的安全上限：宁可提前报错，也不要让浏览器卡死。
  const MAX_DIM = 12000;
  const MAX_PIXELS = 120e6; // 画布总像素上限，超过就提前拒绝
  const CELL_RATIO = 560 / 308; // 竖版原画比例，格子高度按格子宽度推导
  let lastPerf = null;     // 最近一次渲染的耗时埋点，供自检读取

  /** 按格子宽度推导格子高度与卡片版式（保证图片区不被拉伸） */
  function presetFor(opt) {
    const o = Object.assign({}, GRID_PRESET, opt || {});
    if (!o.cellH) o.cellH = Math.round(o.cellW * CELL_RATIO);
    return o;
  }

  /** 画单个卡片格（独立函数，便于 try/catch 与单独测试） */
  function drawCell(ctx, opt, it, cx, cy, im) {
    // 卡片底
    roundRect(ctx, cx, cy, opt.cellW, opt.cellH, 10);
    ctx.fillStyle = opt.cardBg || 'rgba(255,255,255,.045)';
    ctx.fill();
    ctx.strokeStyle = (it.rarity && it.rarity.color) ? hexA(it.rarity.color, .5) : 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // 图片区
    const iw = opt.cellW - 12, ih = opt.cellH - 68;
    ctx.save();
    try {
      roundRect(ctx, cx + 6, cy + 6, iw, ih, 7);
      ctx.clip();
      ctx.fillStyle = '#0d1626';
      ctx.fillRect(cx + 6, cy + 6, iw, ih);
      drawCover(ctx, im, cx + 6, cy + 6, iw, ih, 'top');
      if (!im) {
        ctx.fillStyle = '#55637a';
        ctx.font = '400 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('无图', cx + 6 + iw / 2, cy + 6 + ih / 2);
        ctx.textAlign = 'left';
      }
      // 底部渐变
      const g2 = ctx.createLinearGradient(0, cy + ih * 0.55, 0, cy + 6 + ih);
      g2.addColorStop(0, 'rgba(5,10,19,0)');
      g2.addColorStop(1, 'rgba(5,10,19,.92)');
      ctx.fillStyle = g2;
      ctx.fillRect(cx + 6, cy + ih * 0.55, iw, ih * 0.45 + 1);
      // 品质角标
      if (it.tag) {
        ctx.font = '700 12px "Noto Sans SC",sans-serif';
        const tw = ctx.measureText(it.tag).width;
        roundRect(ctx, cx + iw - tw - 14, cy + 14, tw + 14, 21, 10.5);
        ctx.fillStyle = hexA((it.rarity && it.rarity.color) || '#8b9bb4', .92);
        ctx.fill();
        ctx.fillStyle = '#0b1220';
        ctx.fillText(it.tag, cx + iw - tw - 7, cy + 29);
      }
    } finally {
      ctx.restore();
    }

    // 文字
    ctx.fillStyle = opt.textColor || '#eef2f8';
    ctx.font = '600 17px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText(ellipsis(ctx, it.name, opt.cellW - 14), cx + 7, cy + opt.cellH - 40);
    ctx.fillStyle = '#8494ab';
    ctx.font = '400 14px "Noto Sans SC",sans-serif';
    ctx.fillText(ellipsis(ctx, it.sub || '', opt.cellW - 14), cx + 7, cy + opt.cellH - 16);
  }

  async function renderGrid(p, onProgress) {
    const perf = {};
    const T0 = performance.now();
    // 分段计时用的时间点，必须在最前面声明（否则会踩 TDZ 报错）
    let tCreate = T0, tAfterBg = T0, tAfterHeader = T0, tHeaderEnd = T0;
    const opt = presetFor(p.opt);
    const W = opt.pad * 2 + opt.cols * opt.cellW + (opt.cols - 1) * opt.gap;
    const groups = p.groups.filter(g => g.items.length);
    let H = opt.pad + opt.headerH;
    for (const g of groups) {
      const rows = Math.ceil(g.items.length / opt.cols);
      H += (g.label ? opt.groupHeaderH : 0) + rows * (opt.cellH + opt.gap) + opt.groupGap;
    }
    H += opt.footerH + opt.pad;
    if (!groups.length) H = opt.pad * 2 + opt.headerH + 120;

    const outW = Math.round(W * opt.scale), outH = Math.round(H * opt.scale);
    const px = outW * outH;
    // 关键：这两项检查必须在创建画布、尤其是任何 fillRect 之前完成。
    // 否则浏览器会把超限画布静默截断，而代码仍按原尺寸填充 → 同步巨幅光栅化 → 整页假死（CPU 归零）。
    if (outW > MAX_DIM || outH > MAX_DIM) {
      const fit = Math.max(1, Math.floor(Math.min(MAX_DIM / W, MAX_DIM / H)));
      throw new Error(`成品尺寸 ${outW}×${outH}px 超过安全上限 ${MAX_DIM}px。\n` +
        `接近浏览器画布硬上限（16384px）时页面会被卡死，所以这里提前拦下。\n` +
        `建议：导出倍率降到 ${fit}x，或减小「格子宽」、增加「列数」、减少拼图内容。`);
    }
    if (px > MAX_PIXELS) {
      throw new Error(`成品 ${outW}×${outH}px（${(px / 1e6).toFixed(0)} 百万像素）超过安全上限 ` +
        `${(MAX_PIXELS / 1e6).toFixed(0)} 百万像素。\n请降低「导出倍率」、减小「格子宽」或增加「列数」。`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    tCreate = performance.now();
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`无法创建 ${outW}×${outH}px 的画布（可能超出显存/内存限制）`);
    ctx.scale(opt.scale, opt.scale);
    ctx.imageSmoothingQuality = 'high';
    ctx.textBaseline = 'alphabetic';

    // 背景
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, opt.bgTop || '#0b1220');
    grad.addColorStop(1, opt.bgBottom || '#050a13');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    tAfterBg = performance.now();

    // 页头
    ctx.fillStyle = opt.accent || '#c8a24a';
    ctx.fillRect(opt.pad, opt.pad, 5, opt.headerH - 44);
    ctx.fillStyle = opt.textColor || '#f2f5fa';
    ctx.font = '800 44px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText(p.title || '我的皮肤收藏', opt.pad + 22, opt.pad + 46);
    ctx.fillStyle = '#8b9bb4';
    ctx.font = '400 19px "Noto Sans SC","Microsoft YaHei",sans-serif';
    const subLeft = p.pageCount > 1
      ? `第 ${p.pageIndex} / ${p.pageCount} 页` + (p.subtitle ? '　·　' + p.subtitle : '')
      : (p.subtitle || '');
    ctx.fillText(subLeft, opt.pad + 24, opt.pad + 82);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(opt.pad, opt.pad + opt.headerH - 22, W - opt.pad * 2, 2);
    ctx.fillStyle = '#6d7c93';
    ctx.font = '400 15px "Noto Sans SC",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(p.rightText || '', W - opt.pad, opt.pad + 46);
    ctx.textAlign = 'left';
    tAfterHeader = performance.now();

    // 预加载（预热）本轮要用的图片。
    // 绘制阶段本来就会按需取图，所以这里只是让进度条更平滑；
    // 内容太多时（例如全图鉴 9000+ 张）预热纯属浪费，直接跳过。
    const all = groups.flatMap(g => g.items);
    const ids = [...new Set(all.map(it => it.skinId).filter(Boolean))];
    const total = ids.length;
    let done = 0;
    const CONC = 8;
    const queue = [...ids];
    // 单元格图片区尺寸：按目标尺寸解码，避免全尺寸位图占用内存
    const cellImgW = Math.max(64, Math.round((opt.cellW - 12) * opt.scale));
    const cellImgH = Math.max(64, Math.round((opt.cellH - 68) * opt.scale));
    const PRELOAD_MAX = p.preloadMax || 400;
    async function worker() {
      while (queue.length) {
        const sid = queue.shift();
        try {
          const bm = await loadBitmap(sid, cellImgW, cellImgH);
          if (bm && bm.close) bm.close();   // 只预热，立刻释放
        } catch (e) { /* 忽略，绘制时会再取一次 */ }
        done++;
        if (onProgress && (done % 8 === 0 || done === total)) onProgress(done, total, 'load');
      }
    }
    if (total <= PRELOAD_MAX && typeof createImageBitmap === 'function') {
      await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, worker));
    }
    await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, worker));
    tHeaderEnd = performance.now();
    perf.loadMs = Math.round(tAfterHeader - T0);
    perf.createMs = Math.round(tCreate - T0);
    const tDraw0 = performance.now();
    let drewCells = 0;
    const SLICE = 20;   // 每 20 格让出一次主线程，保持页面可响应并上报进度

    // 分组绘制
    let y = opt.pad + opt.headerH;
    let cellErrors = 0;
    for (const g of groups) {
      if (g.label) {
        ctx.fillStyle = opt.accent || '#c8a24a';
        ctx.font = '700 24px "Noto Sans SC","Microsoft YaHei",sans-serif';
        ctx.fillText(g.label, opt.pad, y + 30);
        const tw = ctx.measureText(g.label).width;
        if (g.sub) {
          ctx.fillStyle = '#7c8ba3';
          ctx.font = '400 16px "Noto Sans SC",sans-serif';
          ctx.fillText(g.sub, opt.pad + tw + 14, y + 30);
        }
        ctx.fillStyle = 'rgba(255,255,255,.07)';
        ctx.fillRect(opt.pad, y + 44, W - opt.pad * 2, 1.5);
        y += opt.groupHeaderH;
      }
      for (let i = 0; i < g.items.length; i++) {
        // 每 20 格让出一次主线程：大拼图时页面保持可响应，也便于自检观测进度
        if (i && i % SLICE === 0) {
          if (onProgress) onProgress(drewCells, total, 'draw');
          await new Promise(r => setTimeout(r, 0));
        }
        const it = g.items[i];
        const cx = opt.pad + (i % opt.cols) * (opt.cellW + opt.gap);
        const cy = y + Math.floor(i / opt.cols) * (opt.cellH + opt.gap);
        // 单格 try/catch：任何一格出错都不会中断整张拼图
        const tc0 = performance.now();
        let bm = null;
        try {
          // 按目标尺寸解码 + 画完即弃，内存恒定，不会随格数增长
          bm = await loadBitmap(it.skinId, cellImgW, cellImgH);
          drawCell(ctx, opt, it, cx, cy, bm);
        } catch (e) {
          cellErrors++;
          if (cellErrors <= 3) console.warn('格子绘制失败 skinId=' + it.skinId, e);
        } finally {
          if (bm && bm.close) bm.close();     // 显式释放位图内存
        }
        const cost = performance.now() - tc0;
        if (cost > 500) console.warn(`单格绘制耗时 ${cost.toFixed(0)}ms skinId=${it.skinId}`);
        drewCells++;
      }
      const rows = Math.ceil(g.items.length / opt.cols);
      y += rows * (opt.cellH + opt.gap) + opt.groupGap;
    }

    // 页脚
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(opt.pad, H - opt.pad - opt.footerH + 10, W - opt.pad * 2, 1.5);
    ctx.fillStyle = '#6d7c93';
    ctx.font = '400 15px "Noto Sans SC",sans-serif';
    ctx.fillText(p.footer || ('数据来源：腾讯 LOL 官方皮肤库 · 生成于 ' + new Date().toLocaleString('zh-CN')), opt.pad, H - opt.pad - 14);
    ctx.textAlign = 'right';
    ctx.fillText(`${DB.meta.version || ''}`, W - opt.pad, H - opt.pad - 14);
    ctx.textAlign = 'left';

    perf.drawMs = Math.round(performance.now() - tDraw0);
    perf.totalMs = Math.round(performance.now() - T0);
    perf.bgMs = Math.round(tAfterBg - tCreate);
    perf.headerMs = Math.round(tAfterHeader - tAfterBg);
    perf.preloadMs = Math.round(tHeaderEnd - tAfterHeader);
    perf.cells = all.length;
    perf.size = outW + 'x' + outH;
    canvas.__perf = perf;
    lastPerf = perf;
    return canvas;
  }

  /* ============================================================
   * 拼图渲染：海报式
   * ============================================================ */
  async function renderPoster(p, onProgress) {
    const W = p.width || 1600;
    const PAD = 64;
    const bgIds = p.bgIds || [];
    const feat = (p.featured || []).slice(0, 4);
    const FEAT_H = feat.length ? 470 : 0;
    const ROW_H = 118;
    const rarityRows = (p.rarityRows || []).length;
    const HERO_ROWS = Math.min(p.heroes ? p.heroes.length : 0, 8);
    const H = 250 + FEAT_H + 60 + Math.max(rarityRows, HERO_ROWS) * ROW_H + 150;

    const canvas = document.createElement('canvas');
    const scale = p.scale || 2;
    canvas.width = W * scale; canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.imageSmoothingQuality = 'high';

    // ---- 背景马赛克 ----
    const COLS = 16, TILE = W / COLS, TROWS = Math.ceil(H / TILE);
    const need = COLS * TROWS;
    const pool = [];
    while (pool.length < need && bgIds.length) pool.push(...bgIds);
    const bgImgs = await Promise.all(pool.slice(0, need).map(id => loadImageSmart(id)));
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);
    bgImgs.forEach((im, i) => {
      if (!im) return;
      const x = (i % COLS) * TILE, y = Math.floor(i / COLS) * TILE;
      drawCover(ctx, im, x, y, TILE + 1, TILE + 1, 'top');
    });
    // 暗化
    let g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(5,8,15,.93)');
    g.addColorStop(.45, 'rgba(5,8,15,.86)');
    g.addColorStop(1, 'rgba(5,8,15,.97)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // ---- 顶部 ----
    ctx.textAlign = 'center';
    ctx.fillStyle = p.levelColor || '#c8a24a';
    ctx.font = '700 22px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText(p.kicker || '', W / 2, 78);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 96px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText(p.bigNumber || '', W / 2, 186);
    ctx.fillStyle = '#9fb0c7';
    ctx.font = '400 24px "Noto Sans SC",sans-serif';
    ctx.fillText(p.bigLabel || '', W / 2, 226);

    // 镶边
    ctx.strokeStyle = hexA(p.levelColor || '#c8a24a', .55);
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD * .55, PAD * .55, W - PAD * 1.1, H - PAD * 1.1);

    let y = 262;

    // ---- 精选横版大图 ----
    if (feat.length) {
      const gap = 18, cw = (W - PAD * 2 - gap * (feat.length - 1)) / feat.length;
      const ims = await Promise.all(feat.map(f => loadImageSmart(f.skinId)));
      feat.forEach((f, i) => {
        const x = PAD + i * (cw + gap);
        ctx.save();
        roundRect(ctx, x, y, cw, FEAT_H, 14);
        ctx.clip();
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(x, y, cw, FEAT_H);
        drawCover(ctx, ims[i], x, y, cw, FEAT_H, 'center');
        const g3 = ctx.createLinearGradient(0, y + FEAT_H * .5, 0, y + FEAT_H);
        g3.addColorStop(0, 'rgba(5,8,15,0)');
        g3.addColorStop(1, 'rgba(5,8,15,.95)');
        ctx.fillStyle = g3;
        ctx.fillRect(x, y + FEAT_H * .5, cw, FEAT_H * .5);
        ctx.restore();
        ctx.strokeStyle = hexA(f.rarity ? f.rarity.color : '#ffffff', .6);
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, cw, FEAT_H, 14);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = '700 21px "Noto Sans SC","Microsoft YaHei",sans-serif';
        ctx.fillText(ellipsis(ctx, f.name, cw - 28), x + cw / 2, y + FEAT_H - 46);
        ctx.fillStyle = f.rarity ? f.rarity.color : '#9fb0c7';
        ctx.font = '600 15px "Noto Sans SC",sans-serif';
        ctx.fillText(f.rarity ? f.rarity.name : '', x + cw / 2, y + FEAT_H - 20);
      });
      y += FEAT_H + 50;
    }

    // ---- 统计两栏 ----
    const colW = (W - PAD * 2 - 40) / 2;
    const rows = Math.max(rarityRows, HERO_ROWS);
    // 左：品质分布
    ctx.textAlign = 'left';
    ctx.fillStyle = '#c8a24a';
    ctx.font = '700 22px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText('品质分布', PAD, y - 14);
    ctx.fillStyle = '#c8a24a';
    ctx.font = '700 22px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText('英雄收藏榜', PAD + colW + 40, y - 14);

    const maxRar = Math.max(1, ...(p.rarityRows || []).map(r => r.count + (r.chromaCount || 0)));
    (p.rarityRows || []).forEach((r, i) => {
      const ry = y + 6 + i * ROW_H;
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      roundRect(ctx, PAD, ry, colW, ROW_H - 16, 10);
      ctx.fill();
      const total = r.count + (r.chromaCount || 0);
      const bw = (colW - 150) * (total / maxRar);
      const g4 = ctx.createLinearGradient(PAD + 130, 0, PAD + 130 + bw, 0);
      g4.addColorStop(0, hexA(r.color, .85));
      g4.addColorStop(1, hexA(r.color, .35));
      ctx.fillStyle = g4;
      roundRect(ctx, PAD + 128, ry + 16, Math.max(4, bw), ROW_H - 48, (ROW_H - 48) / 2);
      ctx.fill();
      ctx.fillStyle = r.color;
      ctx.font = '700 20px "Noto Sans SC",sans-serif';
      ctx.fillText(r.name, PAD + 20, ry + 44);
      ctx.fillStyle = '#e8eef7';
      ctx.font = '800 30px "Noto Sans SC",sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(r.count), PAD + colW - 20, ry + 48);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#7f8fa6';
      ctx.font = '400 13px "Noto Sans SC",sans-serif';
      ctx.fillText(r.chromaCount ? `含 ${r.chromaCount} 炫彩` : '', PAD + 20, ry + 68);
    });

    // 右：英雄榜
    const heroes = (p.heroes || []).slice(0, HERO_ROWS);
    const maxHero = Math.max(1, ...heroes.map(h => h.score));
    heroes.forEach((h, i) => {
      const ry = y + 6 + i * ROW_H;
      const x0 = PAD + colW + 40;
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      roundRect(ctx, x0, ry, colW, ROW_H - 16, 10);
      ctx.fill();
      ctx.fillStyle = '#c8a24a';
      ctx.font = '800 18px sans-serif';
      ctx.fillText(String(i + 1), x0 + 14, ry + 44);
      ctx.fillStyle = '#e8eef7';
      ctx.font = '700 20px "Noto Sans SC","Microsoft YaHei",sans-serif';
      ctx.fillText(ellipsis(ctx, h.name, colW * .42), x0 + 44, ry + 44);
      ctx.fillStyle = '#7f8fa6';
      ctx.font = '400 13px "Noto Sans SC",sans-serif';
      ctx.fillText(`${h.own}/${h.total} 款 · 炫彩 ${h.chromaOwn}`, x0 + 44, ry + 68);
      const bx = x0 + colW * .55, bwid = colW * .42;
      ctx.fillStyle = 'rgba(255,255,255,.09)';
      roundRect(ctx, bx, ry + 28, bwid, 12, 6);
      ctx.fill();
      const g5 = ctx.createLinearGradient(bx, 0, bx + bwid, 0);
      g5.addColorStop(0, '#c8a24a');
      g5.addColorStop(1, '#ffe9a8');
      ctx.fillStyle = g5;
      roundRect(ctx, bx, ry + 28, Math.max(4, bwid * (h.score / maxHero)), 12, 6);
      ctx.fill();
      ctx.fillStyle = '#ffe9a8';
      ctx.font = '700 15px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(h.score)), x0 + colW - 16, ry + 40);
      ctx.textAlign = 'left';
    });

    // ---- 页脚 ----
    ctx.textAlign = 'center';
    ctx.fillStyle = p.levelColor || '#c8a24a';
    ctx.font = '800 30px "Noto Sans SC","Microsoft YaHei",sans-serif';
    ctx.fillText(`${p.levelName || ''}　·　收藏评分 ${Math.round(p.score || 0)}`, W / 2, H - 86);
    ctx.fillStyle = '#7f8fa6';
    ctx.font = '400 16px "Noto Sans SC",sans-serif';
    ctx.fillText(p.footer || '', W / 2, H - 52);
    ctx.textAlign = 'left';

    if (onProgress) onProgress(1, 1);
    return canvas;
  }

  /** 在当前列数/格子宽下，能放进安全上限的最大整倍率（<1 表示 1x 都放不下） */
  function fitScale(groups, opt) {
    const o = presetFor(Object.assign({}, opt, { scale: 1 }));
    const W = o.pad * 2 + o.cols * o.cellW + (o.cols - 1) * o.gap;
    const gs = (groups || []).filter(g => g.items.length);
    let H = o.pad + o.headerH;
    for (const g of gs) {
      const rows = Math.ceil(g.items.length / o.cols);
      H += (g.label ? o.groupHeaderH : 0) + rows * (o.cellH + o.gap) + o.groupGap;
    }
    H += o.footerH + o.pad;
    if (!gs.length) H = o.pad * 2 + o.headerH + 120;
    for (let s = 3; s >= 1; s--) {
      if (W * s <= MAX_DIM && H * s <= MAX_DIM && W * s * H * s <= MAX_PIXELS) return s;
    }
    return 0;
  }

  /**
   * 在当前格子宽度下，把全部内容压进安全上限所需的最少列数。
   * 注意两个方向都要判：列数变多会让画布更宽，行数变少会让画布更矮。
   */
  function fitCols(groups, opt) {
    const base = presetFor(Object.assign({}, opt, { scale: 1 }));
    const gs = (groups || []).filter(g => g.items.length);
    const chrome = base.headerH + base.footerH + base.pad * 2;
    const headers = gs.reduce((n, g) => n + (g.label ? base.groupHeaderH + base.groupGap : 0), 0);
    for (let cols = base.cols; cols <= 60; cols++) {
      const rows = gs.reduce((n, g) => n + Math.ceil(g.items.length / cols), 0);
      const H = chrome + headers + rows * (base.cellH + base.gap);
      const W = base.pad * 2 + cols * base.cellW + (cols - 1) * base.gap;
      if (H <= MAX_DIM && W <= MAX_DIM && W * H <= MAX_PIXELS) return cols;
    }
    return 0;
  }

  function estimateGrid(groups, opt) {
    const o = presetFor(opt);
    const gs = (groups || []).filter(g => g.items.length);
    const W = o.pad * 2 + o.cols * o.cellW + (o.cols - 1) * o.gap;
    let H = o.pad + o.headerH;
    for (const g of gs) {
      const rows = Math.ceil(g.items.length / o.cols);
      H += (g.label ? o.groupHeaderH : 0) + rows * (o.cellH + o.gap) + o.groupGap;
    }
    H += o.footerH + o.pad;
    if (!gs.length) H = o.pad * 2 + o.headerH + 120;
    const outW = Math.round(W * o.scale), outH = Math.round(H * o.scale);
    return {
      W: outW, H: outH, limit: MAX_DIM, pixels: outW * outH, maxPixels: MAX_PIXELS,
      over: outW > MAX_DIM || outH > MAX_DIM || outW * outH > MAX_PIXELS,
    };
  }

  /**
   * 为大分组场景挑一组更合适的 (cols, cellW)：
   * 适当缩小格子、增加列数，往往就能从"要分 10 页"变成"1~2 页"，
   * 而且成品对浏览者反而更友好（更像一张长图）。
   */
  function optimizeGrid(groups, opt, cellWMin) {
    const minW = cellWMin || 120;
    const base = Object.assign({}, opt);
    let best = null;
    const widths = [];
    for (let w = base.cellW; w >= minW; w -= 10) widths.push(w);
    for (const w of widths) {
      for (let cols = base.cols; cols <= 40; cols++) {
        const est = estimateGrid(groups, Object.assign({}, base, { cellW: w, cols }));
        if (est.over) continue;
        // 评分：优先页数少，其次字大（在同样页数下选更大的格子）
        const score = -(cols * 1000 + (400 - w));
        if (!best || score > best.score) best = { cellW: w, cols, score, est };
        break;                    // 该宽度下找到最小可行列数就够了
      }
    }
    return best;
  }

  /** 单个分组的实际高度（用于分页装箱） */
  function groupHeight(g, cols, o) {
    const rows = Math.ceil(g.items.length / cols);
    return (g.label ? o.groupHeaderH : 0) + rows * (o.cellH + o.gap) + o.groupGap;
  }

  /**
   * 分页装箱。capH 可显式指定每页可用高度（默认按安全上限推算），
   * 传入更小的 capH 会得到更多页，用于"按用户指定页数均匀切分"。
   */
  function splitPages(groups, opt, capH) {
    const o = presetFor(opt);
    const usableH = capH || (MAX_DIM / o.scale - (o.pad + o.headerH + o.footerH + o.pad));
    const gs = (groups || []).filter(g => g.items.length);
    const pages = [];
    let cur = [], curH = 0;

    const flush = () => { if (cur.length) { pages.push(cur); cur = []; curH = 0; } };

    for (const g of gs) {
      const h = groupHeight(g, o.cols, o);
      if (h > usableH) {
        // 单个英雄就超过一页：按行拆成多个"伪分组"，保持每页都能放下
        flush();
        const perPage = Math.max(1, Math.floor(
          (usableH - (g.label ? o.groupHeaderH : 0) - o.groupGap) / (o.cellH + o.gap)) * o.cols);
        for (let i = 0; i < g.items.length; i += perPage) {
          const part = g.items.slice(i, i + perPage);
          pages.push([{
            label: g.label + (i ? '（续）' : ''),
            sub: `${part.length} 项` + (g.items.length > perPage ? ` / 共 ${g.items.length}` : ''),
            items: part,
          }]);
        }
        continue;
      }
      if (cur.length && curH + h > usableH) flush();
      cur.push(g);
      curH += h;
    }
    flush();

    const totalH = gs.reduce((n, g) => n + groupHeight(g, o.cols, o), 0);
    return { pages, usableH, totalH, cols: o.cols, cellW: o.cellW, cellH: o.cellH };
  }

  /**
   * 把内容切成"接近 count 页"。做法是对每页容量做二分搜索，
   * 找到能产出 <= count 页的最大容量，因此各页高度尽量均衡。
   */
  function splitEvenly(groups, opt, count) {
    const o = presetFor(opt);
    const fullCap = MAX_DIM / o.scale - (o.pad + o.headerH + o.footerH + o.pad);
    let lo = 1, hi = fullCap, best = null;
    const one = splitPages(groups, opt);
    if (count <= 1) return one.pages;
    for (let it = 0; it < 26; it++) {
      const mid = (lo + hi) / 2;
      const r = splitPages(groups, opt, mid);
      if (r.pages.length <= count) { best = r.pages; lo = mid; } else { hi = mid; }
    }
    let pages = best || splitPages(groups, opt, fullCap).pages;
    // 不够 count 页时，继续拆最后一页直到接近目标或不能再拆
    let guard = 0;
    while (pages.length < count && guard++ < 200) {
      const li = pages.length - 1;
      const last = pages[li];
      if (!last || last.length < 2) break;
      const half = Math.ceil(last.length / 2);
      pages.splice(li, 1, last.slice(0, half), last.slice(half));
    }
    return pages;
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ============================================================
   * 导出
   * ============================================================ */
  function downloadCanvas(canvas, filename) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('导出失败（画布可能被跨域图片污染）'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        resolve(blob.size);
      }, 'image/png');
    });
  }

  /** 按序号依次下载多页（每页间隔一点时间，避免浏览器把连续下载当成弹窗拦截） */
  async function downloadCanvasAs(canvases, baseName, onProgress) {
    let total = 0;
    for (let i = 0; i < canvases.length; i++) {
      const name = `${baseName}_第${i + 1}页共${canvases.length}页.png`;
      total += await downloadCanvas(canvases[i], name);
      if (onProgress) onProgress(i + 1, canvases.length);
      if (i < canvases.length - 1) await new Promise(r => setTimeout(r, 350));
    }
    return total;
  }

  global.CollageCore = {
    DB, analyzeOwnership, parseAccountText, parseChampionSkins, tsToDate,
    renderGrid, renderPoster, downloadCanvas,
    estimateGrid, fitScale, fitCols, optimizeGrid, splitPages, splitEvenly, downloadCanvasAs,
    cardHTML, chromaCardHTML, esc, loadImage, loadImageSmart, loadBitmap, waitForImages, roundRect, drawCover,
    setCacheEnabled, clearImageCache, cacheStats, releaseCanvas,
    RARITIES, GRID_PRESET, scoreTier, fmtTime, MAX_DIM,
    get lastPerf() { return lastPerf; },
  };
})(window);
