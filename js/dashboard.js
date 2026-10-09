async function loadDashboard() {
  const { projects, schedules } = await api('/api/dashboard');
  const pBox = document.getElementById('dashboardProjects');
  pBox.innerHTML = projects.length ? '' : '<p class="muted">No active projects yet. <a href="projects.html">Start one</a>.</p>';
  projects.forEach(p => {
    const c = html(`<div class="pcard"><h4></h4>Owner: <span data-o></span><br>Members: ${p.member_count}<br>Files: ${p.file_count}<br>Status: <span class="badge ${p.status}">${p.status}</span><br><button class="btn btn-sm" style="margin-top:6px">Open Project</button></div>`);
    c.querySelector('h4').textContent = p.name; c.querySelector('[data-o]').textContent = p.is_owner ? p.owner_name + ' (you)' : p.owner_name;
    c.querySelector('button').onclick = () => location.href = 'projects.html?open=' + p.id;
    pBox.append(c);
  });
  const sBox = document.getElementById('dashboardSchedules');
  sBox.innerHTML = schedules.length ? '' : '<p>No upcoming schedules. <a href="schedule.html">Create one</a>.</p>';
  schedules.forEach(s => {
    const label = s.state === 'overdue' ? '⛔ OVERDUE' : `${PRIORITY_ICON[s.priority]} ${s.priority.toUpperCase()}${s.state === 'active' ? ' · IN PROGRESS NOW' : ''}`;
    const when = s.state === 'overdue' ? 'Due: ' + fmtDate(s.end_date) : fmtRange(s.start_date, s.end_date);
    const el = html(`<div class="s-item ${s.state === 'overdue' ? 'overdue' : s.priority}"><b>${label}</b><span data-n></span><br><small data-w></small></div>`);
    el.querySelector('[data-n]').textContent = s.name + (s.project_name ? ' · ' + s.project_name : '');
    el.querySelector('[data-w]').textContent = when;
    sBox.append(el);
  });
}
(async () => { await initPage(); try { await loadDashboard(); } catch (e) { toast(e.message, 'err'); } })();
