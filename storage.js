/* 共享存储层：数据迁移、版本号、跨标签页三方合并、原子提交 */
(function () {
  "use strict";

  const STORAGE_KEY = "zfl18-boardgame-rule-cards";
  const MIGRATION_VERSION = 2;
  const SECTIONS = ["forgets", "disputes", "setup", "scoring"];
  const SECTION_LABELS = {
    forgets: "容易忘的规则",
    disputes: "常见争议",
    setup: "开局准备",
    scoring: "计分提醒"
  };

  function uid() {
    return crypto.randomUUID();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function makeCard(text, section, extra) {
    return {
      id: uid(),
      text: String(text ?? ""),
      section: SECTIONS.includes(section) ? section : "forgets",
      refs: [],
      addedAt: new Date().toISOString(),
      ...extra
    };
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function withoutRev(s) {
    const { rev, nonce, ...rest } = s;
    return rest;
  }

  function newNonce() {
    return uid();
  }

  /* ---------- 内置示例 ---------- */
  function seedGame(name, g) {
    const cards = [];
    for (const section of SECTIONS) {
      for (const text of g[section]) cards.push(makeCard(text, section));
    }
    return {
      id: uid(),
      name,
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      duration: g.duration,
      complexity: g.complexity,
      lastPlayed: g.lastPlayed,
      cover: "",
      cards
    };
  }

  function defaultState() {
    const orleans = seedGame("奥尔良", {
      minPlayers: 2, maxPlayers: 4, duration: 90, complexity: "中", lastPlayed: "2025-11-20",
      forgets: ["商站建造前先确认道路或水路连接", "袋中随从抽完后不是重洗弃堆，而是从已回袋内容继续抽"],
      disputes: ["事件顺序和玩家动作结算先后", "科技板是否能替代所有同类随从"],
      setup: ["按人数放置货物板块", "每位玩家拿起始随从、商人和个人板"],
      scoring: ["货物分数", "商站和市民乘区块", "金币和建筑剩余加分"]
    });
    const gaia = seedGame("盖亚计划", {
      minPlayers: 1, maxPlayers: 4, duration: 150, complexity: "重", lastPlayed: "2025-08-02",
      forgets: ["联邦连接时卫星数量和能量消耗要一起核对", "研究升到顶必须拿对应科技板限制"],
      disputes: ["被动充能是否能拒绝", "星球改造费用受哪些能力影响"],
      setup: ["随机终局计分板和回合得分板", "按种族设置起始资源和种族板"],
      scoring: ["终局计分板", "科技轨排名", "联邦和建筑分"]
    });
    const azulejo = seedGame("花砖物语", {
      minPlayers: 2, maxPlayers: 4, duration: 45, complexity: "轻", lastPlayed: "2026-03-15",
      forgets: ["每轮结束先铺墙再补工厂展示区", "地板线扣分后清空对应砖"],
      disputes: ["同色砖放置限制是否看整面墙", "中央区起始玩家标记是否必须拿"],
      setup: ["按人数放工厂圆盘", "每个圆盘补4块砖"],
      scoring: ["横竖相邻即时分", "完整行列和颜色终局加分"]
    });
    return {
      version: MIGRATION_VERSION,
      selectedId: orleans.id,
      games: [orleans, gaia, azulejo],
      batches: [],
      pendingMerges: [],
      rev: 1,
      nonce: newNonce()
    };
  }

  /* ---------- 旧版本（字符串数组）迁移 ---------- */
  function migrateGame(raw) {
    const game = {
      id: raw.id || uid(),
      name: String(raw.name || "未命名"),
      minPlayers: Number(raw.minPlayers) || 1,
      maxPlayers: Number(raw.maxPlayers) || 1,
      duration: Number(raw.duration) || 30,
      complexity: ["轻", "中", "重"].includes(raw.complexity) ? raw.complexity : "中",
      lastPlayed: raw.lastPlayed || "2026-01-01",
      cover: raw.cover || "",
      cards: []
    };
    if (Array.isArray(raw.cards)) {
      for (const c of raw.cards) {
        if (c && typeof c === "object") {
          game.cards.push(makeCard(c.text ?? "", c.section, {
            id: c.id || uid(),
            refs: Array.isArray(c.refs) ? c.refs.filter((r) => typeof r === "string") : [],
            addedAt: c.addedAt || new Date().toISOString()
          }));
        } else if (typeof c === "string") {
          game.cards.push(makeCard(c, "forgets"));
        }
      }
    } else {
      for (const section of SECTIONS) {
        if (Array.isArray(raw[section])) {
          for (const text of raw[section]) {
            if (typeof text === "string") game.cards.push(makeCard(text, section));
          }
        }
      }
    }
    return game;
  }

  function migrate(raw) {
    const base = defaultState();
    const games = Array.isArray(raw.games) ? raw.games.map(migrateGame) : base.games;
    for (const g of games) {
      const ids = new Set(g.cards.map((c) => c.id));
      for (const c of g.cards) c.refs = c.refs.filter((r) => ids.has(r) && r !== c.id);
    }
    return {
      version: MIGRATION_VERSION,
      selectedId: games.some((g) => g.id === raw.selectedId) ? raw.selectedId : games[0]?.id || "",
      games,
      batches: Array.isArray(raw.batches) ? raw.batches : [],
      pendingMerges: Array.isArray(raw.pendingMerges) ? raw.pendingMerges : [],
      rev: Number(raw.rev) > 0 ? Number(raw.rev) : 1,
      nonce: raw.nonce || newNonce()
    };
  }

  /* ---------- 图工具：循环引用 ---------- */
  function findCycle(nodes, edges) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(nodes.map((n) => [n, WHITE]));
    const stack = [];
    let found = null;
    function dfs(u) {
      color.set(u, GRAY);
      stack.push(u);
      for (const v of edges.get(u) || []) {
        if (!color.has(v)) continue;
        if (color.get(v) === GRAY) {
          found = stack.slice(stack.indexOf(v)).concat(v);
          return true;
        }
        if (color.get(v) === WHITE && dfs(v)) return true;
      }
      stack.pop();
      color.set(u, BLACK);
      return false;
    }
    for (const n of nodes) {
      if (color.get(n) === WHITE && dfs(n)) return found;
    }
    return null;
  }

  /* ---------- 三方合并（base / local / remote） ----------
     - 双方改了不同实体：自动合并
     - 同一实体双方都改：保留两个版本到 pendingMerges，不覆盖
  */
  function indexById(arr) {
    return new Map((arr || []).map((x) => [x.id, x]));
  }

  function mergeEntityCollection(baseArr, localArr, remoteArr, forkKind, forksOut, forceTakeRemote) {
    forceTakeRemote = forceTakeRemote || new Set();
    const base = indexById(baseArr);
    const local = indexById(localArr);
    const remote = indexById(remoteArr);
    const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
    const result = [];
    // 以两边数组顺序的并集保持稳定顺序
    const order = [];
    for (const x of localArr || []) order.push(x.id);
    for (const x of remoteArr || []) if (!order.includes(x.id)) order.push(x.id);

    for (const id of order) {
      ids.delete(id);
      const b = base.get(id);
      const l = local.get(id);
      const r = remote.get(id);
      const localChanged = !b || !deepEqual(l, b);
      const remoteChanged = !b || !deepEqual(r, b);

      if (l && r) {
        if (localChanged && remoteChanged && !deepEqual(l, r) && !forceTakeRemote.has(id)) {
          // 分叉：进入待合并队列，主版本暂取本地（不覆盖、不丢失）
          forksOut.push({
            id: uid(),
            kind: forkKind,
            entityId: id,
            base: structuredClone(b || null),
            local: structuredClone(l),
            remote: structuredClone(r),
            createdAt: new Date().toISOString(),
            resolved: false
          });
        }
        result.push(structuredClone(deepEqual(l, r) || !remoteChanged ? l : r));
      } else if (l && !r) {
        // 远端删除
        if (b && localChanged) {
          // 本地改过、远端删了 → 保留分叉，让用户决定删还是留
          forksOut.push({
            id: uid(),
            kind: forkKind,
            entityId: id,
            base: structuredClone(b),
            local: structuredClone(l),
            remote: null,
            createdAt: new Date().toISOString(),
            resolved: false
          });
          result.push(structuredClone(l));
        }
        // 否则双方一致删除：不加入结果
      } else if (!l && r) {
        if (b && remoteChanged) {
          // 本地删了、远端改了 → 同样保留分叉；主数据先保留远端版本以免丢失
          forksOut.push({
            id: uid(),
            kind: forkKind,
            entityId: id,
            base: structuredClone(b),
            local: null,
            remote: structuredClone(r),
            createdAt: new Date().toISOString(),
            resolved: false
          });
          result.push(structuredClone(r));
        } else if (!b) {
          result.push(structuredClone(r)); // 远端新增
        }
        // 本地删除、远端未改：保持删除
      }
    }
    return result;
  }

  function threeWayMerge(base, local, remote, forceTakeRemote) {
    const forks = [];
    const merged = {
      version: MIGRATION_VERSION,
      selectedId: local.selectedId,
      games: mergeEntityCollection(base.games, local.games, remote.games, "game", forks, forceTakeRemote),
      batches: mergeEntityCollection(base.batches, local.batches, remote.batches, "batch", forks, forceTakeRemote),
      // 待合并队列取两边并集，避免一方已记录的分叉被另一方覆盖丢失
      pendingMerges: withForks(remote.pendingMerges || [], local.pendingMerges || []),
      rev: remote.rev
    };
    return { merged, forks };
  }

  // 同一实体只保留一条未解决分叉
  function withForks(existing, fresh) {
    const openEntityIds = new Set((existing || []).filter((f) => !f.resolved).map((f) => f.entityId));
    const out = [...(existing || [])];
    for (const f of fresh || []) {
      if (openEntityIds.has(f.entityId)) continue;
      openEntityIds.add(f.entityId);
      out.push(f);
    }
    return out;
  }

  // 当前标签页采纳别的标签页写回的合并结果时，把分叉记录两侧翻转到本页视角
  function flipForkSides(merged, prevState) {
    for (const f of merged.pendingMerges || []) {
      const coll = f.kind === "batch" ? prevState.batches : prevState.games;
      const mine = (coll || []).find((x) => x.id === f.entityId);
      if (mine && f.remote && deepEqual(mine, f.remote)) {
        const l = f.local;
        f.local = f.remote;
        f.remote = l;
      }
    }
  }

  /* ---------- Store ---------- */
  const listeners = new Set();
  let suppressStorageEvent = false;

  const Store = {
    state: null,
    base: null, // 最近一次确认与其它标签页一致时的公共祖先，用于三方合并
    deferred: false, // 本页提交在仲裁中等待对端写回
    STORAGE_KEY,
    SECTIONS,
    SECTION_LABELS,

    init() {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        this.state = defaultState();
        this.base = structuredClone(this.state);
        this.commit({ silent: true });
      } else {
        try {
          this.state = migrate(JSON.parse(saved));
        } catch {
          this.state = defaultState();
        }
        this.base = structuredClone(this.state);
      }
      window.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY || suppressStorageEvent) return;
        let incoming;
        try {
          incoming = JSON.parse(e.newValue || "null");
        } catch {
          return;
        }
        if (!incoming) return;
        const remote = migrate(incoming);
        const prev = this.state;
        if (Number(remote.rev) < Number(this.state.rev)) return;
        if (Number(remote.rev) === Number(this.state.rev)) {
          if (remote.nonce === this.state.nonce) return; // 自己写的回声
          // 同 rev 兄弟提交：nonce 较小者负责合并写回
          if (remote.nonce < this.state.nonce) return; // 等待对方写回下一版
          const { merged, forks } = threeWayMerge(this.base, this.state, remote);
          merged.pendingMerges = withForks(merged.pendingMerges || [], forks);
          this.finishMergeWrite(merged, remote, forks);
          return;
        }
        if (this.deferred) {
          // 仲裁者已写回合并结果：直接采纳（本页版本已包含在分叉记录里）
          this.deferred = false;
          flipForkSides(remote, prev);
          this.state = remote;
          this.base = structuredClone(remote);
          this.emit({ remote: true, forks: remote.pendingMerges });
          return;
        }
        if (deepEqual(withoutRev(this.state), withoutRev(this.base))) {
          // 本地没有未同步改动：直接采用远端，同时把公共祖先推进到远端
          this.state = remote;
          this.base = structuredClone(remote);
          this.emit({ remote: true });
          return;
        }
        // 本地与远端都从公共祖先分叉：三方合并，冲突双方版本都保留
        const { merged, forks } = threeWayMerge(this.base, this.state, remote);
        merged.pendingMerges = withForks(merged.pendingMerges || [], forks);
        merged.rev = remote.rev;
        merged.nonce = remote.nonce;
        // 分叉记录是对端视角生成的，翻转成本页视角
        flipForkSides(merged, prev);
        this.state = merged;
        this.base = structuredClone(merged);
        this.emit({ remote: true, forks });
      });
      return this.state;
    },

    // 仲裁者把合并结果写回为下一版
    finishMergeWrite(merged, remote, forks) {
      merged.rev = remote.rev + 1;
      merged.nonce = newNonce();
      this.writePersisted(merged);
      this.state = merged;
      this.base = structuredClone(merged);
      this.emit({ remote: true, forks });
    },

    writePersisted(next) {
      suppressStorageEvent = true;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setTimeout(() => {
        suppressStorageEvent = false;
      }, 0);
    },

    /* 原子提交：mutator 抛错/返回 false 则整体不落盘；分叉时三方合并 */
    commit(mutatorOrOpts, maybeOpts) {
      const mutator = typeof mutatorOrOpts === "function" ? mutatorOrOpts : null;
      const opts = (mutator ? maybeOpts : mutatorOrOpts) || {};
      const draft = structuredClone(this.state);
      if (mutator) {
        try {
          if (mutator(draft) === false) return false;
        } catch (err) {
          console.error("commit aborted:", err);
          return false;
        }
      }
      let persistedRaw = null;
      try {
        persistedRaw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      } catch {
        persistedRaw = null;
      }
      let forks = [];
      let next;
      const persistedRev = persistedRaw ? Number(persistedRaw.rev) : 0;
      if (persistedRaw && persistedRev > Number(this.state.rev)) {
        // 另一标签页先提交了：以公共祖先做三方合并
        const remote = migrate(persistedRaw);
        const mergeResult = threeWayMerge(this.base, draft, remote);
        next = mergeResult.merged;
        forks = mergeResult.forks;
        next.pendingMerges = withForks(next.pendingMerges || [], forks);
        next.rev = remote.rev + 1;
        next.nonce = newNonce();
        this.base = structuredClone(next);
      } else if (
        persistedRaw &&
        persistedRev === Number(this.state.rev) &&
        persistedRaw.nonce !== this.state.nonce
      ) {
        // 同 rev 兄弟提交（对端已写）：nonce 小的一方仲裁
        const remote = migrate(persistedRaw);
        if (persistedRaw.nonce < this.state.nonce) {
          // 由对端合并写回；本页只保留内存版本，等待下一版事件
          this.deferred = true;
          this.state = draft;
          if (!opts.silent) this.emit({ local: true, deferred: true });
          this.scheduleArbitrationTakeover();
          return true;
        }
        const mergeResult = threeWayMerge(this.base, draft, remote);
        next = mergeResult.merged;
        forks = mergeResult.forks;
        next.pendingMerges = withForks(next.pendingMerges || [], forks);
        next.rev = remote.rev + 1;
        next.nonce = newNonce();
        this.base = structuredClone(next);
      } else {
        // 无竞争的正常提交：base 保持为上次同步点，这样随后若收到同 rev 兄弟提交
        // 才能识别出本地改动并走三方合并
        next = draft;
        next.rev = (Number(this.state.rev) || 0) + 1;
        next.nonce = newNonce();
        this.deferred = false;
      }
      this.writePersisted(next);
      this.state = next;
      if (!opts.silent) this.emit({ local: true, forks });
      return true;
    },

    // 仲裁对端失约（崩溃/未写回）时，300ms 后本页接管仲裁
    scheduleArbitrationTakeover() {
      setTimeout(() => {
        if (!this.deferred) return;
        let raw = null;
        try {
          raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        } catch {
          raw = null;
        }
        if (!raw || Number(raw.rev) !== Number(this.state.rev) || raw.nonce === this.state.nonce) {
          this.deferred = false; // 对端已写回，storage 事件会处理
          return;
        }
        const remote = migrate(raw);
        const { merged, forks } = threeWayMerge(this.base, this.state, remote);
        merged.pendingMerges = withForks(merged.pendingMerges || [], forks);
        this.deferred = false;
        this.finishMergeWrite(merged, remote, forks);
      }, 300);
    },

    /* 显式状态提交（解决合并后用） */
    commitState(next, opts = {}) {
      let persistedRaw = null;
      try {
        persistedRaw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      } catch {
        persistedRaw = null;
      }
      const remoteRev = persistedRaw ? Number(persistedRaw.rev) : 0;
      next.rev = Math.max(Number(this.state.rev), remoteRev) + 1;
      next.nonce = newNonce();
      this.deferred = false;
      this.writePersisted(next);
      this.state = next;
      this.base = structuredClone(next);
      if (!opts.silent) this.emit({ local: true });
      return true;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    emit(event) {
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (err) {
          console.error(err);
        }
      }
    },

    findGame(gameId) {
      return this.state.games.find((g) => g.id === gameId) || null;
    },

    findCard(cardId) {
      for (const g of this.state.games) {
        const c = g.cards.find((x) => x.id === cardId);
        if (c) return { game: g, card: c };
      }
      return null;
    },

    findCycle,
    makeCard,
    uid,
    ingest: (raw) => migrate(raw)
  };

  window.Store = Store;
  window.uid = uid;
  window.escapeHtml = escapeHtml;
})();
