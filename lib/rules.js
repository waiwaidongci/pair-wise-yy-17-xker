// 规则层：凝结水样链的全部业务阈值、判定与状态流转，纯函数，不直接读写数据库。

const RULES = {
  headspaceLimitPct: 10,          // 顶空占瓶容积超过一成 -> 待重采
  calibrationMaxMinutes: 30,      // 校准时刻距采集超过半小时 -> 待重采
  baselineTolerancePct: 5,        // 读数偏离基准超过 5% -> 待重采
  declineLimitPct: 20,            // 沉积速率降幅超过两成 -> 复核
  emptyStatuses: ['待重采', '采样合格', '待送检', '待复核'] // 未结束样单
};

const STATUS = {
  RESAMPLE: '待重采',
  PASSED: '采样合格',
  REVIEW: '待复核',
  DONE: '已完成',
  RETURNED: '已归还'
};

function nowIso() {
  return new Date().toISOString();
}

function newId(collection) {
  return `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function stamp(action, note) {
  return { at: nowIso(), action, note: note || '' };
}

function minutesBetween(fromIso, toIso) {
  return Math.abs(new Date(toIso) - new Date(fromIso)) / 60000;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// 同一瓶号是否已有未结束样单（归还前只允许一份）。
function findOpenSample(samples, bottleNo, exceptId) {
  return samples.find(
    (s) => s.bottleNo === bottleNo && s.status !== STATUS.RETURNED && s.id !== exceptId
  );
}

// 采样质控判定：返回命中的待重采原因列表。
function qcChecks(sample, point) {
  const reasons = [];
  const headspacePct = number(sample.headspacePct);
  if (!Number.isFinite(headspacePct)) {
    reasons.push('顶空比例缺失');
  } else if (headspacePct > RULES.headspaceLimitPct) {
    reasons.push(`顶空占比 ${headspacePct}% 超过 ${RULES.headspaceLimitPct}%`);
  }
  if (sample.calibratedAt && sample.collectedAt) {
    const gap = minutesBetween(sample.calibratedAt, sample.collectedAt);
    if (gap > RULES.calibrationMaxMinutes) {
      reasons.push(`校准距采集 ${gap.toFixed(0)} 分钟，超过 ${RULES.calibrationMaxMinutes} 分钟`);
    }
  } else {
    reasons.push('校准或采集时刻缺失');
  }
  const reading = number(sample.reading);
  const baseline = number(point?.baselineReading);
  if (!Number.isFinite(reading)) {
    reasons.push('读数缺失');
  } else if (Number.isFinite(baseline) && baseline !== 0) {
    const deviationPct = Math.abs((reading - baseline) / baseline) * 100;
    if (deviationPct > RULES.baselineTolerancePct) {
      reasons.push(`读数 ${reading} 偏离基准 ${baseline} 达 ${deviationPct.toFixed(1)}%`);
    }
  }
  return reasons;
}

function roundRate(rate) {
  return Math.round(rate * 10000) / 10000;
}

// 找上一瓶同点、有沉积速率且已结束的样单，用于环比。
function previousRatedSample(samples, pointId, beforeCollectedAt, exceptId) {
  return samples
    .filter(
      (s) =>
        s.id !== exceptId &&
        s.pointId === pointId &&
        s.status === STATUS.RETURNED &&
        Number.isFinite(number(s.depositRate)) &&
        s.collectedAt &&
        new Date(s.collectedAt) < new Date(beforeCollectedAt)
    )
    .sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt))[0];
}

// 送检录入判定：换人、封条、沉积质量、速率负增长 / 降幅过两成。
function labChecks(sample, point, samples, operator) {
  const reasons = [];
  if (!operator) reasons.push('送检录入人缺失');
  if (operator && operator === sample.collector) reasons.push(`送检录入人 ${operator} 与采集人 ${sample.collector} 相同，须换人`);
  if (!sample.sealLab) reasons.push('送检封条号缺失');
  if (sample.sealField && sample.sealLab && sample.sealField !== sample.sealLab) {
    reasons.push(`封条不符：采集封条 ${sample.sealField} ≠ 送检封条 ${sample.sealLab}`);
  }
  const mass = number(sample.depositMass);
  const hours = sample.deployedAt && sample.collectedAt
    ? (new Date(sample.collectedAt) - new Date(sample.deployedAt)) / 3600000
    : NaN;
  let rate = NaN;
  if (!Number.isFinite(mass)) {
    reasons.push('沉积质量缺失或不是数字');
  } else if (mass < 0) {
    reasons.push('沉积质量为负');
  }
  if (!(hours > 0)) {
    reasons.push('布放至采集时长无效');
  } else if (Number.isFinite(mass)) {
    // 质量为负也要算出速率，负增长原因不可漏报。
    rate = roundRate(mass / hours);
  }
  if (Number.isFinite(rate) && rate <= 0) {
    reasons.push(`沉积速率 ${rate} mg/h 为负增长或零`);
  }
  let previous = null;
  if (Number.isFinite(rate) && rate > 0 && point) {
    previous = previousRatedSample(samples, sample.pointId, sample.collectedAt, sample.id);
    if (previous) {
      const priorRate = number(previous.depositRate);
      if (Number.isFinite(priorRate) && priorRate > 0) {
        const declinePct = ((priorRate - rate) / priorRate) * 100;
        if (declinePct > RULES.declineLimitPct) {
          reasons.push(`速率 ${rate} mg/h 较上瓶 ${previous.bottleNo}（${priorRate} mg/h）下降 ${declinePct.toFixed(1)}%，超过 ${RULES.declineLimitPct}%`);
        }
      }
    }
  }
  return { reasons, rate, hours, previous };
}

function conclusionFor(status, qcReasons, reviewReasons) {
  if (status === STATUS.RESAMPLE) return `待重采：${qcReasons.join('；')}`;
  if (status === STATUS.REVIEW) return `复核：${reviewReasons.join('；')}`;
  if (status === STATUS.PASSED) return '采样合格，待送检';
  if (status === STATUS.DONE) return '送检合格，待归还瓶号';
  if (status === STATUS.RETURNED) return '瓶号已归还，样单闭环';
  return '';
}

// 汇总重算：质控不合格 -> 待重采；送检不合格 -> 待复核；全部通过 -> 已完成。
function evaluateSample(sample, point, samples, operator) {
  const next = { ...sample };
  const qcReasons = qcChecks(next, point);
  if (qcReasons.length) {
    next.status = STATUS.RESAMPLE;
    next.qcReasons = qcReasons;
    next.reviewReasons = [];
    next.depositRate = null;
    next.conclusion = conclusionFor(STATUS.RESAMPLE, qcReasons, []);
    return { sample: next, qcReasons, reviewReasons: [], rate: null };
  }
  next.qcReasons = [];
  if (next.labEntered) {
    const { reasons, rate } = labChecks(next, point, samples, operator || next.labOperator);
    next.depositRate = rate;
    if (reasons.length) {
      next.status = STATUS.REVIEW;
      next.reviewReasons = reasons;
    } else {
      next.status = STATUS.DONE;
      next.reviewReasons = [];
    }
    next.conclusion = conclusionFor(next.status, [], reasons);
    return { sample: next, qcReasons: [], reviewReasons: reasons, rate };
  }
  next.status = STATUS.PASSED;
  next.reviewReasons = [];
  next.depositRate = null;
  next.conclusion = conclusionFor(STATUS.PASSED, [], []);
  return { sample: next, qcReasons: [], reviewReasons: [], rate: null };
}

// 结论失效：旧版留档，版本号递增，记录失效原因。
function archiveVersion(sample, invalidReason) {
  const nextVersion = (sample.version || 1) + 1;
  const archived = [
    ...(sample.versions || []),
    {
      version: sample.version || 1,
      status: sample.status,
      conclusion: sample.conclusion,
      depositRate: Number.isFinite(number(sample.depositRate)) ? sample.depositRate : null,
      invalidReason,
      invalidatedAt: nowIso()
    }
  ];
  return { archived, nextVersion };
}

module.exports = {
  RULES,
  STATUS,
  nowIso,
  newId,
  stamp,
  minutesBetween,
  number,
  findOpenSample,
  qcChecks,
  labChecks,
  previousRatedSample,
  evaluateSample,
  archiveVersion,
  conclusionFor
};
