module.exports = {
  port: 3912,
  title: '凝结水样链与沉积速率复核台',
  lede: '按瓶号串联凝结水采样链：一瓶未归还只允许一份未结束样单；现场自动判定待重采，送检换人录入封条与沉积质量，异常速率转复核，基准或采集要素变更时结论自动失效重算并留存旧版。',
  tones: {
    '待送检': 'ok',
    '合格': 'ok',
    '复核中': 'warn',
    '待重采': 'bad',
    '已归还': 'ok',
    '顶空超一成': 'bad',
    '校准超半小时': 'bad',
    '读数偏离基准': 'bad',
    '封条不符': 'warn',
    '速率负增长': 'bad',
    '降幅过两成': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    sheets: { label: '凝结水样单' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '未结束样单', collection: 'sheets', filter: { field: 'status', values: ['待送检', '复核中', '合格'] } },
    { label: '待重采', collection: 'sheets', filter: { field: 'status', value: '待重采' } },
    { label: '复核中', collection: 'sheets', filter: { field: 'status', value: '复核中' } },
    { label: '已归还瓶号', collection: 'sheets', filter: { field: 'status', value: '已归还' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '复核台',
      type: 'dashboard',
      focusTitle: '待处理：复核中与待重采',
      focus: { collection: 'sheets', field: 'status', values: ['复核中', '待重采'], limit: 10 }
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增采样点',
      listTitle: '样点列表',
      submitLabel: '建立档案',
      searchPlaceholder: '搜索洞穴、分区、样点、监测面',
      searchFields: ['cave', 'zone', 'pointCode', 'monitorFace'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      // 基准字段变更会让该样点全部已结样单结论失效并重算、旧版留档
      baselineKeys: ['baselineReading', 'baselineRatePerDay', 'readingTolerancePct'],
      editFields: [
        'monitorFace', 'cave', 'zone', 'pointCode', 'route', 'sensitivity', 'protectedStatus',
        'baselineReading', 'baselineRatePerDay', 'readingTolerancePct', 'note'
      ],
      detailFields: [
        { label: '基准读数(℃)', name: 'baselineReading' },
        { label: '基准速率(g/日)', name: 'baselineRatePerDay' },
        { label: '读数容差(%)', name: 'readingTolerancePct' },
        { label: '监测面', name: 'monitorFace' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '监测面', name: 'monitorFace', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准读数(℃)', name: 'baselineReading', type: 'number', step: '0.01', required: true },
        { label: '基准沉积速率(g/日)', name: 'baselineRatePerDay', type: 'number', step: '0.0001', required: true },
        { label: '读数允许偏离(%)', name: 'readingTolerancePct', type: 'number', step: '0.1', default: 10 },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'sheets',
      label: '凝结水样链',
      collection: 'sheets',
      formTitle: '登记凝结水样单',
      listTitle: '样单列表',
      submitLabel: '登记样单',
      searchPlaceholder: '搜索瓶号、采集人、样点、封条',
      searchFields: ['bottleNo', 'collector', 'fieldSeal', 'labTech'],
      statusField: 'status',
      statusOptions: ['待送检', '复核中', '合格', '待重采', '已归还'],
      titleFields: ['bottleNo', 'collectAt'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['reason'],
      // 这些要素变更会让本单结论失效重算、旧版留档
      invalidationKeys: ['depositMass', 'collectAt', 'deployedAt'],
      editFields: [
        'collector', 'collectAt', 'deployedAt', 'headspacePct', 'calibrationAgeMin',
        'readingTemp', 'fieldSeal', 'depositMass'
      ],
      flagFields: ['fieldFlags', 'labFlags'],
      detailFields: [
        { label: '顶空占比(%)', name: 'headspacePct' },
        { label: '校准距今(分钟)', name: 'calibrationAgeMin' },
        { label: '读数偏离(%)', name: 'deviationPct' },
        { label: '暴露天数', name: 'exposureDays' },
        { label: '沉积质量(g)', name: 'depositMass' },
        { label: '沉积速率(g/日)', name: 'depositRatePerDay', computed: true },
        { label: '速率变化(%)', name: 'rateChangePct', computed: true },
        { label: '现场封条', name: 'fieldSeal' },
        { label: '送检封条', name: 'labSeal', computed: true }
      ],
      defaults: { headspacePct: 0, calibrationAgeMin: 0 },
      fields: [
        { label: '采样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '瓶号', name: 'bottleNo', required: true, placeholder: '归还前一瓶只能有一份未结束样单' },
        { label: '采集人', name: 'collector', required: true },
        { label: '采集时刻', name: 'collectAt', type: 'datetime-local', required: true },
        { label: '投放时刻', name: 'deployedAt', type: 'datetime-local', required: true },
        { label: '顶空占比(%)', name: 'headspacePct', type: 'number', step: '0.1', required: true },
        { label: '仪器校准距今(分钟)', name: 'calibrationAgeMin', type: 'number', step: '1', required: true },
        { label: '现场读数(℃)', name: 'readingTemp', type: 'number', step: '0.01', required: true },
        { label: '现场封条号', name: 'fieldSeal', required: true }
      ]
    }
  ],
  // 状态流转动作。guards 在存储层用规则引擎之外的通用校验执行；
  // 封条比对、速率判定、待重采/复核路由全部由规则引擎计算。
  actions: [
    {
      id: 'lab-entry',
      kind: 'lab',
      label: '送检录入',
      collection: 'sheets',
      allowStatuses: ['待送检'],
      required: ['labTech', 'labSeal', 'depositMass'],
      // 送检必须换人：录入人不得等于采集人
      actorField: 'labTech',
      otherActorField: 'collector',
      inputFields: [
        { label: '送检录入人（须与采集人不同）', name: 'labTech', required: true },
        { label: '封条号核对', name: 'labSeal', required: true },
        { label: '沉积质量(g)', name: 'depositMass', type: 'number', step: '0.0001', required: true },
        { label: '送检备注', name: 'labNote', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'review-close',
      kind: 'review',
      label: '复核结案',
      collection: 'sheets',
      allowStatuses: ['复核中'],
      required: ['reviewer', 'reviewVerdict'],
      actorField: 'reviewer',
      inputFields: [
        { label: '复核人', name: 'reviewer', required: true },
        { label: '复核结论', name: 'reviewVerdict', type: 'select', options: ['合格', '待重采'], required: true },
        { label: '复核说明', name: 'reviewNote', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'return-bottle',
      kind: 'return',
      label: '归还瓶号',
      collection: 'sheets',
      allowStatuses: ['合格']
    }
  ]
};
