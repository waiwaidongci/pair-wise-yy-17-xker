'use strict';

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const config = require('./project.config');
const rules = require('./rules/chemistry');

const app = express();
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 存储层：所有写操作经同一条 Promise 链串行化，杜绝并发下瓶号重复占用、
// 重复送检或重算交叉。规则判定一律调用 rules/chemistry.js。
// ---------------------------------------------------------------------------

let writeChain = Promise.resolve();
let dbCache = null;

async function readDb() {
  if (dbCache) return dbCache;
  const raw = await fs.readFile(DB_FILE, 'utf8');
  dbCache = JSON.parse(raw);
  if (!Array.isArray(dbCache.idempotency)) dbCache.idempotency = [];
  return dbCache;
}

async function persistDb(db) {
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2) + '\n');
  await fs.rename(tmp, DB_FILE);
  dbCache = db;
}

// 串行化一次“读改写”，返回其结果；并发请求按到达顺序排队
function withLock(task) {
  const run = writeChain.then(() => task());
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// 任务内只抛 HttpError 或返回 { status, body }，由统一出口响应一次
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(res, run) {
  run
    .then((payload) => {
      if (payload?.status === 204) return res.status(204).end();
      return res.status(payload?.status || 200).json(payload?.body ?? {});
    })
    .catch((error) => res.status(error.status || 500).json({ error: error.message }));
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function whitelistFields(body, names) {
  const out = {};
  for (const name of names) {
    if (body[name] !== undefined) out[name] = body[name];
  }
  return out;
}

// 数值字段在写入前归一
function normalizeFields(item, view) {
  for (const field of view.fields || []) {
    if (field.type === 'number' && item[field.name] !== undefined) {
      item[field.name] = rules.num(item[field.name]);
    }
  }
}

function viewOf(collection) {
  return config.views.find((view) => view.collection === collection);
}

function findSite(db, sheet) {
  return db.sites?.find((site) => site.id === sheet.siteId) || null;
}

// 同瓶号未结束样单（“归还前”占用）
function openSheetByBottle(db, bottleNo, exceptId) {
  return (db.sheets || []).find(
    (sheet) => sheet.bottleNo === bottleNo
      && rules.OPEN_STATUSES.includes(sheet.status)
      && sheet.id !== exceptId
  );
}

// 速率复核参照：同点上一份投放更早、送检判定合格（无送检异常标记）的样单；
// 复核中的异常样单不能作为基准；没有合格前例时用样点基准速率
function priorSheetFor(db, sheet) {
  const candidates = (db.sheets || [])
    .filter((entry) => entry.id !== sheet.id
      && entry.siteId === sheet.siteId
      && entry.depositMass !== undefined && entry.depositMass !== null
      && entry.deployedAt
      && new Date(entry.deployedAt) < new Date(sheet.deployedAt)
      && (!entry.labFlags || entry.labFlags.length === 0));
  candidates.sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));
  return candidates[0] || null;
}

const SNAPSHOT_KEYS = [
  'status', 'stage', 'reason', 'fieldFlags', 'labFlags', 'headspacePct',
  'calibrationAgeMin', 'deviationPct', 'exposureDays', 'depositRatePerDay',
  'rateChangePct', 'labSealMatch'
];

function snapshotConclusion(sheet) {
  const snap = {};
  for (const key of SNAPSHOT_KEYS) snap[key] = sheet[key] ?? null;
  return snap;
}

