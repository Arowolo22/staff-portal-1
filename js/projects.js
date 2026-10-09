/* Projects hub + workspace */
let current = null;      // {project, members, files, isOwner, currentUserId}
let removeMode = false;
const $ = id => document.getElementById(id);

async function loadProjects() {
  const { projects } = await api('/api/projects');
  const grid = $('projectGrid');
  grid.innerHTML = projects.length ? '' : '<p class="muted">No projects yet. Click “+ Start New Project”.</p>';
  projects.forEach(p => {
    const c = html(`<div class="pcard"><h4></h4>Created by: <span data-o></span><br>Members: ${p.member_count}<br>Files: ${p.file_count}<br>Status: <span class="badge ${p.status}">${p.status}</span><br><button class="btn btn-sm" style="margin-top:6px">Open Project</button></div>`);
    c.querySelector('h4').textContent = p.name; c.querySelector('[data-o]').textContent = p.is_owner ? p.owner_name + ' (you)' : p.owner_name;
    c.querySelector('button').onclick = () => openProject(p.id);
    grid.append(c);
  });
}

function projectForm(p) {
  const body = html(`<form novalidate><label>Project name *</label><input name="name" maxlength="150">
    <label>Description *</label><textarea name="description" maxlength="5000"></textarea>
    <label>Start date (optional)</label><input type="date" name="start"><label>End date (optional)</label><input type="date" name="end">
    ${p ? '<label>Status</label><select name="status"><option>Active</option><option>Completed</option><option>Archived</option></select>' : ''}
    <div class="err"></div><div class="modal-actions"><button type="button" class="btn" data-c>Cancel</button><button class="btn btn-primary"></button></div></form>`);
  if (p) { body.name.value = p.name; body.description.value = p.description || ''; body.start.value = (p.start_date || '').slice(0, 10); body.end.value = (p.end_date || '').slice(0, 10); body.status.value = p.status; }
  body.querySelector('.btn-primary').textContent = p ? 'Save' : 'Create Project';
  return body;
}

function createProject() {
  const body = projectForm(); const m = openModal('Start New Project', body);
  body.querySelector('[data-c]').onclick = m.close;
  body.onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/api/projects', { json: { name: body.name.value, description: body.description.value, startDate: body.start.value || null, endDate: body.end.value || null } });
      m.close(); toast(r.message); await loadProjects(); openProject(r.id);
    } catch (err) { body.querySelector('.err').textContent = err.message; }
  };
}

async function openProject(id) {
  try { current = await api('/api/projects/' + id); } catch (err) { return toast(err.message, 'err'); }
  removeMode = false; $('removeFilesBtn').classList.remove('on');
  $('projectsHub').hidden = true; $('projectWorkspace').hidden = false;
  history.replaceState(null, '', 'projects.html?open=' + id);
  renderWorkspace();
}
function backToList() {
  current = null; $('projectWorkspace').hidden = true; $('projectsHub').hidden = false;
  history.replaceState(null, '', 'projects.html'); loadProjects();
}

function renderWorkspace() {
  const { project: p, isOwner } = current;
  $('wsTab').textContent = p.name;
  $('addMembersBtn').hidden = !isOwner; $('removeFilesBtn').hidden = false;
  const info = $('wsInfo'); info.innerHTML = '';
  const box = html(`<div><div class="desc"></div><div style="font-size:13px;line-height:1.8">Created by: <span data-o></span><br>Created: <span data-c></span><br>${p.start_date || p.end_date ? 'Dates: ' + escapeHtml(fmtRange(p.start_date || p.end_date, p.end_date || p.start_date)) + '<br>' : ''}Status: <span class="badge ${p.status}">${p.status}</span></div>
    <div style="margin-top:8px" data-admin></div></div>`);
  box.querySelector('.desc').textContent = p.description || '';
  box.querySelector('[data-o]').textContent = p.owner_name;
  box.querySelector('[data-c]').textContent = new Date(p.created_at.replace(' ', 'T')).toLocaleDateString();
  if (isOwner) {
    const a = box.querySelector('[data-admin]');
    const edit = html('<button class="btn btn-sm">Edit / Change Status</button>'), del = html('<button class="btn btn-sm btn-danger" style="margin-left:6px">Delete Project</button>');
    edit.onclick = editProject; del.onclick = deleteProject; a.append(edit, del);
  }
  info.append(box); renderMembers(); renderFiles();
}

function renderMembers() {
  const list = $('memberList'); list.innerHTML = '';
  current.members.forEach(m => {
    const el = html('<div class="row-item"><div class="grow"><b data-n></b><small data-e></small></div></div>');
    el.querySelector('[data-n]').textContent = m.full_name + (m.is_owner ? ' (Owner)' : '');
    el.querySelector('[data-e]').textContent = `${m.email} · ${m.department}`;
    if (current.isOwner && !m.is_owner) {
      const b = html('<button class="btn btn-sm">Remove</button>'); b.onclick = () => removeMember(m);
      el.append(b);
    }
    list.append(el);
  });
}

