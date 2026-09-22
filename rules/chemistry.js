'use strict';

// 凝结水样链与沉积速率复核 —— 规则引擎（纯函数，不做任何 I/O）
// 所有业务阈值与判定只在此处定义，存储层与页面层不得自行判断。

const RULES = Object.freeze({
  headspaceLimitPct: 10,      // 顶空超过瓶容一成 → 待重采
  calibrationMaxMinutes: 30,  // 仪器校准超过半小时 → 待重采
  declineLimitPct: 20,        // 沉积速率降幅超过两成 → 复核
  defaultTolerancePct: 10     // 样点未配置允许偏离时的默认读数容差
});

// 未结束样单占用瓶号；已结束（待重采 / 已归还）后瓶号可再次使用
const OPEN_STATUSES = Object.freeze(['待送检', '复核中', '合格']);
const TERMINAL_STATUS = '已归还';

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
  const n = num(value);
  if (n === null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

// 现场环节指标：顶空、校准时长、读数偏离基准
function fieldMetrics(sheet, site) {
  const headspacePct = num(sheet.headspacePct);
  const calibrationAgeMin = num(sheet.calibrationAgeMin);
  const reading = num(sheet.readingTemp);
  const baseline = num(site?.baselineReading);
  const tolerance = num(site?.readingTolerancePct);
  const allowed = tolerance === null ? RULES.defaultTolerancePct : tolerance;

  let deviationPct = null;
  if (reading !== null && baseline !== null && baseline !== 0) {
    deviationPct = round((Math.abs(reading - baseline) / Math.abs(baseline)) * 100, 2);
  }

  const flags = [];
  if (headspacePct !== null && headspacePct > RULES.headspaceLimitPct) flags.push('顶空超一成');
  if (calibrationAgeMin !== null && calibrationAgeMin > RULES.calibrationMaxMinutes) flags.push('校准超半小时');
  if (deviationPct !== null && deviationPct > allowed) flags.push('读数偏离基准');

  return { headspacePct, calibrationAgeMin, deviationPct, tolerancePct: allowed, flags };
}

function hasLab(sheet) {
  return sheet.labAt || num(sheet.depositMass) !== null;
}

function exposureDays(sheet) {
  const start = new Date(sheet.deployedAt).getTime();
  const end = new Date(sheet.collectAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return round((end - start) / 86400000, 4);
}

// 送检环节指标：封条、沉积速率（质量 / 暴露天数）、相对上一份样单（无则基准速率）的降幅
function labMetrics(sheet, site, priorSheet) {
  const days = exposureDays(sheet);
  const mass = num(sheet.depositMass);
  const ratePerDay = mass !== null && days !== null ? round(mass / days, 6) : null;

  let referenceRate = null;
  if (priorSheet) {
    const priorMass = num(priorSheet.depositMass);
    const priorDays = exposureDays(priorSheet);
    if (priorMass !== null && priorDays !== null) referenceRate = priorMass / priorDays;
  } else {
    referenceRate = num(site?.baselineRatePerDay);
  }

  let rateChangePct = null;
  if (ratePerDay !== null && referenceRate !== null && referenceRate > 0) {
    rateChangePct = round(((ratePerDay - referenceRate) / referenceRate) * 100, 2);
  }

  const sealMatch = sheet.labSeal === undefined || sheet.labSeal === null || sheet.labSeal === ''
    ? null
    : String(sheet.labSeal).trim() === String(sheet.fieldSeal || '').trim();

  const flags = [];
  if (sealMatch === false) flags.push('封条不符');
  if (ratePerDay !== null && ratePerDay < 0) flags.push('速率负增长');
  if (rateChangePct !== null && rateChangePct < -RULES.declineLimitPct) flags.push('降幅过两成');

  return { exposureDays: days, ratePerDay, rateChangePct, referenceRate: referenceRate === null ? null : round(referenceRate, 6), sealMatch, flags };
}

// 汇总一次判定。调用方负责在“结论失效”时先清空 reviewVerdict。
// 返回建议状态；已归还为终态，由存储层保持，不在此翻转。
function evaluate(sheet, context = {}) {
  const { site = null, priorSheet = null } = context;
  const field = fieldMetrics(sheet, site);
  const lab = hasLab(sheet) ? labMetrics(sheet, site, priorSheet) : null;

  let status;
  let stage;
  if (sheet.reviewVerdict) {
    status = sheet.reviewVerdict === '合格' ? '合格' : '待重采';
    stage = '复核结案';
  } else if (lab) {
    status = lab.flags.length ? '复核中' : '合格';
    stage = '送检判定';
  } else {
    status = field.flags.length ? '待重采' : '待送检';
    stage = '现场判定';
  }

  const reasons = [];
  if (lab) reasons.push(...lab.flags.map((flag) => `送检：${flag}`));
  if (field.flags.length) reasons.push(...field.flags.map((flag) => `现场：${flag}`));
  if (!reasons.length) {
    reasons.push(lab ? '送检指标合格' : '现场指标合格');
  }

  return {
    stage,
    status,
    reason: reasons.join('；'),
    reasons,
    field,
    lab
  };
}

// 供存储层落库的派生字段快照
function derivedFields(sheet, context) {
  const ev = evaluate(sheet, context);
  return {
    status: ev.status,
    reason: ev.reason,
    stage: ev.stage,
    fieldFlags: ev.field.flags,
    labFlags: ev.lab ? ev.lab.flags : [],
    headspacePct: ev.field.headspacePct,
    calibrationAgeMin: ev.field.calibrationAgeMin,
    deviationPct: ev.field.deviationPct,
    exposureDays: ev.lab ? ev.lab.exposureDays : exposureDays(sheet),
    depositRatePerDay: ev.lab ? ev.lab.ratePerDay : null,
    rateChangePct: ev.lab ? ev.lab.rateChangePct : null,
    labSealMatch: ev.lab ? ev.lab.sealMatch : null
  };
}

module.exports = {
  RULES,
  OPEN_STATUSES,
  TERMINAL_STATUS,
  num,
  round,
  fieldMetrics,
  labMetrics,
  evaluate,
  derivedFields,
  exposureDays,
  hasLab
};