// 按规则引擎重算一张样单。invalidate=true 表示输入要素或基准已变更：
// 旧结论存档，人工复核结论随结论失效一并清掉后重新自动判定。
function recompute(db, sheet, reason, { invalidate = false } = {}) {
  const wasTerminal = sheet.status === rules.TERMINAL_STATUS;
  if (wasTerminal && !invalidate) return false;

  const site = findSite(db, sheet);
  const prior = priorSheetFor(db, sheet);
  const context = { site, priorSheet: prior };

  if (invalidate) {
    // 只有已经形成过送检/复核结论的样单才需要旧版留档；
    // 仅现场登记的样单随之重算现场标记即可。
    const hadConclusion = sheet.depositMass !== null && sheet.depositMass !== undefined
      || !!sheet.reviewVerdict
      || (sheet.versions || []).length > 0;
    if (hadConclusion) {
      const version = {
        id: `ver-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        at: new Date().toISOString(),
        reason,
        conclusion: snapshotConclusion(sheet)
      };
      sheet.versions = sheet.versions || [];
      sheet.versions.unshift(version);
      // 基准/质量/采集时刻变更 → 人工复核结论失效
      delete sheet.reviewVerdict;
      delete sheet.reviewedAt;
      sheet.history = sheet.history || [];
      sheet.history.unshift(stamp('结论失效重算', reason));
    }
  }

  const derived = rules.derivedFields(sheet, context);
  Object.assign(sheet, derived);

  // 已归还是流程终态：重算只刷新留档结论，不回翻瓶号占用状态
  if (wasTerminal) sheet.status = rules.TERMINAL_STATUS;
  return true;
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  const out = JSON.parse(JSON.stringify(db));
  delete out.idempotency;
  for (const key of Object.keys(out)) {
    if (Array.isArray(out[key])) out[key].sort(sortNewest);
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// 新增。样单有专门规则：同瓶号未结束只认首次结果；显式幂等键重复/并发沿用首次
// ---------------------------------------------------------------------------

app.post('/api/:collection', (req, res) => {
  respond(res, withLock(async () => {
    const db = await readDb();
    const { collection } = req.params;
    const view = viewOf(collection);
    if (!view || !Array.isArray(db[collection])) throw new HttpError(404, '未知数据集');

    const idemKey = req.header('Idempotency-Key') || req.body.idempotencyKey;
    if (idemKey) {
      const seen = db.idempotency.find((entry) => entry.key === idemKey);
      if (seen) {
        const first = db[seen.collection]?.find((entry) => entry.id === seen.itemId);
        if (first) return { status: 200, body: { item: first, reused: true, reason: seen.note } };
      }
    }

    const now = new Date().toISOString();
    const fields = whitelistFields(req.body, view.fields.map((field) => field.name));
    normalizeFields(fields, view);
    const item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...(view.defaults || {}),
      ...fields,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', req.body.note || '')]
    };

    if (collection === 'sheets') {
      if (!item.siteId || !db.sites.some((site) => site.id === item.siteId)) {
        throw new HttpError(400, '采样点不存在');
      }
      const occupied = openSheetByBottle(db, item.bottleNo);
      if (occupied) {
        // 重复登记或并发登记：沿用首次样单，不再新建
        const reason = `瓶号 ${item.bottleNo} 已有未结束样单（${occupied.status}），沿用首次结果`;
        if (idemKey) {
          db.idempotency.push({ key: idemKey, collection, itemId: occupied.id, note: reason, at: now });
          await persistDb(db);
        }
        return { status: 200, body: { item: occupied, reused: true, reason } };
      }
      recompute(db, item, null);
      item.history.unshift(stamp(item.status === '待重采' ? '现场判定待重采' : '现场登记', item.reason));
    }

    db[collection].push(item);
    if (idemKey) {
      db.idempotency.push({ key: idemKey, collection, itemId: item.id, at: now });
    }
    await persistDb(db);
    return { status: 201, body: { item } };
  }));
});

// ---------------------------------------------------------------------------
// 修改。样点基准、样单沉积质量/采集时刻变更 → 结论失效重算、旧版留档
// ---------------------------------------------------------------------------

app.patch('/api/:collection/:id', (req, res) => {
  respond(res, withLock(async () => {
    const db = await readDb();
    const { collection, id } = req.params;
    const view = viewOf(collection);
    if (!view || !Array.isArray(db[collection])) throw new HttpError(404, '未知数据集');
    const item = db[collection].find((entry) => entry.id === id);
    if (!item) throw new HttpError(404, '未找到记录');
    if (collection === 'sheets') {
      if (item.status === rules.TERMINAL_STATUS) {
        throw new HttpError(409, '样单已归还归档，不能直接修改；如需更正请登记新样单');
      }
      if (item.status === '待重采') {
        throw new HttpError(409, '样单已判待重采，本采样轮次结束，请登记重采新样单');
      }
    }

    const editable = view.editFields || view.fields.map((field) => field.name);
    const numericDefs = [
      ...(view.fields || []),
      ...config.actions.filter((action) => action.collection === collection).flatMap((action) => action.inputFields || [])
    ].filter((field) => field.type === 'number');
    const patch = whitelistFields(req.body, editable);
    normalizeFields(patch, { fields: numericDefs.filter((field) => editable.includes(field.name)) });
    const operator = String(req.body.operator || '').trim();
    if (!operator) throw new HttpError(400, '请填写修改人');

    if (collection === 'sheets'
      && Object.prototype.hasOwnProperty.call(patch, 'depositMass')
      && !rules.hasLab(item)) {
      throw new HttpError(409, '尚未送检，沉积质量须由送检录入人随封条一起录入');
    }

    const changedKeys = Object.keys(patch).filter((key) => String(patch[key]) !== String(item[key] ?? ''));
    if (!changedKeys.length) throw new HttpError(400, '没有字段发生变化');

    Object.assign(item, patch);
    item.updatedAt = new Date().toISOString();

    let touchedSheets = [];
    if (collection === 'sites') {
      const baselineChanged = changedKeys.some((key) => (view.baselineKeys || []).includes(key));
      if (baselineChanged) {
        touchedSheets = db.sheets.filter((sheet) => sheet.siteId === item.id);
        for (const sheet of touchedSheets) {
          recompute(db, sheet, `样点基准变更（${changedKeys.join('、')}），${operator} 修改`, { invalidate: true });
        }
      }
      item.history = item.history || [];
      item.history.unshift(stamp(`${operator} 修改档案`, `变更：${changedKeys.join('、')}`));
    } else {
      // 已送检样单的任何要素更正都使既有结论失效并留档；
      // 待送检样单只随现场要素重算标记（结论尚未产生，不留档）。
      const hadLab = rules.hasLab(item);
      const invalidate = hadLab
        || changedKeys.some((key) => (view.invalidationKeys || []).includes(key));
      recompute(db, item, invalidate ? `采集要素变更（${changedKeys.join('、')}），${operator} 修改` : null, { invalidate });
      item.history = item.history || [];
      item.history.unshift(stamp(`${operator} 修改样单`, `变更：${changedKeys.join('、')}`));
    }

    await persistDb(db);
    return { body: { item, recalculated: touchedSheets.length } };
  }));
});

app.delete('/api/:collection/:id', (req, res) => {
  respond(res, withLock(async () => {
    const db = await readDb();
    const { collection, id } = req.params;
    if (!Array.isArray(db[collection])) throw new HttpError(404, '未知数据集');
    const before = db[collection].length;
    db[collection] = db[collection].filter((entry) => entry.id !== id);
    if (db[collection].length === before) throw new HttpError(404, '未找到记录');
    await persistDb(db);
    return { status: 204 };
  }));
});

// ---------------------------------------------------------------------------
// 状态流转：送检录入 / 复核结案 / 归还瓶号
// ---------------------------------------------------------------------------

app.post('/api/action/:actionId/:id', (req, res) => {
  respond(res, withLock(async () => {
    const db = await readDb();
    const action = config.actions.find((entry) => entry.id === req.params.actionId);
    if (!action) throw new HttpError(404, '未知动作');
    const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
    if (!item) throw new HttpError(404, '未找到记录');

    // 动作级幂等：同键重复/并发提交沿用首次结果
    const idemKey = req.header('Idempotency-Key') || req.body.idempotencyKey;
    if (idemKey) {
      const seen = db.idempotency.find((entry) => entry.key === idemKey);
      if (seen) {
        const first = db[action.collection]?.find((entry) => entry.id === seen.itemId);
        if (first) return { status: 200, body: { item: first, reused: true, reason: seen.note } };
      }
    }

    if (!action.allowStatuses.includes(item.status)) {
      throw new HttpError(409, `当前状态「${item.status}」不能执行${action.label}`);
    }

    const now = new Date().toISOString();
    const inputNames = (action.inputFields || []).map((field) => field.name);
    const input = whitelistFields(req.body, inputNames);
    for (const field of action.inputFields || []) {
      if (field.required) {
        const value = input[field.name];
        if (value === undefined || value === null || String(value).trim() === '') {
          throw new HttpError(400, `请填写${field.label.replace(/（.*?）/g, '')}`);
        }
      }
      if (field.type === 'number') input[field.name] = rules.num(input[field.name]);
    }
    if (action.otherActorField && input[action.actorField]) {
      if (String(input[action.actorField]).trim() === String(item[action.otherActorField] || '').trim()) {
        throw new HttpError(409, '送检必须换人录入：录入人不能与采集人为同一人');
      }
    }

    Object.assign(item, input);
    item.updatedAt = now;
    item.history = item.history || [];

    if (action.kind === 'lab') {
      item.labAt = now;
      delete item.reviewVerdict;
      delete item.reviewedAt;
      recompute(db, item, null);
      item.history.unshift(stamp(
        `${input.labTech} 送检录入`,
        `${item.reason}${input.labNote ? `；备注：${input.labNote}` : ''}`
      ));
    } else if (action.kind === 'review') {
      item.reviewVerdict = input.reviewVerdict;
      item.reviewedAt = now;
      recompute(db, item, null);
      item.history.unshift(stamp(
        `${input.reviewer} 复核结案：${input.reviewVerdict}`,
        input.reviewNote || item.reason
      ));
    } else if (action.kind === 'return') {
      item.status = rules.TERMINAL_STATUS;
      item.returnedAt = now;
      item.history.unshift(stamp('瓶号归还归档', `瓶号 ${item.bottleNo} 可再次使用`));
    }

    if (idemKey) db.idempotency.push({ key: idemKey, collection: action.collection, itemId: item.id, at: now });
    await persistDb(db);
    return { body: { item } };
  }));
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
