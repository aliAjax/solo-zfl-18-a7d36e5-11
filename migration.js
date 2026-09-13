/* 迁移中心：批次、问题检测、发布/回滚、导入导出、分叉合并 UI */
(function () {
  "use strict";

  const S = Store.SECTIONS;
  const SL = Store.SECTION_LABELS;
  const BATCH_STATUSES = ["draft", "published", "rolled-back"];
  const STATUS_LABEL = { draft: "草稿", published: "已发布", rolled: "已回滚", "rolled-back": "已回滚" };
  const ACTIONS = ["create", "skip", "overwrite", "adopt"];
  const ACTION_LABEL = { create: "作为新卡迁入", skip: "跳过不迁", overwrite: "覆盖现有卡", adopt: "沿用现有卡" };

  /* ============ 基础工具 ============ */
  function norm(text) {
    return String(text || "").trim().replace(/\s+/g, "");
  }

  function batchById(id) {
    return Store.state.batches.find((b) => b.id === id) || null;
  }

  function issueKey(type, itemId, extra) {
    return `${type}:${itemId}${extra ? ":" + extra : ""}`;
  }

  function sourceCardText(sourceGameId, sourceCardId) {
    const g = Store.findGame(sourceGameId);
    const c = g?.cards.find((x) => x.id === sourceCardId);
    return c ? c.text : null;
  }

  function itemText(it) {
    return it.adaptedText?.trim() || sourceCardText(it.sourceGameId, it.sourceCardId) || it.snapshotText || "";
  }

  /* ============ 问题检测 ============
     每条 item 可能带的问题：
     - missing   源卡/源桌游已被删除（保留原文 snapshotText）
     - duplicate 目标桌游已有同文本卡，或本批次内将产生重复卡
     - conflict  适用人数超出目标桌游人数范围
     - cycle     item 的 refIds 在目标图上形成循环引用
     - dangling  item 引用了目标桌游中不存在、且本批次也不会迁入的卡
  */
  function detectIssues(batch) {
    const target = Store.findGame(batch.targetGameId);
    const issues = [];

    const validItems = batch.items.filter((it) => it.action !== "skip");

    // 1. 缺失：源不存在
    for (const it of batch.items) {
      const g = Store.findGame(it.sourceGameId);
      const c = g?.cards.find((x) => x.id === it.sourceCardId);
      if (!g || !c) {
        issues.push({ key: issueKey("missing", it.id), type: "missing", itemId: it.id, severe: true });
      }
    }

    if (target) {
      // 2. 冲突：适用人数越界
      for (const it of validItems) {
        const p = Number(it.applicablePlayers);
        if (!Number.isInteger(p) || p < target.minPlayers || p > target.maxPlayers) {
          issues.push({
            key: issueKey("conflict", it.id),
            type: "conflict",
            itemId: it.id,
            severe: true,
            detail: `目标「${target.name}」支持 ${target.minPlayers}-${target.maxPlayers} 人，本条设定 ${p} 人`
          });
        }
      }

      // 3a. 与目标现有卡重复（按归一化文本 + 分区）
      const existingBySection = new Map();
      for (const c of target.cards) {
        const k = c.section + "|" + norm(c.text);
        if (!existingBySection.has(k)) existingBySection.set(k, []);
        existingBySection.get(k).push(c);
      }
      for (const it of validItems) {
        if (it.action === "adopt" || it.action === "overwrite") continue; // 显式沿用/覆盖不算静默重复
        const text = itemText(it);
        const k = it.targetSection + "|" + norm(text);
        const dup = existingBySection.get(k);
        if (dup && dup.length) {
          issues.push({
            key: issueKey("duplicate", it.id, dup[0].id),
            type: "duplicate",
            itemId: it.id,
            severe: false,
            detail: `目标已有同内容卡「${dup[0].text.slice(0, 24)}」`,
            duplicateOf: dup[0].id
          });
        }
      }

      // 3b. 批次内重复（多条迁同一段文本到同一分区）
      const firstOwner = new Map();
      batch.items.forEach((it, idx) => {
        if (it.action === "skip" || it.action === "adopt" || it.action === "overwrite") return;
        const text = itemText(it);
        const k = it.targetSection + "|" + norm(text);
        if (firstOwner.has(k)) {
          issues.push({
            key: issueKey("duplicate", it.id, "batch-" + firstOwner.get(k).id),
            type: "duplicate",
            itemId: it.id,
            severe: false,
            detail: `与批次内第 ${firstOwner.get(k).index + 1} 条内容相同`
          });
        } else {
          firstOwner.set(k, { id: it.id, index: idx });
        }
      });

      // 4. 引用：失效引用 + 循环引用（在“迁移后目标图”上计算）
      //    迁入项在模拟图中的临时 id = item.id
      const incomingIds = new Set(validItems.map((it) => it.id));
      const existingIds = new Set(target.cards.map((c) => c.id));
      // item 选中的 overwrite 目标卡也作为该 item 的落点
      const nodeMap = new Map();
      for (const c of target.cards) nodeMap.set(c.id, c);
      const edges = new Map();
      for (const c of target.cards) edges.set(c.id, c.refs.filter((r) => existingIds.has(r)));
      for (const it of validItems) {
        const refs = (it.refIds || []).filter((r) => typeof r === "string");
        edges.set(it.id, refs);
        nodeMap.set(it.id, { id: it.id, text: it.adaptedText || it.snapshotText || "", section: it.targetSection });
      }
      // 失效引用
      for (const it of validItems) {
        for (const r of it.refIds || []) {
          if (!existingIds.has(r) && !incomingIds.has(r)) {
            issues.push({
              key: issueKey("dangling", it.id, r),
              type: "dangling",
              itemId: it.id,
              severe: true,
              detail: `引用的卡片不在目标桌游中，也不会随本批次迁入`
            });
          }
        }
      }
      // 循环
      const cycle = Store.findCycle([...nodeMap.keys()], edges);
      if (cycle) {
        // 环上属于本批次迁入项的节点全部标出
        for (let i = 0; i < cycle.length - 1; i++) {
          if (incomingIds.has(cycle[i])) {
            issues.push({
              key: issueKey("cycle", cycle[i], cycle.slice(0, -1).join("-")),
              type: "cycle",
              itemId: cycle[i],
              severe: true,
              detail:
                "引用环：" +
                cycle
                  .map((id) => {
                    const c = nodeMap.get(id);
                    return (c?.text || id).slice(0, 10);
                  })
                  .join(" → ")
            });
          }
        }
      }
    }

    // 去重（同一 key 只保留一条），严重问题优先排序
    const uniq = new Map();
    for (const i of issues) if (!uniq.has(i.key)) uniq.set(i.key, i);
    return [...uniq.values()].sort((a, b) => Number(b.severe) - Number(a.severe));
  }

  function issuesFor(batch) {
    return detectIssues(batch);
  }

  function openIssues(batch) {
    const all = detectIssues(batch);
    const resolved = new Set(batch.resolvedIssueKeys || []);
    return all.filter((i) => !resolved.has(i.key));
  }

  /* ============ 批次操作 ============ */
  function createBatch(data) {
    const batch = {
      id: uid(),
      name: data.name || "未命名迁移批次",
      sourceGameId: data.sourceGameId,
      targetGameId: data.targetGameId,
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      publishedAt: null,
      rolledBackAt: null,
      items: [],
      resolvedIssueKeys: [],
      history: [] // 发布快照：{publishedAt, created:[{cardId,itemId}], overwritten:[{cardId,before}]}
    };
    Store.commit((s) => {
      s.batches.push(batch);
    });
    return batch;
  }

  function addItems(batchId, sourceCardIds) {
    const batch = batchById(batchId);
    if (!batch) return;
    const existing = new Set(batch.items.map((i) => i.sourceCardId));
    Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      const source = s.games.find((g) => g.id === b.sourceGameId);
      for (const cardId of sourceCardIds) {
        if (existing.has(cardId)) continue; // 重复添加不产生重复项
        const card = source?.cards.find((c) => c.id === cardId);
        if (!card) continue;
        b.items.push({
          id: uid(),
          sourceGameId: b.sourceGameId,
          sourceCardId: cardId,
          snapshotText: card.text,        // 始终保留源文原文
          adaptedText: "",                // 空表示沿用原文
          targetSection: card.section,
          applicablePlayers: clampPlayers(s.games.find((g) => g.id === b.targetGameId), null),
          refIds: [],
          action: "create"
        });
      }
      b.updatedAt = new Date().toISOString();
    });
  }

  function clampPlayers(game, value) {
    if (!game) return value ?? 2;
    const p = Number(value);
    if (!Number.isInteger(p)) return game.minPlayers;
    return Math.min(game.maxPlayers, Math.max(game.minPlayers, p));
  }

  function updateBatchMeta(batchId, patch) {
    Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      if (!b || b.status !== "draft") return false;
      if (patch.name !== undefined) b.name = String(patch.name).slice(0, 80) || b.name;
      if (patch.targetGameId !== undefined) {
        b.targetGameId = patch.targetGameId;
        const game = s.games.find((g) => g.id === patch.targetGameId);
        for (const it of b.items) it.applicablePlayers = clampPlayers(game, it.applicablePlayers);
      }
      if (patch.sourceGameId !== undefined) {
        b.sourceGameId = patch.sourceGameId;
        b.items = []; // 换了源桌游，旧选项失效（草稿期允许）
        b.resolvedIssueKeys = [];
      }
      b.updatedAt = new Date().toISOString();
    });
  }

  function updateItem(batchId, itemId, patch) {
    Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      if (!b || b.status !== "draft") return false;
      const it = b.items.find((x) => x.id === itemId);
      if (!it) return false;
      if (patch.action !== undefined && ACTIONS.includes(patch.action)) it.action = patch.action;
      if (patch.targetSection !== undefined && S.includes(patch.targetSection)) it.targetSection = patch.targetSection;
      if (patch.applicablePlayers !== undefined) {
        const p = Number(patch.applicablePlayers);
        // 不做静默钳制：越界值保留，由问题检测标为冲突
        if (Number.isInteger(p)) it.applicablePlayers = p;
      }
      if (patch.adaptedText !== undefined) it.adaptedText = patch.adaptedText;
      if (patch.refIds !== undefined) it.refIds = patch.refIds.filter((r) => typeof r === "string");
      if (patch.removeRef !== undefined) it.refIds = it.refIds.filter((r) => r !== patch.removeRef);
      // 任何修改后，与该 item 相关的已解决标记需要重新评估 -> 清空相关解决状态
      b.resolvedIssueKeys = (b.resolvedIssueKeys || []).filter((k) => !k.endsWith(":" + itemId) && !k.includes(":" + itemId + ":"));
    });
  }

  function removeItem(batchId, itemId) {
    Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      if (!b || b.status !== "draft") return false;
      b.items = b.items.filter((x) => x.id !== itemId);
      b.resolvedIssueKeys = (b.resolvedIssueKeys || []).filter((k) => !k.includes(itemId));
    });
  }

  function resolveIssue(batchId, issueKey) {
    Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      if (!b || b.status !== "draft") return false;
      if (!b.resolvedIssueKeys) b.resolvedIssueKeys = [];
      if (!b.resolvedIssueKeys.includes(issueKey)) b.resolvedIssueKeys.push(issueKey);
    });
  }

  function deleteBatch(batchId) {
    return Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      if (!b) return;
      if (b.status === "published") throw new Error("已发布批次不能直接删除，请先回滚");
      s.batches = s.batches.filter((x) => x.id !== batchId);
    });
  }

  /* ============ 发布 ============ */
  function itemFinalText(it) {
    return (it.adaptedText && it.adaptedText.trim()) || it.snapshotText || sourceCardText(it.sourceGameId, it.sourceCardId) || "";
  }

  function canPublish(batch) {
    const remain = openIssues(batch);
    const severe = remain.filter((i) => i.severe);
    return {
      ok: remain.length === 0,
      issues: remain,
      severe
    };
  }

  function publishBatch(batchId) {
    const batch = batchById(batchId);
    if (!batch) return { ok: false, errors: ["批次不存在"] };
    if (batch.status === "published") return { ok: true, duplicated: true, errors: [] }; // 幂等：重复提交不重复迁卡
    if (batch.status === "rolled-back") {
      // 允许重新发布，走正常流程
    }
    const check = canPublish(batch);
    if (!check.ok) {
      return { ok: false, errors: check.issues.map((i) => ISSUE_META[i.type].label + "：" + (i.detail || "")) };
    }

    let result = { ok: true };
    const ok = Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      const target = s.games.find((g) => g.id === b.targetGameId);
      if (!target) throw new Error("目标桌游不存在");

      const created = [];
      const overwritten = [];
      const newIdByItem = new Map();

      // 第一遍：create / adopt，建立 item -> 新卡 id 映射（用于引用）
      for (const it of b.items) {
        const finalText = itemFinalText(it);
        if (it.action === "skip") continue;
        if (it.action === "adopt") {
          // 沿用现有卡：通过重复检测找到现有卡
          const k = it.targetSection + "|" + norm(finalText);
          const existing = target.cards.find((c) => c.section + "|" + norm(c.text) === k);
          if (!existing) throw new Error("“沿用现有卡”的目标卡已不存在，整批发布已取消");
          newIdByItem.set(it.id, existing.id);
          continue;
        }
        if (it.action === "overwrite") {
          // overwrite 必须显式指定目标卡（data-dup-card），保存在 it.overwriteCardId
          const card = target.cards.find((c) => c.id === it.overwriteCardId);
          if (!card) throw new Error("待覆盖的卡已不存在");
          overwritten.push({ cardId: card.id, before: structuredClone(card) });
          card.text = finalText;
          card.section = it.targetSection;
          newIdByItem.set(it.id, card.id);
          continue;
        }
        // create：防静默重复（幂等键：归一化文本+分区）
        const k = it.targetSection + "|" + norm(finalText);
        const dup = target.cards.find((c) => c.section + "|" + norm(c.text) === k);
        if (dup) {
          newIdByItem.set(it.id, dup.id); // 已存在则复用，不新建
          continue;
        }
        const card = Store.makeCard(finalText, it.targetSection, {
          sourceBatchId: b.id,
          applicablePlayers: it.applicablePlayers
        });
        target.cards.push(card);
        created.push({ cardId: card.id, itemId: it.id });
        newIdByItem.set(it.id, card.id);
      }

      // 第二遍：写入引用（仅对新建/覆盖卡；沿用的现有卡保持自身引用不变）
      for (const it of b.items) {
        if (it.action === "skip" || it.action === "adopt") continue;
        const targetCardId = newIdByItem.get(it.id);
        if (!targetCardId) continue;
        const card = target.cards.find((c) => c.id === targetCardId);
        if (!card) continue;
        const refs = [];
        for (const r of it.refIds || []) {
          const mapped = newIdByItem.get(r) || (target.cards.some((c) => c.id === r) ? r : null);
          if (mapped && !refs.includes(mapped) && mapped !== card.id) refs.push(mapped);
        }
        card.refs = refs;
      }

      // 最终防环校验（真实数据上）
      const edges = new Map(target.cards.map((c) => [c.id, c.refs]));
      if (Store.findCycle(target.cards.map((c) => c.id), edges)) {
        throw new Error("发布后检测到循环引用，已取消整批发布");
      }

      b.status = "published";
      b.publishedAt = new Date().toISOString();
      b.rolledBackAt = null;
      b.updatedAt = b.publishedAt;
      b.resolvedIssueKeys = detectIssues(b).map((i) => i.key);
      b.history.push({ publishedAt: b.publishedAt, created, overwritten });
      result = { ok: true, created: created.length, overwritten: overwritten.length };
    });
    return ok ? result : { ok: false, errors: ["发布失败，数据未改动"] };
  }

  /* ============ 回滚 ============ */
  function rollbackBatch(batchId) {
    const batch = batchById(batchId);
    if (!batch) return { ok: false, errors: ["批次不存在"] };
    if (batch.status === "rolled-back") return { ok: true, duplicated: true, errors: [] }; // 幂等
    if (batch.status !== "published") return { ok: false, errors: ["只有已发布批次可以回滚"] };

    let result = { ok: true };
    const ok = Store.commit((s) => {
      const b = s.batches.find((x) => x.id === batchId);
      const target = s.games.find((g) => g.id === b.targetGameId);
      if (!target) throw new Error("目标桌游不存在");
      const snap = b.history[b.history.length - 1];
      if (!snap) throw new Error("缺少发布快照，无法回滚");

      // 恢复被覆盖的卡（原文）
      for (const ow of snap.overwritten) {
        const card = target.cards.find((c) => c.id === ow.cardId);
        if (card) Object.assign(card, structuredClone(ow.before));
      }
      // 删除本批次新建的卡；其它卡对这些卡的引用一并清除
      const createdIds = new Set(snap.created.map((c) => c.cardId));
      target.cards = target.cards.filter((c) => !createdIds.has(c.id));
      for (const c of target.cards) c.refs = c.refs.filter((r) => !createdIds.has(r));

      b.status = "rolled-back";
      b.rolledBackAt = new Date().toISOString();
      b.updatedAt = b.rolledBackAt;
      b.resolvedIssueKeys = [];
      result = { ok: true, removed: createdIds.size, restored: snap.overwritten.length };
    });
    return ok ? result : { ok: false, errors: ["回滚失败，数据未改动"] };
  }

  /* ============ 导入 / 导出 ============ */
  function exportData() {
    const payload = {
      format: "zfl18-rule-cards",
      exportedAt: new Date().toISOString(),
      data: structuredClone(Store.state)
    };
    delete payload.data.rev;
    return JSON.stringify(payload, null, 2);
  }

  function validateImport(json) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { ok: false, errors: ["不是合法 JSON：" + e.message] };
    }
    const data0 = parsed && parsed.format === "zfl18-rule-cards" ? parsed.data : parsed;
    if (!data0 || typeof data0 !== "object" || !Array.isArray(data0.games)) {
      return { ok: false, errors: ["缺少 games 数组（需要卡片库导出文件）"] };
    }
    // 兼容旧版字符串数组格式：先升级再校验
    const data = data0.games.some((g) => g && !Array.isArray(g.cards))
      ? Store.ingest(data0)
      : data0;
    const errors = [];
    const push = (path, msg) => errors.push(`${path}: ${msg}`);

    const cardIds = new Set();
    const gameIds = new Set();
    if (data.batches && !Array.isArray(data.batches)) push("batches", "必须是数组");

    for (let gi = 0; gi < data.games.length; gi++) {
      const g = data.games[gi];
      const gp = `games[${gi}]`;
      if (!g || typeof g !== "object") { push(gp, "不是对象"); continue; }
      if (!g.id) push(gp + ".id", "缺少 id");
      else if (gameIds.has(g.id)) push(gp + ".id", "桌游 id 重复");
      else gameIds.add(g.id);
      if (!g.name || !String(g.name).trim()) push(gp + ".name", "缺少名称");
      // 人数越界
      const mn = Number(g.minPlayers), mx = Number(g.maxPlayers);
      if (!Number.isInteger(mn) || mn < 1 || mn > 12) push(gp + ".minPlayers", `人数越界（${g.minPlayers}），应为 1-12`);
      if (!Number.isInteger(mx) || mx < 1 || mx > 12) push(gp + ".maxPlayers", `人数越界（${g.maxPlayers}），应为 1-12`);
      if (Number.isInteger(mn) && Number.isInteger(mx) && mn > mx) push(gp, `最少人数 ${mn} 大于最多人数 ${mx}`);
      if (!Array.isArray(g.cards)) { push(gp + ".cards", "必须是数组"); continue; }

      const localIds = new Set();
      for (let ci = 0; ci < g.cards.length; ci++) {
        const c = g.cards[ci];
        const cp = `${gp}.cards[${ci}]`;
        if (!c || typeof c !== "object") { push(cp, "不是对象"); continue; }
        if (!c.id) push(cp + ".id", "缺少 id");
        else {
          if (localIds.has(c.id)) push(cp + ".id", "同一桌游内卡片 id 重复");
          if (cardIds.has(c.id)) push(cp + ".id", "卡片 id 跨桌游重复");
          localIds.add(c.id); cardIds.add(c.id);
        }
        if (typeof c.text !== "string" || !c.text.trim()) push(cp + ".text", "缺少卡片原文");
        if (!S.includes(c.section)) push(cp + ".section", `非法分区「${c.section}」`);
        if (c.refs !== undefined && !Array.isArray(c.refs)) push(cp + ".refs", "必须是数组");
      }
      // 失效引用 + 环
      for (let ci = 0; ci < g.cards.length; ci++) {
        const c = g.cards[ci];
        if (!c || !Array.isArray(c.refs)) continue;
        for (const r of c.refs) {
          if (r === c.id) push(`${gp}.cards[${ci}].refs`, "卡片引用了自己");
          else if (!localIds.has(r)) push(`${gp}.cards[${ci}].refs`, `失效引用「${r}」（目标卡不存在）`);
        }
      }
      const edges = new Map(g.cards.map((c) => [c.id, (c.refs || []).filter((r) => localIds.has(r))]));
      const cyc = Store.findCycle(g.cards.map((c) => c.id), edges);
      if (cyc) push(`${gp}.cards`, "存在循环引用：" + cyc.map((x) => x.slice(0, 8)).join(" → "));

      // 重复卡（同分区同归一化文本）
      const seen = new Set();
      for (const c of g.cards) {
        const k = c.section + "|" + norm(c.text);
        if (seen.has(k)) push(`${gp}.cards`, `重复卡：「${String(c.text).slice(0, 20)}」在同一分区重复`);
        seen.add(k);
      }
    }

    // 批次校验（逐项严格核对：人数类型、源卡归属、迁移项引用，任一错误整批拒绝）
    const gameById = new Map(data.games.map((g) => [g.id, g]));
    for (let bi = 0; bi < (data.batches || []).length; bi++) {
      const b = data.batches[bi];
      const bp = `batches[${bi}]`;
      if (!b || typeof b !== "object") { push(bp, "不是对象"); continue; }
      if (!b.id) push(bp + ".id", "缺少 id");
      if (!BATCH_STATUSES.includes(b.status)) push(bp + ".status", `非法状态「${b.status}」`);
      const sourceGame = gameById.get(b.sourceGameId);
      const targetGame = gameById.get(b.targetGameId);
      if (!sourceGame) push(bp + ".sourceGameId", "源桌游缺失或引用失效");
      if (!targetGame) push(bp + ".targetGameId", "目标桌游缺失或引用失效");
      if (!Array.isArray(b.items)) { push(bp + ".items", "必须是数组"); continue; }

      const sourceCardIds = new Set((sourceGame?.cards || []).map((c) => c.id));
      const targetCardIds = new Set((targetGame?.cards || []).map((c) => c.id));

      if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim())) push(bp + ".name", "名称不能为空");
      if (b.history !== undefined && !Array.isArray(b.history)) push(bp + ".history", "必须是数组");

      const itemIds = new Set();
      for (let ii = 0; ii < b.items.length; ii++) {
        const it = b.items[ii];
        const ip = `${bp}.items[${ii}]`;
        if (!it || typeof it !== "object") { push(ip, "不是对象"); continue; }
        if (!it.id) push(ip + ".id", "缺少 id");
        else if (itemIds.has(it.id)) push(ip + ".id", "迁移项 id 重复");
        else itemIds.add(it.id);

        // 原文：必须是非空字符串（逐项处理时要保留原文）
        if (typeof it.snapshotText !== "string" || !it.snapshotText.trim()) {
          push(ip + ".snapshotText", "缺少迁移原文（snapshotText 必须是非空字符串）");
        }
        if (it.adaptedText !== undefined && typeof it.adaptedText !== "string") {
          push(ip + ".adaptedText", "迁移文本必须是字符串");
        }

        // 源卡归属：sourceCardId 必须真实存在于源桌游
        if (typeof it.sourceCardId !== "string" || !it.sourceCardId) {
          push(ip + ".sourceCardId", "缺少源卡 id");
        } else if (sourceGame && !sourceCardIds.has(it.sourceCardId)) {
          push(ip + ".sourceCardId", `源卡「${it.sourceCardId}」不属于源桌游或已失效`);
        }

        if (it.action !== undefined && !ACTIONS.includes(it.action)) {
          push(ip + ".action", `非法动作「${it.action}」`);
        }
        if (!S.includes(it.targetSection)) {
          push(ip + ".targetSection", `非法或缺失分区「${it.targetSection}」`);
        }

        // 适用人数：必须是数字类型的整数（写成文字如 "四人" 直接拒绝）且落在目标桌游范围内
        if (typeof it.applicablePlayers !== "number" || !Number.isInteger(it.applicablePlayers)) {
          push(ip + ".applicablePlayers", `人数必须是整数（收到「${it.applicablePlayers}」）`);
        } else if (targetGame &&
          (it.applicablePlayers < Number(targetGame.minPlayers) ||
            it.applicablePlayers > Number(targetGame.maxPlayers))) {
          push(
            ip + ".applicablePlayers",
            `人数 ${it.applicablePlayers} 超出目标桌游 ${targetGame.minPlayers}-${targetGame.maxPlayers} 人范围`
          );
        }

        if (it.refIds !== undefined && !Array.isArray(it.refIds)) {
          push(ip + ".refIds", "引用必须是数组");
        } else if (Array.isArray(it.refIds) && !it.refIds.every((r) => typeof r === "string")) {
          push(ip + ".refIds", "引用 id 必须全部是字符串");
        }

        // 覆盖动作必须指向目标桌游中真实存在的卡
        if (it.action === "overwrite") {
          if (!it.overwriteCardId || !targetCardIds.has(it.overwriteCardId)) {
            push(ip + ".overwriteCardId", "覆盖动作缺少有效的目标卡 id");
          }
        }
      }

      // 迁移项引用：每条 ref 必须能解析为「目标桌游现有卡」或「同批次另一迁移项」，且不能自引/成环
      const edges = new Map();
      for (const c of targetGame?.cards || []) {
        edges.set(c.id, (c.refs || []).filter((r) => targetCardIds.has(r)));
      }
      for (const it of b.items) {
        if (!it || typeof it !== "object") continue;
        const refs = Array.isArray(it.refIds) ? it.refIds : [];
        const resolved = [];
        for (const r of refs) {
          if (typeof r !== "string") continue; // 已在上面报错
          if (r === it.id) {
            push(`${bp}.items[${b.items.indexOf(it)}].refIds`, "迁移项不能引用自己");
            continue;
          }
          if (targetCardIds.has(r) || itemIds.has(r)) resolved.push(r);
          else push(`${bp}.items[${b.items.indexOf(it)}].refIds`, `失效引用「${r}」（既不在目标桌游中，也不是同批次迁移项）`);
        }
        edges.set(it.id, resolved);
      }
      const cyc = Store.findCycle(
        [...targetCardIds, ...itemIds],
        edges
      );
      if (cyc) {
        push(`${bp}.items`, "迁移项引用形成循环：" + cyc.map((x) => String(x).slice(0, 8)).join(" → "));
      }
    }

    return { ok: errors.length === 0, errors, data };
  }

  function importJson(json, mode) {
    const v = validateImport(json);
    if (!v.ok) return v; // 整批失败：调用方保证不动原数据
    const incoming = migrateExternal(v.data);
    const ok = Store.commit((s) => {
      if (mode === "merge") {
        // 合并：同 id 覆盖更新，新 id 追加；批次同理。原子提交。
        const games = new Map(s.games.map((g) => [g.id, g]));
        for (const g of incoming.games) games.set(g.id, g);
        s.games = [...games.values()];
        const batches = new Map(s.batches.map((b) => [b.id, b]));
        for (const b of incoming.batches || []) batches.set(b.id, b);
        s.batches = [...batches.values()];
      } else {
        s.games = incoming.games;
        s.batches = incoming.batches || [];
        s.pendingMerges = [];
      }
      s.selectedId = s.games[0]?.id || "";
    });
    return ok ? { ok: true } : { ok: false, errors: ["写入失败，原数据未改动"] };
  }

  function migrateExternal(data) {
    return normalizeExternal(data);
  }

  function normalizeExternal(data) {
    return {
      version: 2,
      selectedId: data.games[0]?.id || "",
      games: data.games.map((g) => ({
        id: g.id,
        name: String(g.name),
        minPlayers: Number(g.minPlayers),
        maxPlayers: Number(g.maxPlayers),
        duration: Number(g.duration) || 30,
        complexity: ["轻", "中", "重"].includes(g.complexity) ? g.complexity : "中",
        lastPlayed: g.lastPlayed || "2026-01-01",
        cover: g.cover || "",
        cards: g.cards.map((c) => ({
          id: c.id,
          text: String(c.text),
          section: c.section,
          refs: Array.isArray(c.refs) ? c.refs : [],
          addedAt: c.addedAt || new Date().toISOString(),
          ...(c.applicablePlayers ? { applicablePlayers: Number(c.applicablePlayers) } : {}),
          ...(c.sourceBatchId ? { sourceBatchId: c.sourceBatchId } : {})
        }))
      })),
      batches: (data.batches || []).map(normalizeBatch),
      pendingMerges: [],
      rev: 1
    };
  }

  function normalizeBatch(b) {
    return {
      id: b.id,
      name: b.name || "未命名迁移批次",
      sourceGameId: b.sourceGameId || "",
      targetGameId: b.targetGameId || "",
      status: BATCH_STATUSES.includes(b.status) ? b.status : "draft",
      createdAt: b.createdAt || new Date().toISOString(),
      updatedAt: b.updatedAt || new Date().toISOString(),
      publishedAt: b.publishedAt || null,
      rolledBackAt: b.rolledBackAt || null,
      items: (b.items || []).map((it) => ({
        id: it.id,
        sourceGameId: it.sourceGameId || b.sourceGameId || "",
        sourceCardId: it.sourceCardId || "",
        snapshotText: it.snapshotText || "",
        adaptedText: it.adaptedText || "",
        targetSection: S.includes(it.targetSection) ? it.targetSection : "forgets",
        applicablePlayers: Number(it.applicablePlayers) || 2,
        refIds: Array.isArray(it.refIds) ? it.refIds : [],
        action: ACTIONS.includes(it.action) ? it.action : "create",
        ...(it.overwriteCardId ? { overwriteCardId: it.overwriteCardId } : {})
      })),
      resolvedIssueKeys: Array.isArray(b.resolvedIssueKeys) ? b.resolvedIssueKeys : [],
      history: Array.isArray(b.history) ? b.history : []
    };
  }

  /* ============ 问题元数据 ============ */
  const ISSUE_META = {
    missing: { label: "缺失", cls: "missing", desc: "源卡已被删除，原文已保留" },
    duplicate: { label: "重复", cls: "duplicate", desc: "目标已有同内容卡，或批次内重复" },
    conflict: { label: "冲突", cls: "conflict", desc: "适用人数超出目标桌游范围" },
    cycle: { label: "循环引用", cls: "cycle", desc: "引用形成环" },
    dangling: { label: "失效引用", cls: "dangling", desc: "引用了不存在的卡" }
  };

  window.Migration = {
    detectIssues,
    openIssues,
    createBatch,
    addItems,
    updateBatchMeta,
    updateItem,
    removeItem,
    resolveIssue,
    deleteBatch,
    publishBatch,
    rollbackBatch,
    exportData,
    validateImport,
    importJson,
    canPublish,
    batchById,
    itemFinalText,
    norm,
    ISSUE_META,
    STATUS_LABEL,
    ACTIONS,
    ACTION_LABEL,
    BATCH_STATUSES,
    normalizeExternal
  };
})();
