// 路由层：只做参数校验与「存储 + 规则」编排；阈值与判定见 lib/rules.js。
const express = require('express');
const path = require('path');

const config = require('./project.config');
const store = require('./lib/storage');
const R = require('./lib/rules');

const app = express();
const PORT = process.env.PORT || config.port || 3900;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function fail(status, error) {
  return { status, error };
}

function iso(value) {
  return value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function touch(item) {
  item.updatedAt = R.nowIso();
  return item;
}

function log(item, action, note) {
  item.history = item.history || [];
  item.history.unshift(R.stamp(action, note));
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res, next) => {
  try {
    const db = await store.readDb();
    for (const key of Object.keys(db)) {
      if (Array.isArray(db[key])) db[key].sort(sortNewest);
    }
    res.json(db);
  } catch (error) {
    next(error);
  }
});

// ---------- 样点 ----------

app.post('/api/points', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const body = req.body || {};
    if (!body.cave || !body.zone || !body.pointCode) throw fail(400, '洞穴、分区、采样点编号必填');
    if (finite(body.baselineReading) === null) throw fail(400, '基准读数必须是数字');
    const now = R.nowIso();
    const item = {
      id: R.newId('point'),
      cave: body.cave,
      zone: body.zone,
      pointCode: body.pointCode,
      bottlePrefix: body.bottlePrefix || '',
      baselineReading: finite(body.baselineReading),
      note: body.note || '',
      createdAt: now,
      updatedAt: now,
      history: [R.stamp('创建', '凝结样点建档')]
    };
    db.points.push(item);
    await store.writeDb(db);
    res.status(201).json(item);
  }).catch(next);
});

app.patch('/api/points/:id', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const item = db.points.find((entry) => entry.id === req.params.id);
    if (!item) throw fail(404, '样点不存在');
    const body = req.body || {};
    // 基准变更必须走重算专用接口，避免静默改写结论。
    for (const key of ['cave', 'zone', 'pointCode', 'bottlePrefix', 'note']) {
      if (body[key] !== undefined) item[key] = body[key];
    }
    touch(item);
    log(item, '更新样点信息', body.reason || '');
    await store.writeDb(db);
    res.json(item);
  }).catch(next);
});

// 基准变更：关联的未结束样单全部失效重算，旧版留档。
app.patch('/api/samples/recalc-by-point/:pointId', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const point = db.points.find((entry) => entry.id === req.params.pointId);
    if (!point) throw fail(404, '样点不存在');
    const baseline = finite(req.body?.baselineReading);
    if (baseline === null) throw fail(400, '新基准读数必须是数字');
    point.baselineReading = baseline;
    touch(point);
    log(point, '基准变更', `${baseline} μS/cm；${req.body?.reason || '无'}`);

    const affected = [];
    for (const sample of db.samples.filter((s) => s.pointId === point.id && s.status !== R.STATUS.RETURNED)) {
      const before = { status: sample.status, conclusion: sample.conclusion };
      const { archived, nextVersion } = R.archiveVersion(sample, `样点基准变更为 ${baseline} μS/cm：${req.body?.reason || '旧结论失效'}`);
      sample.versions = archived;
      sample.version = nextVersion;
      const { sample: recalculated, qcReasons, reviewReasons } = R.evaluateSample(sample, point, db.samples, sample.labOperator);
      Object.assign(sample, recalculated);
      touch(sample);
      log(sample, '基准变更重算', `${before.status} → ${sample.status}；${sample.conclusion}`);
      affected.push({ id: sample.id, bottleNo: sample.bottleNo, status: sample.status, qcReasons, reviewReasons });
    }
    await store.writeDb(db);
    res.json({ point, affected });
  }).catch(next);
});

// ---------- 样单 ----------

function normalizeSampleBody(body) {
  return {
    pointId: body.pointId,
    bottleNo: String(body.bottleNo || '').trim(),
    collectedAt: iso(body.collectedAt),
    deployedAt: iso(body.deployedAt),
    collector: String(body.collector || '').trim(),
    reading: finite(body.reading),
    bottleVolume: finite(body.bottleVolume),
    headspaceVolume: finite(body.headspaceVolume),
    headspacePct: finite(body.headspacePct),
    calibratedAt: iso(body.calibratedAt),
    sealField: String(body.sealField || '').trim(),
    fieldNote: body.fieldNote || ''
  };
}

