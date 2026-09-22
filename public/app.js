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

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
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
    return `<option value="${item.id}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

// datetime-local 需要的本地时间字符串。
function nowLocalInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function fieldValue(field, source) {
  if (source && source[field.name] !== undefined && source[field.name] !== null) {
    if (field.type === 'datetime-local') return toLocalInput(source[field.name]);
    return source[field.name];
  }
  if (field.now) return nowLocalInput();
  return field.default ?? '';
}

function formField(field, source) {
  const required = field.required ? 'required' : '';
  const value = fieldValue(field, source);
  const valueAttr = `value="${escapeHtml(value)}"`;
  const extra = field.step ? ` step="${escapeHtml(field.step)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" placeholder="${escapeHtml(field.placeholder || '')}" ${required}>${escapeHtml(value)}</textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields, value)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${valueAttr}${extra} placeholder="${escapeHtml(field.placeholder || '')}" ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function reasonBlock(label, reasons, cls) {
  if (!reasons || !reasons.length) return '';
  return `<ul class="reasons ${cls}">${reasons.map((reason) => `<li>${escapeHtml(label)}：${escapeHtml(reason)}</li>`).join('')}</ul>`;
}

function versionsHtml(item) {
  const versions = item.versions || [];
  if (!versions.length) return '';
  return `<div class="versions"><h4>失效旧版留档</h4>${versions.slice().reverse().map((entry) => `
    <div class="version-item">
      <div><span>v${entry.version}</span>${pill(entry.status, toneFor(entry.status))}${entry.depositRate !== null && entry.depositRate !== undefined ? `<span class="rate">${escapeHtml(entry.depositRate)} mg/h</span>` : ''}</div>
      <p>${escapeHtml(entry.conclusion || '')}</p>
      <p class="muted">${escapeHtml(entry.invalidReason || '')} · ${fmtDate(entry.invalidatedAt)}</p>
    </div>`).join('')}</div>`;
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, fields) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of fields) {
    if (field.type === 'number') payload[field.name] = payload[field.name] === '' ? null : Number(payload[field.name]);
  }
  return payload;
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderRules() {
  const rules = state.config.rules || [];
  if (!rules.length) return '';
  return `<div class="rules-banner"><h3>规则</h3><ol>${rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ol></div>`;
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter
      ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length
      : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function viewFor(collection) {
  return state.config.views.find((view) => view.collection === collection);
}

function cardActions(item, collection) {
  const view = viewFor(collection);
  const actions = view?.cardActions || [];
  return actions
    .filter((action) => {
      if (!action.show?.statusIn) return true;
      return action.show.statusIn.includes(item.status);
    })
    .map((action) => `<button class="ghost" data-card-action="${action.id}" data-collection="${collection}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => {
    if (field === 'collectedAt') return fmtDate(item[field]);
    return item[field];
  }).filter(Boolean).join(' / ') || item.id;
  const statusValue = view.statusField ? item[view.statusField] : '';
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.name === 'collectedAt' || field.name === 'deployedAt' ? fmtDate(raw)
      : raw === null || raw === undefined || raw === '' ? '-' : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value)}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = cardActions(item, collection);
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p class="conclusion">${escapeHtml(summary)}</p>` : ''}
    ${reasonBlock('待重采原因', item.qcReasons, 'bad')}
    ${reasonBlock('复核原因', item.reviewReasons, 'warn')}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${versionsHtml(item)}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] ?? '').includes(query)));
  }
  if (status && view.statusField) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = viewFor(source.collection) || { titleFields: ['id'], detailFields: [] };
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    ${renderRules()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  const statusFilter = view.statusField
    ? `<select id="status-${view.id}"><option value="">全部状态</option>${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select>`
    : '<span></span>';
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
          ${statusFilter}
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
  $('#main').innerHTML = state.config.views.map((view) => view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view)).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

// ---------- 卡片动作弹窗 ----------

function findCardAction(actionId, collection) {
  return viewFor(collection)?.cardActions?.find((action) => action.id === actionId);
}

function openDialog({ title, hint, fields, submitLabel, onSubmit }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="modal panel">
      <h2>${escapeHtml(title)}</h2>
      ${hint ? `<p class="modal-hint">${escapeHtml(hint)}</p>` : ''}
      <div class="form-grid">${fields.map((field) => formField(field, field._source)).join('')}</div>
      <div class="actions">
        <button type="submit">${escapeHtml(submitLabel || '确认')}</button>
        <button type="button" class="ghost" data-close>取消</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) close();
  });
  overlay.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const message = await onSubmit(values(event.target, fields), close);
      close();
      await load();
      if (message) toast(message);
    } catch (error) {
      toast(error.message, true);
    }
  });
  setTimeout(() => overlay.querySelector('input,textarea,select')?.focus(), 0);
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-card-action]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    const actionDef = findCardAction(action.dataset.cardAction, action.dataset.collection);
    if (!actionDef?.dialog) return;
    const collection = action.dataset.collection;
    const item = state.db[collection].find((entry) => entry.id === action.dataset.id);
    const fields = actionDef.dialog.fields.map((field) => ({
      ...field,
      _source: field.from ? item : undefined
    }));
    openDialog({
      title: actionDef.dialog.title,
      hint: actionDef.dialog.hint,
      fields,
      submitLabel: actionDef.label,
      onSubmit: async (payload) => {
        const result = await api(`${actionDef.api}${item.id}`, { method: actionDef.method || 'POST', body: JSON.stringify(payload) });
        const affected = result?.affected;
        if (Array.isArray(affected)) return `基准已变更，${affected.length} 份未结束样单已重算`;
        return '已更新';
      }
    });
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  try {
    const result = await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view.fields)) });
    form.reset();
    view.fields.filter((field) => field.now).forEach((field) => {
      const input = form.elements[field.name];
      if (input) input.value = nowLocalInput();
    });
    await load();
    toast(result.reused ? result.note : '已保存', Boolean(result.reused));
  } catch (error) {
    toast(error.message, true);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message, true));
