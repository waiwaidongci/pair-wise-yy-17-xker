// 页面层配置：只描述标题、页面结构、表单字段与动作入口；阈值与判定在 lib/rules.js。
module.exports = {
  port: 3912,
  title: '凝结水样链与沉积速率复核台',
  lede: '一瓶号一未结样单：采样质控（顶空、校准、基准偏离）决定是否重采；送检换人录入封条与沉积质量，速率负增长、降幅过两成或封条不符进复核；基准、质量或采集时刻变更自动失效重算，旧版留档。',
  rules: [
    '同一瓶号归还前只允许一份未结束样单，重复或并发登记沿用首次结果',
    '顶空占比超过一成、校准距采集超过半小时、读数偏离基准超过 5%，转待重采',
    '送检须由非采集人录入封条号与沉积质量',
    '速率负增长、较上瓶降幅超过两成、封条号不符，进入复核',
    '基准、沉积质量或采集（布放）时刻变更，结论失效并重新计算，旧版本归档可溯'
  ],
  tones: {
    '待重采': 'bad',
    '待复核': 'warn',
    '采样合格': 'ok',
    '已完成': 'ok',
    '已归还': 'ok'
  },
  collections: {
    points: { label: '凝结样点' },
    samples: { label: '凝结水样单' }
  },
  stats: [
    { label: '凝结样点', collection: 'points' },
    { label: '样单总数', collection: 'samples' },
    { label: '待重采', collection: 'samples', filter: { field: 'status', value: '待重采' } },
    { label: '待复核', collection: 'samples', filter: { field: 'status', value: '待复核' } },
    { label: '未结束样单', collection: 'samples', filter: { field: 'returned', value: false } },
    { label: '已归还', collection: 'samples', filter: { field: 'status', value: '已归还' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '复核看板',
      type: 'dashboard',
      focusTitle: '待重采与待复核',
      focus: { collection: 'samples', field: 'status', values: ['待重采', '待复核'], limit: 8 }
    },
    {
      id: 'points',
      label: '凝结样点',
      collection: 'points',
      formTitle: '新增凝结样点',
      listTitle: '样点列表',
      submitLabel: '建立样点',
      searchPlaceholder: '搜索洞穴、分区、采样点、瓶号前缀',
      searchFields: ['cave', 'zone', 'pointCode', 'bottlePrefix'],
      statusField: null,
      statusOptions: [],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '基准读数 μS/cm', name: 'baselineReading' },
        { label: '瓶号前缀', name: 'bottlePrefix' }
      ],
      cardActions: [
        {
          id: 'baseline-edit',
          label: '变更基准',
          api: '/api/samples/recalc-by-point/',
          method: 'PATCH',
          dialog: {
            title: '变更基准读数',
            hint: '保存后该样点所有未归还样单结论立即失效、按新基准重算，旧版留档。',
            fields: [
              { label: '新基准读数 μS/cm', name: 'baselineReading', type: 'number', from: 'baselineReading', required: true },
              { label: '变更原因', name: 'reason', type: 'textarea', wide: true, placeholder: '如：基准溶液复标' }
            ]
          }
        }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '采样点编号', name: 'pointCode', required: true },
        { label: '瓶号前缀', name: 'bottlePrefix', placeholder: '如 B', required: true },
        { label: '基准读数 μS/cm', name: 'baselineReading', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'samples',
      label: '水样样单',
      collection: 'samples',
      formTitle: '登记凝结水样单',
      listTitle: '样单列表',
      submitLabel: '登记样单',
      searchPlaceholder: '搜索瓶号、采集人、封条号、采样点',
      searchFields: ['bottleNo', 'collector', 'sealField', 'sealLab', 'labOperator', 'conclusion'],
      statusField: 'status',
      statusOptions: ['待重采', '采样合格', '待复核', '已完成', '已归还'],
      titleFields: ['bottleNo', 'collectedAt'],
      relation: { collection: 'points', localKey: 'pointId', labelFields: ['pointCode', 'zone'] },
      summaryFields: ['conclusion'],
      detailFields: [
        { label: '读数 μS/cm', name: 'reading' },
        { label: '顶空占比 %', name: 'headspacePct' },
        { label: '沉积质量 mg', name: 'depositMass' },
        { label: '沉积速率 mg/h', name: 'depositRate' },
        { label: '采集人', name: 'collector' },
        { label: '送检录入人', name: 'labOperator' },
        { label: '采集封条', name: 'sealField' },
        { label: '送检封条', name: 'sealLab' },
        { label: '版本', name: 'version' }
      ],
      cardActions: [
        {
          id: 'sample-resample',
          label: '重采样登记',
          show: { statusIn: ['待重采'] },
          api: '/api/samples/resample/',
          method: 'POST',
          dialog: {
            title: '重采样登记',
            hint: '沿用原瓶号重新采样；质控通过后样单继续流转，旧结论归档。',
            fields: [
              { label: '采集时刻', name: 'collectedAt', type: 'datetime-local', now: true, required: true },
              { label: '布放时刻', name: 'deployedAt', type: 'datetime-local', now: true, required: true },
              { label: '读数 μS/cm', name: 'reading', type: 'number', required: true },
              { label: '瓶容积 mL', name: 'bottleVolume', type: 'number', required: true },
              { label: '顶空体积 mL', name: 'headspaceVolume', type: 'number', required: true },
              { label: '顶空占比 %', name: 'headspacePct', type: 'number', required: true },
              { label: '仪器校准时刻', name: 'calibratedAt', type: 'datetime-local', now: true, required: true },
              { label: '采集人', name: 'collector', required: true },
              { label: '采集封条号', name: 'sealField', required: true }
            ]
          }
        },
        {
          id: 'sample-lab',
          label: '送检录入',
          show: { statusIn: ['采样合格'] },
          api: '/api/samples/lab/',
          method: 'POST',
          dialog: {
            title: '送检录入',
            hint: '须由采集人以外的人员录入封条号与沉积质量；速率异常自动进复核。',
            fields: [
              { label: '送检录入人（不得为采集人）', name: 'labOperator', required: true },
              { label: '送检封条号', name: 'sealLab', required: true },
              { label: '沉积质量 mg', name: 'depositMass', type: 'number', step: 'any', required: true },
              { label: '备注', name: 'labNote', type: 'textarea', wide: true }
            ]
          }
        },
        {
          id: 'sample-time-edit',
          label: '改采集时刻',
          show: { statusIn: ['采样合格', '待复核', '已完成', '待重采'] },
          api: '/api/samples/',
          method: 'PATCH',
          dialog: {
            title: '变更采集 / 布放时刻',
            hint: '保存后结论失效重算，旧版留档；速率按新时长重算。',
            fields: [
              { label: '采集时刻', name: 'collectedAt', type: 'datetime-local', from: 'collectedAt', required: true },
              { label: '布放时刻', name: 'deployedAt', type: 'datetime-local', from: 'deployedAt', required: true },
              { label: '变更原因', name: 'reason', type: 'textarea', wide: true }
            ]
          }
        },
        {
          id: 'sample-mass-edit',
          label: '改沉积质量',
          show: { statusIn: ['待复核', '已完成'] },
          api: '/api/samples/',
          method: 'PATCH',
          dialog: {
            title: '变更沉积质量',
            hint: '保存后速率与复核结论失效重算，旧版留档。',
            fields: [
              { label: '沉积质量 mg', name: 'depositMass', type: 'number', step: 'any', from: 'depositMass', required: true },
              { label: '送检录入人（换人复核）', name: 'labOperator', from: 'labOperator', required: true },
              { label: '变更原因', name: 'reason', type: 'textarea', wide: true }
            ]
          }
        },
        {
          id: 'sample-review-pass',
          label: '复核通过',
          show: { statusIn: ['待复核'] },
          api: '/api/samples/review-pass/',
          method: 'POST',
          dialog: {
            title: '复核结论',
            hint: '复核不通过的样单应重采或修正质量 / 时刻；通过后进入待归还。',
            fields: [
              { label: '复核人', name: 'reviewer', required: true },
              { label: '复核意见', name: 'reviewNote', type: 'textarea', wide: true, required: true }
            ]
          }
        },
        {
          id: 'sample-return',
          label: '归还瓶号',
          show: { statusIn: ['已完成'] },
          api: '/api/samples/return/',
          method: 'POST',
          dialog: {
            title: '归还瓶号',
            hint: '归还后样单结束，瓶号可重新用于下一份样单。',
            fields: [
              { label: '归还经手人', name: 'returner', required: true }
            ]
          }
        }
      ],
      fields: [
        { label: '采样点', name: 'pointId', type: 'relation', collection: 'points', labelFields: ['pointCode', 'zone'], required: true, wide: true },
        { label: '瓶号', name: 'bottleNo', required: true },
        { label: '采集时刻', name: 'collectedAt', type: 'datetime-local', now: true, required: true },
        { label: '布放时刻', name: 'deployedAt', type: 'datetime-local', now: true, required: true },
        { label: '采集人', name: 'collector', required: true },
        { label: '读数 μS/cm', name: 'reading', type: 'number', step: 'any', required: true },
        { label: '瓶容积 mL', name: 'bottleVolume', type: 'number', required: true },
        { label: '顶空体积 mL', name: 'headspaceVolume', type: 'number', required: true },
        { label: '顶空占比 %', name: 'headspacePct', type: 'number', step: 'any', required: true },
        { label: '仪器校准时刻', name: 'calibratedAt', type: 'datetime-local', now: true, required: true },
        { label: '采集封条号', name: 'sealField', required: true },
        { label: '现场备注', name: 'fieldNote', type: 'textarea', wide: true }
      ]
    }
  ]
};