function validateSampleFields(data) {
  if (!data.bottleNo) return '瓶号必填';
  if (!data.collector) return '采集人必填';
  if (!data.collectedAt || !data.deployedAt || !data.calibratedAt) return '采集、布放、校准时刻必填且须为有效时间';
  if (new Date(data.deployedAt) >= new Date(data.collectedAt)) return '布放时刻必须早于采集时刻';
  if (data.reading === null) return '读数必须是数字';
  if (data.headspacePct === null) return '顶空占比必须是数字';
  return null;
}

// 登记：同一瓶号归还前只允许一份未结束样单；重复 / 并发沿用首次结果。
app.post('/api/samples', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const data = normalizeSampleBody(req.body || {});
    const error = validateSampleFields(data);
    if (error) throw fail(400, error);
    const point = db.points.find((entry) => entry.id === data.pointId);
    if (!point) throw fail(400, '请选择有效的采样点');

    const existing = R.findOpenSample(db.samples, data.bottleNo);
    if (existing) {
      return res.json({ reused: true, item: existing, note: `瓶号 ${data.bottleNo} 已有未结束样单，沿用首次登记结果` });
    }

    const now = R.nowIso();
    let item = {
      id: R.newId('sample'),
      ...data,
      labEntered: false,
      returned: false,
      depositMass: null,
      depositRate: null,
      labOperator: '',
      sealLab: '',
      labNote: '',
      reviewer: '',
      reviewNote: '',
      version: 1,
      versions: [],
      qcReasons: [],
      reviewReasons: [],
      createdAt: now,
      updatedAt: now,
      history: []
    };
    const evaluated = R.evaluateSample(item, point, db.samples);
    item = { ...item, ...evaluated.sample };
    log(item, '创建', `登记瓶号 ${item.bottleNo}`);
    log(item, '采样质控', item.conclusion);
    db.samples.push(item);
    await store.writeDb(db);
    res.status(201).json({ reused: false, item });
  }).catch(next);
});

function getSample(db, id) {
  const sample = db.samples.find((entry) => entry.id === id);
  if (!sample) throw fail(404, '样单不存在');
  const point = db.points.find((entry) => entry.id === sample.pointId);
  return { sample, point };
}

function guardStatus(sample, allowed) {
  if (!allowed.includes(sample.status)) {
    throw fail(409, `当前状态「${sample.status}」不能执行该操作`);
  }
}

// 重采样登记：沿用原瓶号，旧结论归档，质控重新判定。
app.post('/api/samples/resample/:id', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const { sample, point } = getSample(db, req.params.id);
    guardStatus(sample, [R.STATUS.RESAMPLE]);
    const data = normalizeSampleBody(req.body || {});
    const error = validateSampleFields(data);
    if (error) throw fail(400, error);
    if (data.bottleNo && data.bottleNo !== sample.bottleNo) throw fail(409, '重采样必须沿用原瓶号');

    const { archived, nextVersion } = R.archiveVersion(sample, '重采样登记：原采样结论失效');
    Object.assign(sample, data, {
      labEntered: false,
      labOperator: '',
      sealLab: '',
      labNote: '',
      depositMass: null,
      depositRate: null,
      reviewer: '',
      reviewNote: '',
      versions: archived,
      version: nextVersion
    });
    const { sample: recalculated } = R.evaluateSample(sample, point, db.samples);
    Object.assign(sample, recalculated);
    touch(sample);
    log(sample, '重采样登记', `采集人 ${sample.collector}；${sample.conclusion}`);
    await store.writeDb(db);
    res.json(sample);
  }).catch(next);
});

// 送检录入：换人 + 封条 + 沉积质量；速率异常进复核。
app.post('/api/samples/lab/:id', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const { sample, point } = getSample(db, req.params.id);
    guardStatus(sample, [R.STATUS.PASSED]);
    const body = req.body || {};
    const operator = String(body.labOperator || '').trim();
    const sealLab = String(body.sealLab || '').trim();
    const mass = finite(body.depositMass);
    if (!operator) throw fail(400, '送检录入人必填');
    if (operator === sample.collector) throw fail(409, `送检录入人 ${operator} 与采集人相同，须换人录入`);
    if (!sealLab) throw fail(400, '送检封条号必填');
    if (mass === null) throw fail(400, '沉积质量必须是数字');

    Object.assign(sample, {
      labEntered: true,
      labOperator: operator,
      sealLab,
      depositMass: mass,
      labNote: body.labNote || ''
    });
    const { sample: recalculated, reviewReasons } = R.evaluateSample(sample, point, db.samples, operator);
    Object.assign(sample, recalculated);
    touch(sample);
    log(sample, '送检录入', `${operator} 录入封条 ${sealLab}、质量 ${mass} mg；${sample.conclusion}`);
    if (reviewReasons.length) log(sample, '转复核', reviewReasons.join('；'));
    await store.writeDb(db);
    res.json(sample);
  }).catch(next);
});

