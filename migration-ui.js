/* 迁移中心 UI */
(function () {
  "use strict";

  const M = window.Migration;
  let currentBatchId = null;
  let resolvingForkId = null;

  const root = document.querySelector("#migrationView");
  const batchListEl = root.querySelector("#batchList");
  const editorEl = root.querySelector("#batchEditor");
  const bannerEl = root.querySelector("#mergeBanner");
  const toastEl = root.querySelector("#toast");
  const newBatchBtn = root.querySelector("#newBatchBtn");
  const exportBtn = root.querySelector("#exportBtn");
  const importFile = root.querySelector("#importFile");
  const importMode = root.querySelector("#importMode");
  const importReport = root.querySelector("#importReport");

  /* ============ 工具 ============ */
  function toast(msg, ok = true) {
    toastEl.textContent = msg;
    toastEl.className = "toast " + (ok ? "ok" : "err");
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), 3600);
  }

  function esc(v) {
    return escapeHtml(v);
  }

  function statusBadge(status) {
    return `<span class="status-badge ${status}">${M.STATUS_LABEL[status] || status}</span>`;
  }

  function issueBadge(type) {
    const meta = M.ISSUE_META[type];
    return `<span class="issue-badge ${meta.cls}">${meta.label}</span>`;
  }

  /* ============ 批次列表 ============ */
  function renderBatchList() {
    const batches = Store.state.batches || [];
    if (!batches.length) {
      batchListEl.innerHTML = `<p class="empty small">还没有批次。</p>`;
      return;
    }
    const sorted = [...batches].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    batchListEl.innerHTML = sorted
      .map((b) => {
        const target = Store.findGame(b.targetGameId);
        const source = Store.findGame(b.sourceGameId);
        const open = b.status === "draft" ? M.openIssues(b) : [];
        const severeCount = open.filter((i) => i.severe).length;
        const active = b.id === currentBatchId ? "active" : "";
        return `
          <div class="batch-item ${active}" data-batch-id="${b.id}" role="button" tabindex="0">
            <span class="batch-title">${esc(b.name)}</span>
            <span class="batch-sub">${esc(source?.name || "源已删除")} → ${esc(target?.name || "目标已删除")} · ${b.items.length} 项</span>
            <span class="batch-flags">
              ${statusBadge(b.status)}
              ${open.length ? `<span class="issue-count ${severeCount ? "block" : ""}">${open.length} 待处理${severeCount ? `（${severeCount} 阻断）` : ""}</span>` : ""}
              ${b.status === "draft" ? `<button type="button" class="mini batch-del" data-delete-batch="${b.id}" title="删除草稿">×</button>` : ""}
            </span>
          </div>`;
      })
      .join("");
  }

  /* ============ 新建批次表单 ============ */
  function renderCreateForm() {
    const games = Store.state.games;
    if (games.length < 1) {
      editorEl.innerHTML = `<p class="empty">请先在卡片库添加至少一个桌游。</p>`;
      return;
    }
    const src = games[0];
    const tgt = games[1] || games[0];
    editorEl.innerHTML = `
      <h2>新建迁移批次</h2>
      <form id="createBatchForm" class="create-form">
        <label>批次名称
          <input id="newBatchName" data-pristine="1" value="迁移：${esc(src.name)} → ${esc(tgt.name)}" required />
        </label>
        <div class="split">
          <label>源桌游
            <select id="newBatchSource">
              ${games.map((g) => `<option value="${g.id}" ${g.id === src.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
            </select>
          </label>
          <label>目标桌游
            <select id="newBatchTarget">
              ${games.map((g) => `<option value="${g.id}" ${g.id === tgt.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="hint">创建后可以勾选源卡、调整适用人数、逐项处理系统标出的问题。源文原文始终保留。</p>
        <div class="row-actions">
          <button class="primary" type="submit">创建批次</button>
          <button type="button" id="cancelCreateBtn">取消</button>
        </div>
      </form>`;
  }

  /* ============ 批次编辑器 ============ */
  function renderEditor() {
    if (currentBatchId === "__new__") {
      renderCreateForm();
      return;
    }
    const batch = M.batchById(currentBatchId);
    if (!batch) {
      editorEl.innerHTML = `<p class="empty">左侧新建或选择一个迁移批次。</p>`;
      return;
    }
    const source = Store.findGame(batch.sourceGameId);
    const target = Store.findGame(batch.targetGameId);
    const draft = batch.status === "draft";
    const issues = M.detectIssues(batch);
    const resolved = new Set(batch.resolvedIssueKeys || []);
    const issuesByItem = new Map();
    for (const i of issues) {
      if (!issuesByItem.has(i.itemId)) issuesByItem.set(i.itemId, []);
      issuesByItem.get(i.itemId).push(i);
    }
    const openList = issues.filter((i) => !resolved.has(i.key));
    const blocking = openList.filter((i) => i.severe);

    editorEl.innerHTML = `
      <div class="editor-head">
        <h2>${esc(batch.name)}</h2>
        <div>${statusBadge(batch.status)}</div>
      </div>

      <div class="batch-meta ${draft ? "" : "locked"}">
        <label class="meta-name">批次名称
          <input id="batchName" value="${esc(batch.name)}" ${draft ? "" : "disabled"} />
        </label>
        <div class="split">
          <label>源桌游
            <select id="batchSource" ${draft ? "" : "disabled"}>
              ${Store.state.games.map((g) => `<option value="${g.id}" ${g.id === batch.sourceGameId ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
            </select>
          </label>
          <label>目标桌游
            <select id="batchTarget" ${draft ? "" : "disabled"}>
              ${Store.state.games.map((g) => `<option value="${g.id}" ${g.id === batch.targetGameId ? "selected" : ""}>${esc(g.name)}（${g.minPlayers}-${g.maxPlayers}人）</option>`).join("")}
            </select>
          </label>
        </div>
      </div>

      ${draft ? renderSourcePicker(batch, source) : ""}

      <div class="panel-head">
        <h3>迁移项（${batch.items.length}）</h3>
        ${target ? `<span class="hint">目标支持 ${target.minPlayers}-${target.maxPlayers} 人</span>` : ""}
      </div>
      ${renderItems(batch, issuesByItem, resolved, target, draft)}

      ${draft ? renderGate(openList, blocking) : renderPublishedInfo(batch)}

      <div class="row-actions">
        ${draft ? `<button class="primary" id="publishBatch" type="button">发布批次</button>` : ""}
        ${batch.status === "published" ? `<button class="primary danger" id="rollbackBatch" type="button">回滚本批次</button>` : ""}
        ${batch.status === "rolled-back" ? `<button class="primary" id="republishBatch" type="button">重新发布</button>` : ""}
        ${draft ? `<button id="deleteBatch" type="button">删除草稿</button>` : ""}
      </div>`;
  }

  function renderSourcePicker(batch, source) {
    if (!source) return `<p class="issue-line">源桌游已被删除，无法继续添加源卡。</p>`;
    const added = new Set(batch.items.map((i) => i.sourceCardId));
    const groups = Store.SECTIONS.map((section) => {
      const cards = source.cards.filter((c) => c.section === section);
      if (!cards.length) return "";
      return `
        <details class="src-group" ${section === "forgets" ? "open" : ""}>
          <summary>${Store.SECTION_LABELS[section]}（${cards.length}）</summary>
          ${cards
            .map(
              (c) => `
            <label class="src-opt ${added.has(c.id) ? "added" : ""}">
              <input type="checkbox" class="src-card" value="${c.id}" ${added.has(c.id) ? "disabled checked" : ""} />
              <span>${esc(c.text)}</span>
            </label>`
            )
            .join("")}
        </details>`;
    }).join("");
    return `
      <details class="source-picker">
        <summary>选择源卡（勾选后点“添加选中卡”，重复勾选不会生成重复项）</summary>
        ${groups}
        <button type="button" id="addSrcCards" class="mini">添加选中卡</button>
      </details>`;
  }

  function renderRefPicker(batch, item, target, draft) {
    const existing = target
      ? target.cards
          .filter((c) => true)
          .map(
            (c) => `
          <label class="ref-opt"><input type="checkbox" data-ref-item="${item.id}" data-ref-value="${c.id}"
            ${(item.refIds || []).includes(c.id) ? "checked" : ""} ${draft ? "" : "disabled"} />
            <span>[${Store.SECTION_LABELS[c.section]}] ${esc(c.text.slice(0, 22))}</span></label>`
          )
          .join("")
      : "";
    const incoming = batch.items
      .filter((it) => it.id !== item.id && it.action !== "skip")
      .map(
        (it) => `
        <label class="ref-opt incoming"><input type="checkbox" data-ref-item="${item.id}" data-ref-value="${it.id}"
          ${(item.refIds || []).includes(it.id) ? "checked" : ""} ${draft ? "" : "disabled"} />
          <span class="tag">本批次</span><span>${esc((it.snapshotText || "").slice(0, 20))}</span></label>`
      )
      .join("");
    return `
      <details class="ref-picker">
        <summary>引用关联（${(item.refIds || []).length}）</summary>
        <div class="ref-opts">${existing}${incoming || "<span class='hint'>无其它迁移项</span>"}</div>
      </details>`;
  }

  function renderIssueActions(batch, issue, item) {
    const k = issue.key;
    const buttons = [];
    switch (issue.type) {
      case "duplicate":
        buttons.push(`<button type="button" class="mini" data-issue-adopt="${k}">沿用现有卡</button>`);
        if (issue.duplicateOf)
          buttons.push(`<button type="button" class="mini danger" data-issue-overwrite="${k}" data-dup-card="${issue.duplicateOf}">覆盖现有卡</button>`);
        buttons.push(`<button type="button" class="mini" data-issue-keep="${k}">确认保留两张</button>`);
        buttons.push(`<button type="button" class="mini" data-issue-skip-item="${item.id}">跳过本项</button>`);
        break;
      case "conflict":
        buttons.push(`<button type="button" class="mini" data-issue-fix-conflict="${item.id}">改为最近的合法人数</button>`);
        buttons.push(`<span class="hint">或直接调整下方人数，</span>`);
        buttons.push(`<button type="button" class="mini" data-issue-skip-item="${item.id}">跳过本项</button>`);
        break;
      case "missing":
        buttons.push(`<button type="button" class="mini" data-issue-resolve="${k}">确认按保留的原文迁入</button>`);
        buttons.push(`<button type="button" class="mini" data-issue-skip-item="${item.id}">跳过本项</button>`);
        break;
      case "dangling":
        buttons.push(`<button type="button" class="mini" data-issue-clear-dangling="${k}" data-item-id="${item.id}">移除失效引用</button>`);
        buttons.push(`<button type="button" class="mini" data-issue-skip-item="${item.id}">跳过本项</button>`);
        break;
      case "cycle":
        buttons.push(`<button type="button" class="mini danger" data-issue-break-cycle="${k}" data-item-id="${item.id}">清空本条引用以断环</button>`);
        buttons.push(`<button type="button" class="mini" data-issue-skip-item="${item.id}">跳过本项</button>`);
        break;
    }
    return `<div class="issue-actions">${buttons.join(" ")}</div>`;
  }

  function renderItems(batch, issuesByItem, resolved, target, draft) {
    if (!batch.items.length) return `<p class="empty">还没有迁移项，从上方“选择源卡”开始。</p>`;
    return (
      `<div class="item-list">` +
      batch.items
        .map((item, idx) => {
          const source = Store.findGame(item.sourceGameId);
          const sourceCard = source?.cards.find((c) => c.id === item.sourceCardId);
          const issues = (issuesByItem.get(item.id) || []).filter((i) => !resolved.has(i.key));
          const skipped = item.action === "skip";
          const playersOk = target
            ? item.applicablePlayers >= target.minPlayers && item.applicablePlayers <= target.maxPlayers
            : true;
          return `
          <article class="mig-item ${skipped ? "skipped" : ""}" data-item-id="${item.id}">
            <div class="item-head">
              <span class="item-index">#${idx + 1}</span>
              <span class="item-route">${esc(source?.name || "源已删除")} → ${esc(target?.name || "目标已删除")}</span>
              ${draft ? `<button type="button" class="mini remove" data-item-remove="${item.id}">移除</button>` : ""}
            </div>

            <div class="original-box">
              <span class="box-label">原文（保留不可改）</span>
              <p class="original-text">${esc(item.snapshotText || sourceCard?.text || "（原文缺失）")}</p>
            </div>

            <label class="adapt-box">迁移文本（留空沿用原文）
              <textarea rows="2" data-item-id="${item.id}" data-item-field="adaptedText"
                placeholder="${esc(item.snapshotText || "")}" ${draft ? "" : "disabled"}>${esc(item.adaptedText || "")}</textarea>
            </label>

            <div class="item-controls">
              <label>分区
                <select data-item-id="${item.id}" data-item-field="targetSection" ${draft ? "" : "disabled"}>
                  ${Store.SECTIONS.map((s) => `<option value="${s}" ${item.targetSection === s ? "selected" : ""}>${Store.SECTION_LABELS[s]}</option>`).join("")}
                </select>
              </label>
              <label class="${playersOk ? "" : "bad-input"}">适用人数
                <input type="number" min="${target?.minPlayers ?? 1}" max="${target?.maxPlayers ?? 12}"
                  value="${item.applicablePlayers}" data-item-id="${item.id}" data-item-field="applicablePlayers" ${draft ? "" : "disabled"} />
              </label>
              <fieldset class="action-box" ${draft ? "" : "disabled"}>
                <legend>处理方式</legend>
                ${M.ACTIONS.filter((a) => a !== "overwrite" || item.overwriteCardId).map((a) => `
                  <label class="action-opt"><input type="radio" name="itemAction-${item.id}" value="${a}" ${item.action === a ? "checked" : ""} /> ${M.ACTION_LABEL[a]}</label>
                `).join("")}
              </fieldset>
            </div>

            ${draft ? renderRefPicker(batch, item, target, draft) : ""}

            ${
              issues.length
                ? `<div class="issue-box">
                     ${issues
                       .map(
                         (i) => `
                       <div class="issue-row ${M.ISSUE_META[i.type].cls}">
                         <span>${issueBadge(i.type)} ${esc(i.detail || M.ISSUE_META[i.type].desc)}</span>
                         ${renderIssueActions(batch, i, item)}
                       </div>`
                       )
                       .join("")}
                   </div>`
                : ""
            }
          </article>`;
        })
        .join("") +
      `</div>`
    );
  }

  function renderGate(openList, blocking) {
    if (!openList.length) {
      return `<div class="gate ok">所有重复、缺失、冲突与引用问题均已处理，可以发布。发布采用原子提交，失败不会改动现有卡片。</div>`;
    }
    return `
      <div class="gate block">
        <strong>发布前还剩 ${openList.length} 项待处理${blocking.length ? `（${blocking.length} 项阻断发布）` : ""}</strong>
        <ul>
          ${openList
            .slice(0, 8)
            .map((i) => `<li>${issueBadge(i.type)} ${esc(i.detail || M.ISSUE_META[i.type].desc)}</li>`)
            .join("")}
          ${openList.length > 8 ? `<li>…另有 ${openList.length - 8} 项</li>` : ""}
        </ul>
      </div>`;
  }

  function renderPublishedInfo(batch) {
    const snap = batch.history[batch.history.length - 1];
    if (!snap) return "";
    return `
      <div class="gate ${batch.status === "published" ? "ok" : "rolled"}">
        ${batch.status === "published" ? "批次已发布。" : "批次已回滚，发布产生的卡片已删除/恢复原文。"}
        <span class="hint">最近发布：新建 ${snap.created.length} 张，覆盖 ${snap.overwritten.length} 张（${(batch.publishedAt || "").replace("T", " ").slice(0, 16)}）。
        重复点发布不会重复迁卡；回滚同样可安全重复执行。</span>
      </div>`;
  }

  /* ============ 分叉合并横幅 ============ */
  function renderMergeBanner() {
    const forks = Store.state.pendingMerges || [];
    if (!forks.length) {
      bannerEl.innerHTML = "";
      return;
    }
    bannerEl.innerHTML = `
      <div class="merge-banner">
        <strong>⚠ 检测到 ${forks.length} 处双标签页同时修改：双方版本均已保留，合并前不会互相覆盖。</strong>
        ${forks
          .map((f) => {
            const name =
              (f.local && f.local.name) || (f.remote && f.remote.name) || f.entityId.slice(0, 8);
            return `
              <div class="fork-row">
                <span>${f.kind === "batch" ? "批次" : "桌游"}「${esc(name)}」存在两个版本</span>
                <button type="button" class="mini primary" data-resolve-fork="${f.id}">比较差异并合并</button>
                <button type="button" class="mini" data-drop-fork="${f.id}">暂不处理</button>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  /* ============ 差异比较与合并视图 ============ */
  function diffTokens(a, b) {
    a = String(a ?? "");
    b = String(b ?? "");
    if (a === b) return [{ t: "same", v: a }];
    // 短文本按字符 LCS
    const n = a.length,
      m = b.length;
    if (n + m > 600) {
      return [
        { t: "del", v: a },
        { t: "add", v: b }
      ];
    }
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0,
      j = 0;
    const push = (t, v) => {
      const last = out[out.length - 1];
      if (last && last.t === t) last.v += v;
      else out.push({ t, v });
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        push("same", a[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push("del", a[i]);
        i++;
      } else {
        push("add", b[j]);
        j++;
      }
    }
    if (i < n) push("del", a.slice(i));
    if (j < m) push("add", b.slice(j));
    return out;
  }

  function diffHtml(tokens) {
    return tokens
      .map((tk) => {
        if (tk.t === "same") return esc(tk.v);
        if (tk.t === "del") return `<del>${esc(tk.v)}</del>`;
        return `<ins>${esc(tk.v)}</ins>`;
      })
      .join("");
  }

  const ENTITY_FIELDS = [
    { key: "name", label: "名称" },
    { key: "status", label: "状态", map: (v) => M.STATUS_LABEL[v] || v },
    {
      key: "targetGameId",
      label: "目标桌游",
      map: (v) => Store.findGame(v)?.name || (v ? "已删除" : "—")
    },
    { key: "updatedAt", label: "最后修改", map: (v) => (v ? String(v).replace("T", " ").slice(0, 16) : "—") }
  ];

  function renderForkResolver(forkId) {
    const fork = (Store.state.pendingMerges || []).find((f) => f.id === forkId);
    if (!fork) return;
    resolvingForkId = forkId;
    const L = fork.local;
    const R = fork.remote;
    const sideName = (x) => (x ? esc(x.name || x.entityId) : "（另一页已删除）");

    let body;
    if (fork.kind === "batch") {
      body = renderBatchForkDiff(L, R);
    } else {
      body = renderGameForkDiff(L, R);
    }

    editorEl.innerHTML = `
      <div class="fork-resolver">
        <div class="editor-head">
          <h2>比较并合并 · ${sideName(L || R)}</h2>
          <button type="button" class="mini" id="closeForkBtn">返回</button>
        </div>
        <div class="fork-cols">
          <div class="fork-col local"><h4>本标签页版本</h4><p class="hint">${L ? esc(L.name) : "已删除"}</p></div>
          <div class="fork-col remote"><h4>另一标签页版本</h4><p class="hint">${R ? esc(R.name) : "已删除"}</p></div>
        </div>
        <div class="fork-legend"><del>删除</del> <ins>新增</ins>，逐行选择保留哪一侧；合并完成前两侧版本都不会丢失。</div>
        ${body}
        <div class="row-actions">
          <button type="button" class="primary" id="applyForkBtn">应用合并</button>
          <button type="button" class="mini" id="allLocalBtn">全部取本页</button>
          <button type="button" class="mini" id="allRemoteBtn">全部取另一页</button>
          <button type="button" class="mini" id="cancelForkBtn">取消</button>
        </div>
      </div>`;
  }

  function metaRow(label, localVal, remoteVal, mapFn) {
    const lv = mapFn ? mapFn(localVal) : localVal;
    const rv = mapFn ? mapFn(remoteVal) : remoteVal;
    const same = String(lv ?? "") === String(rv ?? "");
    return `
      <div class="fork-meta-row ${same ? "" : "diff"}">
        <span class="fm-label">${label}</span>
        ${
          same
            ? `<span class="fm-val">${esc(lv ?? "—")}</span>`
            : `
          <label class="fm-choice"><input type="radio" name="fm" value="L" checked /> <span>${esc(lv ?? "—")}</span></label>
          <span class="fm-arrow">⇄</span>
          <label class="fm-choice"><input type="radio" name="fm" value="R" /> <span>${esc(rv ?? "—")}</span></label>
          <code class="fm-diff">${diffHtml(diffTokens(lv, rv))}</code>`
        }
      </div>`;
  }

  function renderBatchForkDiff(L, R) {
    // 标量字段：name 用行选择；其它字段按差异单独提供 name="fm-<key>"
    const fields = ENTITY_FIELDS;
    const metaRows = fields
      .map((f) => {
        const lv = L ? L[f.key] : null;
        const rv = R ? R[f.key] : null;
        const same = JSON.stringify(lv) === JSON.stringify(rv);
        return `
          <div class="fork-meta-row ${same ? "" : "diff"}" data-field="${f.key}">
            <span class="fm-label">${f.label}</span>
            ${
              same
                ? `<span class="fm-val">${esc(f.map ? f.map(lv) : lv ?? "—")}</span>`
                : `
              <label class="fm-choice"><input type="radio" name="fm-${f.key}" value="L" checked /> <span>${esc(f.map ? f.map(lv) : lv ?? "—")}</span></label>
              <span class="fm-arrow">⇄</span>
              <label class="fm-choice"><input type="radio" name="fm-${f.key}" value="R" /> <span>${esc(f.map ? f.map(rv) : rv ?? "—")}</span></label>
              <code class="fm-diff">${diffHtml(diffTokens(f.map ? f.map(lv) : lv, f.map ? f.map(rv) : rv))}</code>`
            }
          </div>`;
      })
      .join("");

    const lItems = new Map((L?.items || []).map((it) => [it.id, it]));
    const rItems = new Map((R?.items || []).map((it) => [it.id, it]));
    const ids = [];
    for (const id of lItems.keys()) if (!ids.includes(id)) ids.push(id);
    for (const id of rItems.keys()) if (!ids.includes(id)) ids.push(id);

    const rows = ids
      .map((id) => {
        const a = lItems.get(id);
        const b = rItems.get(id);
        const summary = (it) =>
          it
            ? `「${esc((it.snapshotText || "").slice(0, 16))}」 ${M.ACTION_LABEL[it.action] || it.action} · ${Store.SECTION_LABELS[it.targetSection] || ""} · ${it.applicablePlayers}人 · 改编“${esc((it.adaptedText || "").slice(0, 16))}”`
            : "（本页没有此项）";
        const same = JSON.stringify(a) === JSON.stringify(b);
        return `
          <div class="fork-item-row ${same ? "" : "diff"}" data-item-id="${id}">
            <div class="fi-sides">
              <label class="${a ? "" : "missing-side"}"><input type="radio" name="fi-${id}" value="L" ${a ? "checked" : "disabled"} /> <span>${summary(a)}</span></label>
              <label class="${b ? "" : "missing-side"}"><input type="radio" name="fi-${id}" value="R" ${b ? "" : "disabled"} ${!a && b ? "checked" : ""} /> <span>${summary(b)}</span></label>
            </div>
            ${!same ? `<code class="fm-diff">${diffHtml(diffTokens(a ? JSON.stringify({ t: a.adaptedText, act: a.action, sec: a.targetSection, p: a.applicablePlayers }, null, 1) : "", b ? JSON.stringify({ t: b.adaptedText, act: b.action, sec: b.targetSection, p: b.applicablePlayers }, null, 1) : ""))}</code>` : ""}
          </div>`;
      })
      .join("");

    return `
      <div class="fork-meta">${metaRows}</div>
      <h4>迁移项逐项选择</h4>
      <div class="fork-items">${rows || "<p class='hint'>两边都没有迁移项。</p>"}</div>`;
  }

  function renderGameForkDiff(L, R) {
    const fields = [
      { key: "name", label: "名称" },
      { key: "minPlayers", label: "最少人数" },
      { key: "maxPlayers", label: "最多人数" },
      { key: "duration", label: "时长" },
      { key: "complexity", label: "复杂度" },
      { key: "lastPlayed", label: "上次游玩" }
    ];
    const metaRows = fields
      .map((f) => {
        const lv = L ? L[f.key] : null;
        const rv = R ? R[f.key] : null;
        const same = JSON.stringify(lv) === JSON.stringify(rv);
        return `
          <div class="fork-meta-row ${same ? "" : "diff"}" data-field="${f.key}">
            <span class="fm-label">${f.label}</span>
            ${
              same
                ? `<span class="fm-val">${esc(lv ?? "—")}</span>`
                : `
              <label class="fm-choice"><input type="radio" name="fm-${f.key}" value="L" checked /> <span>${esc(lv ?? "—")}</span></label>
              <span class="fm-arrow">⇄</span>
              <label class="fm-choice"><input type="radio" name="fm-${f.key}" value="R" /> <span>${esc(rv ?? "—")}</span></label>`
            }
          </div>`;
      })
      .join("");
    const lc = L?.cards?.length ?? 0;
    const rc = R?.cards?.length ?? 0;
    return `
      <div class="fork-meta">${metaRows}</div>
      <h4>规则卡集合</h4>
      <div class="fork-meta-row diff">
        <span class="fm-label">全部卡片</span>
        <label class="fm-choice"><input type="radio" name="cards-side" value="L" checked /> <span>本页版本（${lc} 张）</span></label>
        <span class="fm-arrow">⇄</span>
        <label class="fm-choice"><input type="radio" name="cards-side" value="R" /> <span>另一页版本（${rc} 张）</span></label>
      </div>`;
  }

  function applyFork(sideOverride) {
    const fork = (Store.state.pendingMerges || []).find((f) => f.id === resolvingForkId);
    if (!fork) return;
    const next = structuredClone(Store.state);

    let mergedEntity;
    if (sideOverride) {
      mergedEntity = sideOverride === "L" ? fork.local : fork.remote;
    } else if (fork.kind === "batch") {
      const base = structuredClone(fork.local || fork.remote);
      if (fork.local && fork.remote) {
        for (const f of ENTITY_FIELDS) {
          const choice = editorEl.querySelector(`input[name="fm-${f.key}"]:checked`);
          if (choice) base[f.key] = choice.value === "L" ? fork.local[f.key] : fork.remote[f.key];
        }
        const lItems = new Map((fork.local.items || []).map((it) => [it.id, it]));
        const rItems = new Map((fork.remote.items || []).map((it) => [it.id, it]));
        const ids = [];
        for (const id of lItems.keys()) if (!ids.includes(id)) ids.push(id);
        for (const id of rItems.keys()) if (!ids.includes(id)) ids.push(id);
        base.items = ids
          .map((id) => {
            const choice = editorEl.querySelector(`input[name="fi-${id}"]:checked`);
            if (!choice) return null;
            return structuredClone(choice.value === "L" ? lItems.get(id) : rItems.get(id));
          })
          .filter(Boolean);
      }
      mergedEntity = base;
    } else {
      const base = structuredClone(fork.local || fork.remote);
      const fields = ["name", "minPlayers", "maxPlayers", "duration", "complexity", "lastPlayed"];
      if (fork.local && fork.remote) {
        for (const key of fields) {
          const choice = editorEl.querySelector(`input[name="fm-${key}"]:checked`);
          if (choice) base[key] = choice.value === "L" ? fork.local[key] : fork.remote[key];
        }
        const cardChoice = editorEl.querySelector(`input[name="cards-side"]:checked`);
        if (cardChoice) base.cards = structuredClone(cardChoice.value === "L" ? fork.local.cards : fork.remote.cards);
      }
      mergedEntity = base;
    }

    const coll = fork.kind === "batch" ? next.batches : next.games;
    const idx = coll.findIndex((x) => x.id === fork.entityId);
    if (mergedEntity === null || mergedEntity === undefined) {
      if (idx >= 0) coll.splice(idx, 1);
    } else if (idx >= 0) {
      coll[idx] = structuredClone(mergedEntity);
    } else {
      coll.push(structuredClone(mergedEntity));
    }
    next.pendingMerges = (next.pendingMerges || []).filter((f) => f.id !== fork.id);
    Store.commitState(next);
    resolvingForkId = null;
    if (fork.kind === "batch") currentBatchId = mergedEntity ? fork.entityId : null;
    toast("已合并双方版本并保存");
    fullRender();
  }

  function chooseAllFork(side) {
    editorEl.querySelectorAll('input[type="radio"]').forEach((r) => {
      if (r.value === side && !r.disabled) r.checked = true;
    });
  }

  /* ============ 导入 / 导出 ============ */
  function doExport() {
    const blob = new Blob([M.exportData()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rule-cards-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出全部数据");
  }

  function doImport(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = M.importJson(String(reader.result), importMode.value);
      if (result.ok) {
        importReport.hidden = true;
        toast(`导入成功（${importMode.value === "replace" ? "整库替换" : "按 id 合并"}）`);
        currentBatchId = null;
        fullRender();
      } else {
        importReport.hidden = false;
        importReport.textContent =
          `导入被拒绝（${result.errors.length} 个问题），原数据未改动：\n\n` +
          result.errors.map((e, i) => `${i + 1}. ${e}`).join("\n");
        toast("导入被拒绝，原数据未改动", false);
      }
    };
    reader.readAsText(file);
  }

  /* ============ 事件委托 ============ */
  newBatchBtn.addEventListener("click", () => {
    currentBatchId = "__new__";
    renderEditor();
  });
  exportBtn.addEventListener("click", doExport);
  importFile.addEventListener("change", () => {
    if (importFile.files[0]) doImport(importFile.files[0]);
    importFile.value = "";
  });

  batchListEl.addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-batch]");
    const item = e.target.closest("[data-batch-id]");
    if (del) {
      e.stopPropagation();
      const res = M.deleteBatch(del.dataset.deleteBatch);
      if (res === false) toast("已发布批次需先回滚才能删除", false);
      else {
        if (currentBatchId === del.dataset.deleteBatch) currentBatchId = null;
        fullRender();
      }
      return;
    }
    if (item) {
      currentBatchId = item.dataset.batchId;
      renderBatchList();
      renderEditor();
    }
  });

  bannerEl.addEventListener("click", (e) => {
    const resolveBtn = e.target.closest("[data-resolve-fork]");
    const dropBtn = e.target.closest("[data-drop-fork]");
    if (resolveBtn) {
      currentBatchId = null;
      renderForkResolver(resolveBtn.dataset.resolveFork);
    }
    if (dropBtn) {
      const id = dropBtn.dataset.dropFork;
      const next = structuredClone(Store.state);
      next.pendingMerges = (next.pendingMerges || []).filter((f) => f.id !== id);
      Store.commitState(next);
      fullRender();
    }
  });

  editorEl.addEventListener("click", (e) => {
    const t = e.target;

    if (t.closest("#cancelCreateBtn")) {
      currentBatchId = null;
      renderEditor();
      return;
    }
    if (t.closest("#closeForkBtn") || t.closest("#cancelForkBtn")) {
      resolvingForkId = null;
      currentBatchId = Store.state.batches[0]?.id || null;
      fullRender();
      return;
    }
    if (t.closest("#allLocalBtn")) return chooseAllFork("L");
    if (t.closest("#allRemoteBtn")) return chooseAllFork("R");
    if (t.closest("#applyForkBtn")) return applyFork();

    const batch = M.batchById(currentBatchId);

    if (t.closest("#addSrcCards")) {
      const ids = [...editorEl.querySelectorAll(".src-card:checked")].map((c) => c.value);
      if (!ids.length) return toast("先勾选要迁移的源卡", false);
      M.addItems(currentBatchId, ids);
      afterMutation();
      return;
    }
    if (t.closest("#publishBatch") || t.closest("#republishBatch")) {
      const res = M.publishBatch(currentBatchId);
      if (res.ok) toast(res.duplicated ? "该批次已发布，重复提交未生成重复卡" : `发布成功：新建 ${res.created ?? 0} 张，覆盖 ${res.overwritten ?? 0} 张`);
      else toast(res.errors[0] || "仍有问题未处理，无法发布", false);
      fullRender();
      return;
    }
    if (t.closest("#rollbackBatch")) {
      const res = M.rollbackBatch(currentBatchId);
      if (res.ok) toast(res.duplicated ? "批次此前已回滚，未重复执行" : `已回滚：删除 ${res.removed} 张，恢复 ${res.restored} 张原文`);
      else toast(res.errors[0] || "回滚失败", false);
      fullRender();
      return;
    }
    if (t.closest("#deleteBatch")) {
      M.deleteBatch(currentBatchId);
      currentBatchId = null;
      fullRender();
      return;
    }

    if (!batch || batch.status !== "draft") return;

    const remove = t.closest("[data-item-remove]");
    if (remove) {
      M.removeItem(currentBatchId, remove.dataset.itemRemove);
      afterMutation();
      return;
    }

    const skipItem = t.closest("[data-issue-skip-item]");
    if (skipItem) {
      M.updateItem(currentBatchId, skipItem.dataset.issueSkipItem, { action: "skip" });
      afterMutation();
      return;
    }
    const fixConflict = t.closest("[data-issue-fix-conflict]");
    if (fixConflict) {
      const target = Store.findGame(batch.targetGameId);
      const it = batch.items.find((x) => x.id === fixConflict.dataset.issueFixConflict);
      if (target && it) {
        const p = Math.min(target.maxPlayers, Math.max(target.minPlayers, Number(it.applicablePlayers) || target.minPlayers));
        M.updateItem(currentBatchId, it.id, { applicablePlayers: p });
      }
      afterMutation();
      return;
    }
    const resolve = t.closest("[data-issue-resolve]");
    if (resolve) {
      M.resolveIssue(currentBatchId, resolve.dataset.issueResolve);
      afterMutation();
      return;
    }
    const keep = t.closest("[data-issue-keep]");
    if (keep) {
      M.resolveIssue(currentBatchId, keep.dataset.issueKeep);
      afterMutation();
      return;
    }
    const adopt = t.closest("[data-issue-adopt]");
    if (adopt) {
      const issue = M.detectIssues(batch).find((i) => i.key === adopt.dataset.issueAdopt);
      if (issue) {
        M.updateItem(currentBatchId, issue.itemId, { action: "adopt" });
        M.resolveIssue(currentBatchId, issue.key);
      }
      afterMutation();
      return;
    }
    const overwrite = t.closest("[data-issue-overwrite]");
    if (overwrite) {
      const issue = M.detectIssues(batch).find((i) => i.key === overwrite.dataset.issueOverwrite);
      if (issue) {
        const next = structuredClone(Store.state);
        const b = next.batches.find((x) => x.id === currentBatchId);
        const it = b.items.find((x) => x.id === issue.itemId);
        it.action = "overwrite";
        it.overwriteCardId = overwrite.dataset.dupCard;
        Store.commitState(next);
        M.resolveIssue(currentBatchId, issue.key);
      }
      afterMutation();
      return;
    }
    const clearDangling = t.closest("[data-issue-clear-dangling]");
    if (clearDangling) {
      const itemId = clearDangling.dataset.itemId;
      const it = batch.items.find((x) => x.id === itemId);
      const target = Store.findGame(batch.targetGameId);
      const valid = new Set([...(target?.cards || []).map((c) => c.id), ...batch.items.filter((x) => x.id !== itemId).map((x) => x.id)]);
      M.updateItem(currentBatchId, itemId, { refIds: (it.refIds || []).filter((r) => valid.has(r)) });
      afterMutation();
      return;
    }
    const breakCycle = t.closest("[data-issue-break-cycle]");
    if (breakCycle) {
      M.updateItem(currentBatchId, breakCycle.dataset.itemId, { refIds: [] });
      afterMutation();
    }
  });

  editorEl.addEventListener("input", (e) => {
    if (e.target.id === "newBatchName") e.target.dataset.pristine = "0";
  });

  editorEl.addEventListener("change", (e) => {
    const t = e.target;

    if (t.id === "newBatchSource" || t.id === "newBatchTarget") {
      const name = editorEl.querySelector("#newBatchName");
      // 仅当用户尚未手动改名时，才跟随源/目标自动命名
      if (name.dataset.pristine === "1") {
        const s = Store.findGame(editorEl.querySelector("#newBatchSource").value);
        const g = Store.findGame(editorEl.querySelector("#newBatchTarget").value);
        if (s && g) name.value = `迁移：${s.name} → ${g.name}`;
      }
      return;
    }
    if (t.id === "batchName") {
      M.updateBatchMeta(currentBatchId, { name: t.value });
      renderBatchList();
      return;
    }
    if (t.id === "batchSource") {
      M.updateBatchMeta(currentBatchId, { sourceGameId: t.value });
      afterMutation();
      return;
    }
    if (t.id === "batchTarget") {
      M.updateBatchMeta(currentBatchId, { targetGameId: t.value });
      afterMutation();
      return;
    }
    if (t.name === "itemAction") return;
    if (t.matches("[data-item-field]")) {
      const id = t.dataset.itemId;
      const field = t.dataset.itemField;
      const value = field === "applicablePlayers" ? Number(t.value) : t.value;
      M.updateItem(currentBatchId, id, { [field]: value });
      afterMutation();
      return;
    }
    if (t.matches("[data-ref-item]")) {
      const itemId = t.dataset.refItem;
      const batch = M.batchById(currentBatchId);
      const it = batch.items.find((x) => x.id === itemId);
      let refIds = [...(it.refIds || [])];
      if (t.checked) {
        if (!refIds.includes(t.dataset.refValue)) refIds.push(t.dataset.refValue);
      } else {
        refIds = refIds.filter((r) => r !== t.dataset.refValue);
      }
      M.updateItem(currentBatchId, itemId, { refIds });
      afterMutation();
    }
  });

  // 动作单选
  editorEl.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name && t.name.startsWith("itemAction-")) {
      const itemId = t.name.slice("itemAction-".length);
      const patch = { action: t.value };
      if (t.value !== "overwrite") {
        // overwriteCardId 保留无妨
      }
      M.updateItem(currentBatchId, itemId, patch);
      afterMutation();
    }
  });

  // 创建批次提交
  editorEl.addEventListener("submit", (e) => {
    if (e.target.id !== "createBatchForm") return;
    e.preventDefault();
    const name = editorEl.querySelector("#newBatchName").value.trim();
    const sourceGameId = editorEl.querySelector("#newBatchSource").value;
    const targetGameId = editorEl.querySelector("#newBatchTarget").value;
    const batch = M.createBatch({ name, sourceGameId, targetGameId });
    currentBatchId = batch.id;
    fullRender();
    toast("批次已创建（草稿），请选择源卡");
  });

  function afterMutation() {
    renderBatchList();
    renderEditor();
  }

  function fullRender() {
    renderMergeBanner();
    renderBatchList();
    if (resolvingForkId) renderForkResolver(resolvingForkId);
    else renderEditor();
  }

  window.MigrationUI = {
    refresh(event) {
      renderMergeBanner();
      renderBatchList();
      // 远端更新或分叉时重绘编辑器；本地编辑由各处理器自行重绘，避免抢焦点
      if (!event || event.remote || (event.forks && event.forks.length)) {
        if (resolvingForkId) renderForkResolver(resolvingForkId);
        else renderEditor();
      }
    }
  };

  fullRender();
})();
