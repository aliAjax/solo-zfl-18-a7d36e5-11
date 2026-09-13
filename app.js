/* 卡片库视图：筛选、增删、游玩、规则卡（含卡片引用） */
(function () {
  "use strict";

  const today = new Date();
  const SL = Store.SECTION_LABELS;

  Store.init();

  const els = {
    searchInput: document.querySelector("#searchInput"),
    playerFilter: document.querySelector("#playerFilter"),
    complexityFilter: document.querySelector("#complexityFilter"),
    sortMode: document.querySelector("#sortMode"),
    gameForm: document.querySelector("#gameForm"),
    nameInput: document.querySelector("#nameInput"),
    minPlayersInput: document.querySelector("#minPlayersInput"),
    maxPlayersInput: document.querySelector("#maxPlayersInput"),
    durationInput: document.querySelector("#durationInput"),
    complexityInput: document.querySelector("#complexityInput"),
    lastPlayedInput: document.querySelector("#lastPlayedInput"),
    coverInput: document.querySelector("#coverInput"),
    gameList: document.querySelector("#gameList"),
    detailView: document.querySelector("#detailView"),
    gameCount: document.querySelector("#gameCount"),
    ruleCount: document.querySelector("#ruleCount"),
    batchCount: document.querySelector("#batchCount"),
    staleGame: document.querySelector("#staleGame"),
    visibleCount: document.querySelector("#visibleCount"),
    viewTabs: document.querySelector("#viewTabs"),
    libraryView: document.querySelector("#libraryView"),
    migrationView: document.querySelector("#migrationView")
  };

  let state = Store.state;
  let jumpCardId = null; // 引用跳转后高亮
  const flashEl = document.querySelector("#libraryFlash");

  function flashLibrary(msg, ok = true) {
    flashEl.textContent = msg;
    flashEl.className = "lib-flash " + (ok ? "ok" : "err");
    flashEl.hidden = false;
    clearTimeout(flashEl._t);
    flashEl._t = setTimeout(() => (flashEl.hidden = true), 4000);
  }

  function daysSince(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    return Math.max(0, Math.floor((today - date) / 86400000));
  }

  function cardsOf(game) {
    return game.cards || [];
  }

  function cardsBySection(game, section) {
    return cardsOf(game).filter((c) => c.section === section);
  }

  function getAllRules(game) {
    return cardsOf(game).map((c) => c.text);
  }

  function getFilteredGames() {
    const keyword = els.searchInput.value.trim();
    const player = els.playerFilter.value;
    const complexity = els.complexityFilter.value;
    const games = state.games.filter((game) => {
      const text = `${game.name}${getAllRules(game).join("")}`;
      const matchesKeyword = !keyword || text.includes(keyword);
      const matchesPlayer =
        player === "all" || (Number(player) >= game.minPlayers && Number(player) <= game.maxPlayers);
      const matchesComplexity = complexity === "all" || game.complexity === complexity;
      return matchesKeyword && matchesPlayer && matchesComplexity;
    });

    if (els.sortMode.value === "name") return games.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    if (els.sortMode.value === "complexity") {
      const rank = { 轻: 1, 中: 2, 重: 3 };
      return games.sort((a, b) => rank[b.complexity] - rank[a.complexity]);
    }
    return games.sort((a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed));
  }

  function renderSummary() {
    const allRuleCount = state.games.reduce((sum, game) => sum + cardsOf(game).length, 0);
    const stale = [...state.games].sort(
      (a, b) => daysSince(b.lastPlayed) - daysSince(a.lastPlayed)
    )[0];
    els.gameCount.textContent = state.games.length;
    els.ruleCount.textContent = allRuleCount;
    if (els.batchCount) els.batchCount.textContent = (state.batches || []).length;
  }

  function renderList() {
    const games = getFilteredGames();
    els.visibleCount.textContent = `${games.length}个匹配`;
    els.gameList.innerHTML =
      games
        .map((game) => {
          const selected = game.id === state.selectedId ? "selected" : "";
          return `
            <article class="game-card ${selected}" data-game-id="${game.id}">
              <div class="cover">
                ${
                  game.cover
                    ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`
                    : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`
                }
                <span class="stale-ribbon">${daysSince(game.lastPlayed)}天未玩</span>
              </div>
              <div class="game-body">
                <h3>${escapeHtml(game.name)}</h3>
                <div class="game-meta">
                  <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
                  <span class="pill">${game.duration}分钟</span>
                  <span class="pill heavy">${escapeHtml(game.complexity)}</span>
                </div>
              </div>
            </article>
          `;
        })
        .join("") || `<p class="empty">没有符合筛选的桌游。</p>`;
  }

  function renderRefChips(card, game) {
    if (!card.refs || !card.refs.length) return "";
    const chips = card.refs
      .map((rid) => {
        const target = game.cards.find((c) => c.id === rid);
        if (!target) {
          return `<span class="ref-chip broken" title="失效引用">⚠ 失效引用</span>`;
        }
        return `<button type="button" class="ref-chip" data-jump-card="${rid}" title="查看关联卡">🔗 ${escapeHtml(
          target.text.slice(0, 12)
        )}…</button>`;
      })
      .join("");
    return `<div class="ref-row">${chips}</div>`;
  }

  function renderRuleSection(title, section, game) {
    const items = cardsBySection(game, section);
    return `
      <section class="rule-section">
        <h3>${title}</h3>
        <ul class="rule-list">
          ${
            items
              .map((item) => {
                const hl = jumpCardId === item.id ? "highlight" : "";
                return `
                <li class="${hl}" id="card-${item.id}">
                  <div class="rule-text">
                    <span>${escapeHtml(item.text)}</span>
                    ${renderRefChips(item, game)}
                  </div>
                  <button type="button" title="删除" data-rule-id="${item.id}">×</button>
                </li>`;
              })
              .join("") || `<li><span>暂无内容。</span></li>`
          }
        </ul>
      </section>
    `;
  }

  function renderDetail() {
    const game = state.games.find((item) => item.id === state.selectedId) || state.games[0];
    if (!game) {
      els.detailView.innerHTML = `<p class="empty">先添加一个桌游。</p>`;
      return;
    }
    state.selectedId = game.id;
    const refOptions = cardsOf(game)
      .map(
        (c) =>
          `<label class="ref-opt"><input type="checkbox" name="ruleRefs" value="${c.id}" /> <span>[${SL[c.section]}] ${escapeHtml(
            c.text.slice(0, 22)
          )}</span></label>`
      )
      .join("");
    els.detailView.innerHTML = `
      <div class="quick-card">
        <div class="detail-cover">
          ${
            game.cover
              ? `<img src="${game.cover}" alt="${escapeHtml(game.name)}封面" />`
              : `<span>${escapeHtml(game.name.slice(0, 2))}</span>`
          }
        </div>
        <div>
          <h2>${escapeHtml(game.name)}</h2>
          <div class="game-meta">
            <span class="pill">${game.minPlayers}-${game.maxPlayers}人</span>
            <span class="pill">${game.duration}分钟</span>
            <span class="pill heavy">${escapeHtml(game.complexity)}</span>
            <span class="pill">${daysSince(game.lastPlayed)}天未玩</span>
          </div>
        </div>
        ${renderRuleSection("容易忘的规则", "forgets", game)}
        ${renderRuleSection("常见争议", "disputes", game)}
        ${renderRuleSection("开局准备", "setup", game)}
        ${renderRuleSection("计分提醒", "scoring", game)}
        <form class="add-rule" id="ruleForm">
          <select id="ruleTypeInput">
            <option value="forgets">容易忘的规则</option>
            <option value="disputes">常见争议</option>
            <option value="setup">开局准备</option>
            <option value="scoring">计分提醒</option>
          </select>
          <textarea id="ruleTextInput" rows="3" placeholder="补充一条聚会前要看的提醒" required></textarea>
          <details class="ref-picker">
            <summary>关联到其它规则卡（可选，${cardsOf(game).length} 张可选）</summary>
            <div class="ref-opts">${refOptions || "<span>暂无可关联卡片</span>"}</div>
          </details>
          <button class="primary" type="submit">加入规则卡片</button>
        </form>
        <div class="detail-actions">
          <button id="playedTodayBtn" type="button">标记今天玩过</button>
          <button id="deleteGameBtn" type="button">删除桌游</button>
        </div>
      </div>
    `;
    if (jumpCardId) {
      setTimeout(() => {
        document.getElementById("card-" + jumpCardId)?.scrollIntoView({ behavior: "smooth", block: "center" });
        jumpCardId = null;
      }, 50);
    }
  }

  function renderAll() {
    state = Store.state;
    renderSummary();
    renderList();
    renderDetail();
    if (window.MigrationUI && window.MigrationUI.refresh) window.MigrationUI.refresh();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      if (!file) {
        resolve("");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  }

  async function addGame(event) {
    event.preventDefault();
    const minPlayers = Number(els.minPlayersInput.value);
    const maxPlayers = Math.max(minPlayers, Number(els.maxPlayersInput.value));
    const cover = await readFileAsDataUrl(els.coverInput.files[0]);
    const name = els.nameInput.value.trim();
    const seed = {
      name,
      minPlayers,
      maxPlayers,
      duration: Number(els.durationInput.value),
      complexity: els.complexityInput.value,
      lastPlayed: els.lastPlayedInput.value,
      cover
    };
    Store.commit((s) => {
      const game = {
        id: uid(),
        ...seed,
        cards: [
          Store.makeCard("本局开始前先补充容易忘的规则。", "forgets"),
          Store.makeCard("整理组件并按人数调整初始设置。", "setup"),
          Store.makeCard("确认终局计分项和即时得分项。", "scoring")
        ]
      };
      s.games.unshift(game);
      s.selectedId = game.id;
    });
    els.gameForm.reset();
    setDefaultDate();
    renderAll();
  }

  function setDefaultDate() {
    const date = new Date();
    date.setMonth(date.getMonth() - 2);
    els.lastPlayedInput.value = date.toISOString().slice(0, 10);
  }

  /* ---------- 事件 ---------- */
  els.searchInput.addEventListener("input", renderAll);
  els.playerFilter.addEventListener("change", renderAll);
  els.complexityFilter.addEventListener("change", renderAll);
  els.sortMode.addEventListener("change", renderAll);
  els.gameForm.addEventListener("submit", addGame);

  els.gameList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-game-id]");
    if (!card) return;
    Store.commit((s) => {
      s.selectedId = card.dataset.gameId;
    }, { silent: true });
    state = Store.state;
    renderAll();
  });

  els.detailView.addEventListener("submit", (event) => {
    if (event.target.id !== "ruleForm") return;
    event.preventDefault();
    const text = document.querySelector("#ruleTextInput").value.trim();
    if (!text) return;
    const section = document.querySelector("#ruleTypeInput").value;
    const refIds = [...document.querySelectorAll('input[name="ruleRefs"]:checked')].map((i) => i.value);
    const gameId = state.selectedId;

    // 先建新卡，再补引用；防环校验
    const ok = Store.commit((s) => {
      const game = s.games.find((g) => g.id === gameId);
      if (!game) return false;
      const card = Store.makeCard(text, section);
      card.refs = refIds.filter((r) => game.cards.some((c) => c.id === r));
      game.cards.push(card);
      const edges = new Map(game.cards.map((c) => [c.id, c.refs]));
      if (Store.findCycle(game.cards.map((c) => c.id), edges)) {
        throw new Error("该关联会产生循环引用");
      }
    });
    if (!ok) flashLibrary("未保存：该关联会产生循环引用，请取消部分关联卡。", false);
    renderAll();
  });

  els.detailView.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-jump-card]");
    if (jump) {
      jumpCardId = jump.dataset.jumpCard;
      renderDetail();
      return;
    }
    const ruleButton = event.target.closest("[data-rule-id]");
    const playedButton = event.target.closest("#playedTodayBtn");
    const deleteButton = event.target.closest("#deleteGameBtn");
    const game = state.games.find((item) => item.id === state.selectedId);
    if (!game) return;

    if (ruleButton) {
      const cardId = ruleButton.dataset.ruleId;
      Store.commit((s) => {
        const g = s.games.find((x) => x.id === game.id);
        g.cards = g.cards.filter((c) => c.id !== cardId);
        for (const c of g.cards) c.refs = c.refs.filter((r) => r !== cardId);
      });
      renderAll();
    }

    if (playedButton) {
      Store.commit((s) => {
        const g = s.games.find((x) => x.id === game.id);
        g.lastPlayed = new Date().toISOString().slice(0, 10);
      });
      renderAll();
    }

    if (deleteButton) {
      const blocking = (Store.state.batches || []).filter(
        (b) =>
          b.status === "published" && (b.sourceGameId === game.id || b.targetGameId === game.id)
      );
      if (blocking.length) {
        flashLibrary(`「${game.name}」被 ${blocking.length} 个已发布批次引用，请先回滚这些批次再删除。`, false);
        return;
      }
      Store.commit((s) => {
        s.games = s.games.filter((item) => item.id !== game.id);
        s.selectedId = s.games[0]?.id || "";
      });
      renderAll();
    }
  });

  /* ---------- 标签页切换 ---------- */
  els.viewTabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (!tab) return;
    const view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    els.libraryView.classList.toggle("active", view === "library");
    els.migrationView.classList.toggle("active", view === "migration");
    if (view === "migration" && window.MigrationUI) window.MigrationUI.refresh();
  });

  /* ---------- 跨标签页同步 ---------- */
  Store.subscribe((event) => {
    state = Store.state;
    renderSummary();
    renderList();
    renderDetail();
    if (window.MigrationUI && window.MigrationUI.refresh) window.MigrationUI.refresh(event);
  });

  setDefaultDate();
  renderAll();
})();
