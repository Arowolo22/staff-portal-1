/* Schedule page: month calendar + CRUD */
const $ = id => document.getElementById(id);
let view = new Date(); view.setDate(1);
let monthSchedules = [], myProjects = [];
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadSchedules() {
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
  const { schedules } = await api(`/api/schedules?from=${ymd(gridStart)}&to=${ymd(gridEnd)}`);
  monthSchedules = schedules; renderCalendar(gridStart);
}

function renderCalendar(gridStart) {
  $('monthLabel').textContent = view.toLocaleString('default', { month: 'long', year: 'numeric' });
  const cal = $('calendar'); cal.innerHTML = '';
  const grid = html('<div class="cal-grid"></div>');
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => grid.append(html(`<div class="cal-dow">${d}</div>`)));
  const today = ymd(new Date());
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); const ds = ymd(d);
    const cell = html(`<div class="cal-cell ${d.getMonth() !== view.getMonth() ? 'other' : ''} ${ds === today ? 'today' : ''}"><div class="dnum">${d.getDate()}</div></div>`);
    const list = monthSchedules.filter(s => s.start_date <= ds && s.end_date >= ds);
    list.slice(0, 3).forEach(s => {
      const bar = html(`<div class="cal-bar p-${s.priority} ${s.start_date === ds ? 's' : ''} ${s.end_date === ds ? 'e' : ''}"></div>`);
      bar.textContent = (s.start_date === ds || d.getDay() === 0) ? s.name : '\u00a0';
      bar.title = `${s.name} (${s.priority}, ${s.status})`;
      bar.onclick = e => { e.stopPropagation(); viewSchedule(s); };
      cell.append(bar);
    });
    if (list.length > 3) { const more = html(`<div class="cal-more">+${list.length - 3} more</div>`); more.onclick = e => { e.stopPropagation(); dayModal(ds, list); }; cell.append(more); }
    cell.onclick = () => scheduleForm(null, ds);
    grid.append(cell);
  }
  cal.append(grid);
}

function dayModal(ds, list) {
  const body = html('<div></div>'); const m = openModal(fmtDate(ds), body);
  list.forEach(s => { const r = html('<div class="row-item" style="background:var(--input);cursor:pointer"></div>'); r.textContent = `${PRIORITY_ICON[s.priority]} ${s.name}`; r.onclick = () => { m.close(); viewSchedule(s); }; body.append(r); });
}

function viewSchedule(s) {
  const body = html(`<div style="font-size:14px;line-height:1.8"><div>${PRIORITY_ICON[s.priority]} <b>${escapeHtml(s.priority)}</b> · ${escapeHtml(s.status)}</div>
    <div>${escapeHtml(fmtRange(s.start_date, s.end_date))}</div><div>Project: ${escapeHtml(s.project_name || 'No Project')}</div>
    <div class="muted" style="white-space:pre-wrap">${escapeHtml(s.description || '')}</div>
    <div class="modal-actions"><button class="btn" data-c>Close</button><button class="btn" data-e>Edit</button><button class="btn btn-danger" data-d>Delete</button></div></div>`);
  const m = openModal(s.name, body);
  body.querySelector('[data-c]').onclick = m.close;
  body.querySelector('[data-e]').onclick = () => { m.close(); scheduleForm(s); };
  body.querySelector('[data-d]').onclick = async () => { m.close(); if (await confirmDialog('Delete this schedule?', 'Delete')) deleteSchedule(s.id); };
}

async function scheduleForm(existing, defaultDate) {
  try { myProjects = (await api('/api/projects')).projects; } catch (e) { myProjects = []; }
  const body = html(`<form novalidate><label>Schedule name *</label><input name="name" maxlength="150">
    <label>Start date *</label><input type="date" name="start"><label>End date *</label><input type="date" name="end">
    <label>Project</label><select name="project"><option value="">No Project</option></select>
    <label>Priority</label><select name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Urgent</option></select>
    <label>Status</label><select name="status"><option>Pending</option><option>In Progress</option><option>Completed</option></select>
    <label>Description</label><textarea name="description" maxlength="5000"></textarea>
    <div class="err"></div><div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn btn-primary"></button></div></form>`);
  myProjects.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; body.project.append(o); });
  const s = existing;
  body.name.value = s ? s.name : ''; body.start.value = s ? s.start_date : (defaultDate || ymd(new Date())); body.end.value = s ? s.end_date : (defaultDate || ymd(new Date()));
  body.project.value = s && s.project_id ? s.project_id : ''; body.priority.value = s ? s.priority : 'Medium'; body.status.value = s ? s.status : 'Pending'; body.description.value = s ? (s.description || '') : '';
  body.querySelector('.btn-primary').textContent = s ? 'Save' : 'Create Schedule';
  const m = openModal(s ? 'Edit Schedule' : 'New Schedule', body);
  body.querySelector('[data-c]').onclick = m.close;
  body.start.addEventListener('change', () => { if (body.end.value < body.start.value) body.end.value = body.start.value; });
  body.onsubmit = async e => {
    e.preventDefault();
    const data = { name: body.name.value, startDate: body.start.value, endDate: body.end.value, projectId: body.project.value || null, priority: body.priority.value, status: body.status.value, description: body.description.value };
    try { await (s ? updateSchedule(s.id, data) : createSchedule(data)); m.close(); }
    catch (err) { body.querySelector('.err').textContent = err.message; }
  };
}

async function createSchedule(data) { const r = await api('/api/schedules', { json: data }); toast(r.message); await loadSchedules(); }
async function updateSchedule(id, data) { const r = await api('/api/schedules/' + id, { method: 'PUT', json: data }); toast(r.message); await loadSchedules(); }
async function deleteSchedule(id) { try { const r = await api('/api/schedules/' + id, { method: 'DELETE' }); toast(r.message); await loadSchedules(); } catch (err) { toast(err.message, 'err'); } }

(async () => {
  await initPage();
  $('prevMonth').onclick = () => { view.setMonth(view.getMonth() - 1); loadSchedules(); };
  $('nextMonth').onclick = () => { view.setMonth(view.getMonth() + 1); loadSchedules(); };
  $('todayBtn').onclick = () => { view = new Date(); view.setDate(1); loadSchedules(); };
  $('addScheduleBtn').onclick = () => scheduleForm(null);
  try { await loadSchedules(); } catch (e) { toast(e.message, 'err'); }
})();
