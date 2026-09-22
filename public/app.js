'use strict';

const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function idempotencyKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields, selectedId) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

// datetime-local 需要 "YYYY-MM-DDTHH:mm" 形式的值
function fieldInputValue(field, value) {
  if (value === undefined || value === null || value === '') return '';
  if (field.type === 'datetime-local') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return value;
}

function formField(field, value) {
  const required = field.required ? 'required' : '';
  const wide = field.wide ? 'wide' : '';
  const current = fieldInputValue(field, value);
  const valAttr = current === '' ? '' : `value="${escapeHtml(current)}"`;
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" ${required}>${escapeHtml(current)}</textarea></label>`;
  }
  if (field.type === 'select') {
    const options = field.options
      .map((option) => `<option${option === current ? ' selected' : ''}>${escapeHtml(option)}</option>`)
      .join('');
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${options}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields, current)}</select></label>`;
  }
  const step = field.step ? `step="${field.step}"` : '';
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${step} ${valAttr} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function flagPills(flags) {
  if (!flags || !flags.length) return '';
  return `<div class="flags">${flags.map((flag) => pill(flag, toneFor(flag))).join('')}</div>`;
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<details class="history"><summary>履历（${history.length}）</summary>${history.map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? `：${escapeHtml(entry.note)}` : ''}</span></div>
  `).join('')}</details>`;
}

function versionsHtml(item) {
  const versions = item.versions || [];
  if (!versions.length) return '';
  return `<details class="history versions"><summary>旧版留档（${versions.length}）</summary>${versions.map((ver) => `
    <div class="version-item">
      <div class="history-item"><span>${fmtDate(ver.at)}</span><span>${escapeHtml(ver.reason || '结论失效重算')}</span></div>
      <div class="version-conclusion">
        ${pill(ver.conclusion.status, toneFor(ver.conclusion.status))}
        <span class="meta">速率 ${escapeHtml(ver.conclusion.depositRatePerDay ?? '-')} g/日 · 变化 ${escapeHtml(ver.conclusion.rateChangePct ?? '-')}% · ${escapeHtml(ver.conclusion.reason || '')}</span>
      </div>
    </div>`).join('')}</details>`;
}

function valuesFromForm(form, fieldDefs) {
  const formData = new FormData(form);
  const payload = {};
  for (const field of fieldDefs) {
    if (!formData.has(field.name)) continue;
    const raw = formData.get(field.name);
    payload[field.name] = field.type === 'number' ? Number(raw) : raw;
  }
  return payload;
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view) => `
    <button class="tab" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.activeTab || state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function matchesFilter(item, filter) {
  if (!filter) return true;
  if (filter.values) return filter.values.includes(item[filter.field]);
  return item[filter.field] === filter.value;
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = items.filter((item) => matchesFilter(item, stat.filter)).length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function actionButtons(item, collection) {
  return state.config.actions
    .filter((action) => action.collection === collection && action.allowStatuses.includes(item.status))
    .map((action) => `
      <form class="action-form" data-action="${action.id}" data-id="${item.id}">
        <h4>${escapeHtml(action.label)}</h4>
        <div class="form-grid">
          ${(action.inputFields || []).map((field) => formField(field)).join('')}
        </div>
        <div class="actions">
          <button type="submit" class="${action.kind === 'return' ? '' : 'danger'}">${escapeHtml(action.label)}</button>
        </div>
      </form>`)
    .join('');
}

function editableFieldsFor(view, item) {
  let names = view.editFields || [];
  if (view.collection === 'sheets') {
    // 沉积质量只能经"送检录入"产生，未送检时不提供更正入口
    if (item.labAt || item.depositMass !== null && item.depositMass !== undefined) {
      // 已送检：保留沉积质量更正
    } else {
      names = names.filter((name) => name !== 'depositMass');
    }
  }
  return names;
}

function editButton(view, item) {
  if (!view.editFields) return '';
  if (view.collection === 'sheets' && ['待重采', '已归还'].includes(item.status)) return '';
  return `<button type="button" class="ghost" data-edit="${item.id}" data-view="${view.id}">修改要素</button>`;
}

function editPanel(view, item) {
  const names = editableFieldsFor(view, item);
  const defs = view.fields.filter((field) => names.includes(field.name));
  return `<form class="edit-form" data-edit-submit="${item.id}" data-view="${view.id}">
    <h4>修改要素（基准 / 质量 / 采集时刻变更将使结论失效重算）</h4>
    <div class="form-grid">${defs.map((field) => formField(field, item[field.name])).join('')}</div>
    <label class="wide">操作人<input name="operator" required placeholder="记录是谁做的修改"></label>
    <div class="actions"><button type="submit">提交修改并重算</button><button type="button" class="ghost" data-edit-cancel="${item.id}">取消</button></div>
  </form>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation
    ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>`
    : '';
  const details = (view.detailFields || []).map((field) => {
    const value = field.type === 'relation' ? relationLabel(field, item[field.name]) : item[field.name];
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value ?? '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const flags = (view.flagFields || []).flatMap((field) => item[field] || []);
  const actions = actionButtons(item, collection);
  return `<article class="card" data-card="${item.id}">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${flagPills(flags)}
    ${summary ? `<p class="reason">${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    <div class="actions">${editButton(view, item)}</div>
    <div class="edit-slot"></div>
    ${actions ? `<div class="action-list">${actions}</div>` : ''}
    ${versionsHtml(item)}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])].sort((a, b) =>
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] ?? '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length
    ? items.map((item) => renderCard(item, collection, view)).join('')
    : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无待处理事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map((field) => formField(field)).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views
    .map((view) => view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view))
    .join('');
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === state.activeTab));
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  const editBtn = event.target.closest('[data-edit]');
  const cancelBtn = event.target.closest('[data-edit-cancel]');
  if (tab) setTab(tab.dataset.tab);
  if (cancelBtn) {
    const card = cancelBtn.closest('.card');
    $('.edit-slot', card).innerHTML = '';
  }
  if (editBtn) {
    const id = editBtn.dataset.edit;
    const view = state.config.views.find((entry) => entry.id === editBtn.dataset.view);
    const card = editBtn.closest('.card');
    const item = state.db[view.collection].find((entry) => entry.id === id);
    $('.edit-slot', card).innerHTML = editPanel(view, item);
    $('.edit-slot', card).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id
    && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const createForm = event.target.closest('[data-create]');
  const actionForm = event.target.closest('[data-action]');
  const editForm = event.target.closest('[data-edit-submit]');
  const form = createForm || actionForm || editForm;
  if (!form) return;
  event.preventDefault();

  try {
    if (createForm) {
      const view = state.config.views.find((entry) => entry.id === createForm.dataset.view);
      const payload = { ...view.defaults, ...valuesFromForm(createForm, view.fields) };
      const result = await api(`/api/${createForm.dataset.create}`, {
        method: 'POST',
        idempotencyKey: idempotencyKey(),
        body: JSON.stringify(payload)
      });
      createForm.reset();
      if (result.reused) toast(result.reason);
      else toast('已保存');
    } else if (actionForm) {
      const action = state.config.actions.find((entry) => entry.id === actionForm.dataset.action);
      const payload = valuesFromForm(actionForm, action.inputFields || []);
      const result = await api(`/api/action/${action.dataset.action}/${actionForm.dataset.id}`, {
        method: 'POST',
        idempotencyKey: idempotencyKey(),
        body: JSON.stringify(payload)
      });
      if (result.reused) toast(result.reason || '已处理，沿用首次结果');
      else toast(`${action.label}完成：${result.item.status}`);
    } else {
      const view = state.config.views.find((entry) => entry.id === editForm.dataset.view);
      const item = state.db[view.collection].find((entry) => entry.id === editForm.dataset.editSubmit);
      const defs = view.fields.filter((field) => editableFieldsFor(view, item).includes(field.name));
      const payload = valuesFromForm(editForm, [...defs, { name: 'operator' }]);
      const result = await api(`/api/${view.collection}/${editForm.dataset.editSubmit}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      toast(`已重算：${result.item.status}（${result.recalculated ? `联动 ${result.recalculated} 张样单` : '仅本单'}）`);
    }
    await load();
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('列表、统计与履历已同步刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