// 改采集/布放时刻或沉积质量：结论失效重算，旧版留档。
app.patch('/api/samples/:id', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const { sample, point } = getSample(db, req.params.id);
    if (sample.status === R.STATUS.RETURNED) throw fail(409, '已归还样单不可变更');
    const body = req.body || {};
    const reason = String(body.reason || '').trim();

    const changes = [];
    if (body.collectedAt !== undefined || body.deployedAt !== undefined) {
      const collectedAt = iso(body.collectedAt ?? sample.collectedAt);
      const deployedAt = iso(body.deployedAt ?? sample.deployedAt);
      if (!collectedAt || !deployedAt) throw fail(400, '采集与布放时刻须为有效时间');
      if (new Date(deployedAt) >= new Date(collectedAt)) throw fail(400, '布放时刻必须早于采集时刻');
      sample.collectedAt = collectedAt;
      sample.deployedAt = deployedAt;
      changes.push('采集/布放时刻');
    }
    if (body.depositMass !== undefined) {
      if (!sample.labEntered) throw fail(409, '尚未送检录入，不能修改沉积质量');
      const mass = finite(body.depositMass);
      if (mass === null) throw fail(400, '沉积质量必须是数字');
      sample.depositMass = mass;
      changes.push('沉积质量');
    }
    if (body.labOperator !== undefined) {
      const operator = String(body.labOperator || '').trim();
      if (!operator) throw fail(400, '送检录入人必填');
      if (operator === sample.collector) throw fail(409, '送检录入人不得与采集人相同');
      sample.labOperator = operator;
    }
    if (!changes.length) throw fail(400, '没有可变更的字段（采集时刻 / 布放时刻 / 沉积质量）');

    const { archived, nextVersion } = R.archiveVersion(sample, `${changes.join('、')}变更${reason ? `：${reason}` : '：旧结论失效'}`);
    sample.versions = archived;
    sample.version = nextVersion;
    const beforeStatus = sample.status;
    const { sample: recalculated } = R.evaluateSample(sample, point, db.samples, sample.labOperator);
    Object.assign(sample, recalculated);
    touch(sample);
    log(sample, '变更重算', `${changes.join('、')}；${beforeStatus} → ${sample.status}`);
    await store.writeDb(db);
    res.json(sample);
  }).catch(next);
});

// 复核通过：进入待归还。
app.post('/api/samples/review-pass/:id', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const { sample } = getSample(db, req.params.id);
    guardStatus(sample, [R.STATUS.REVIEW]);
    const reviewer = String(req.body?.reviewer || '').trim();
    const reviewNote = String(req.body?.reviewNote || '').trim();
    if (!reviewer || !reviewNote) throw fail(400, '复核人与复核意见必填');
    sample.reviewer = reviewer;
    sample.reviewNote = reviewNote;
    sample.status = R.STATUS.DONE;
    sample.conclusion = `复核通过（${reviewer}）：${reviewNote}`;
    touch(sample);
    log(sample, '复核通过', `${reviewer}：${reviewNote}`);
    await store.writeDb(db);
    res.json(sample);
  }).catch(next);
});

// 归还瓶号：样单结束，瓶号可重新流转。
app.post('/api/samples/return/:id', (req, res, next) => {
  store.withLock(async () => {
    const db = await store.readDb();
    const { sample } = getSample(db, req.params.id);
    guardStatus(sample, [R.STATUS.DONE]);
    const returner = String(req.body?.returner || '').trim();
    if (!returner) throw fail(400, '归还经手人必填');
    sample.status = R.STATUS.RETURNED;
    sample.returned = true;
    sample.returner = returner;
    sample.returnedAt = R.nowIso();
    sample.conclusion = R.conclusionFor(R.STATUS.RETURNED, [], []);
    touch(sample);
    log(sample, '归还瓶号', `经手人 ${returner}`);
    await store.writeDb(db);
    res.json(sample);
  }).catch(next);
});

// 统一错误返回：业务错误带 4xx 状态，其余 500。
app.use((error, req, res, next) => {
  if (error && error.status) return res.status(error.status).json({ error: error.error });
  console.error(error);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