function renderFiles() {
  const list = $('fileList'); list.innerHTML = '';
  if (!current.files.length) list.innerHTML = '<p class="muted" style="font-size:13px">No files yet. Use the 📄➕ icon to add some.</p>';
  current.files.forEach(f => {
    const el = html(`<div class="row-item"><span>📄</span><div class="grow"><b data-n></b><small data-u></small></div>
      <button class="btn btn-sm" data-open>Open</button><button class="btn btn-sm" data-dl>Download</button></div>`);
    el.querySelector('[data-open]').onclick = () => openLocalFile(current.project.id, f.id, true);
    el.querySelector('[data-dl]').onclick = () => openLocalFile(current.project.id, f.id, false);
    el.querySelector('[data-n]').textContent = f.original_filename;
    el.querySelector('[data-u]').textContent = `Uploaded by: ${f.uploaded_by_name || 'Former user'} · ${fmtBytes(f.file_size)}`;
    if (removeMode && (current.isOwner || f.uploaded_by === current.currentUserId)) {
      const b = html('<button class="btn btn-sm btn-danger">Remove</button>'); b.onclick = () => removeProjectFile(f); el.append(b);
    }
    list.append(el);
  });
}

async function refreshMembers() { current.members = (await api(`/api/projects/${current.project.id}/members`)).members; renderMembers(); }

/* ----- add members: search by username / email ----- */
function searchUsers(q) { return api(`/api/users/search?q=${encodeURIComponent(q)}&projectId=${current.project.id}`); }
async function addProjectMember(userId) {
  const r = await api(`/api/projects/${current.project.id}/members`, { json: { userId } });
  current.members = r.members; renderMembers(); toast(r.message);
}
function addMembersModal() {
  const body = html('<div><input type="search" placeholder="Search users by username or email..." autocomplete="off"><div data-r style="margin-top:10px"></div><div class="modal-actions"><button class="btn" data-c>Done</button></div></div>');
  const m = openModal('Add Members', body); body.querySelector('[data-c]').onclick = m.close;
  const input = body.querySelector('input'), out = body.querySelector('[data-r]'); let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim(); if (q.length < 2) { out.innerHTML = '<p class="muted" style="font-size:12px">Type at least 2 characters.</p>'; return; }
      try {
        const { users } = await searchUsers(q);
        out.innerHTML = users.length ? '' : '<p class="muted" style="font-size:12px">No users found.</p>';
        users.forEach(u => {
          const row = html('<div class="row-item" style="background:var(--input)"><div class="grow"><b data-n></b><small data-e></small></div><button class="btn btn-sm"></button></div>');
          row.querySelector('[data-n]').textContent = u.full_name;
          row.querySelector('[data-e]').textContent = `${u.email} · ${u.department}`;
          const b = row.querySelector('button'); b.textContent = u.is_member ? 'Member' : 'Add'; b.disabled = u.is_member;
          b.onclick = async () => { b.disabled = true; try { await addProjectMember(u.id); b.textContent = 'Added ✓'; } catch (err) { toast(err.message, 'err'); b.disabled = false; } };
          out.append(row);
        });
      } catch (err) { out.textContent = err.message; }
    }, 300);
  });
}
async function removeMember(m) {
  if (!(await confirmDialog(`Remove ${m.full_name} from this project?`))) return;
  try { const r = await api(`/api/projects/${current.project.id}/members/${m.id}`, { method: 'DELETE' }); current.members = r.members; renderMembers(); toast(r.message); }
  catch (err) { toast(err.message, 'err'); }
}

/* ----- files ----- */
async function uploadProjectFile(fileList) {
  if (!fileList.length) return;
  const fd = new FormData(); [...fileList].forEach(f => { if (f.size <= 10 * 1024 * 1024) fd.append('files', f); else toast(`${f.name} is larger than 10 MB.`, 'err'); });
  if (![...fd.keys()].length) return;
  try { const r = await api(`/api/projects/${current.project.id}/files`, { method: 'POST', body: fd }); current.files = r.files; renderFiles(); toast(r.message); }
  catch (err) { toast(err.message, 'err'); }
  $('fileInput').value = '';
}
async function removeProjectFile(f) {
  if (!(await confirmDialog('Are you sure you want to remove this file?'))) return;
  try { const r = await api(`/api/projects/${current.project.id}/files/${f.id}`, { method: 'DELETE' }); current.files = r.files; renderFiles(); toast(r.message); }
  catch (err) { toast(err.message, 'err'); }
}

/* ----- edit / delete project ----- */
function editProject() {
  const body = projectForm(current.project); const m = openModal('Edit Project', body);
  body.querySelector('[data-c]').onclick = m.close;
  body.onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/api/projects/' + current.project.id, { method: 'PUT', json: { name: body.name.value, description: body.description.value, startDate: body.start.value || null, endDate: body.end.value || null, status: body.status.value } });
      m.close(); toast(r.message); openProject(current.project.id);
    } catch (err) { body.querySelector('.err').textContent = err.message; }
  };
}
async function deleteProject() {
  if (!(await confirmDialog('Delete this project and all its files permanently?', 'Delete'))) return;
  try { const r = await api('/api/projects/' + current.project.id, { method: 'DELETE' }); toast(r.message); backToList(); } catch (err) { toast(err.message, 'err'); }
}

(async () => {
  await initPage();
  $('startNewProjectBtn').onclick = createProject;
  $('backToProjects').onclick = backToList;
  $('addMembersBtn').onclick = addMembersModal;
  $('addFilesBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => uploadProjectFile(e.target.files);
  $('removeFilesBtn').onclick = () => { removeMode = !removeMode; $('removeFilesBtn').classList.toggle('on', removeMode); if (removeMode) toast('Remove mode on – click Remove next to a file.', 'ok'); renderFiles(); };
  try { await loadProjects(); } catch (e) { toast(e.message, 'err'); }
  const open = parseInt(new URLSearchParams(location.search).get('open'), 10);
  if (open) openProject(open);
})();
