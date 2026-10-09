/* IT Support: ask a question -> POST /api/support/question -> show solution or "forwarded" message */
const MAX_QUESTION = 1000;
const qInput = document.getElementById('supportQuestion');
const sendBtn = document.getElementById('supportSubmit');
const answerBox = document.getElementById('supportAnswer');

function showBox(kind, title, ...nodes) {            // kind: '' | ok | warn | err
  answerBox.hidden = false; answerBox.className = 'answer ' + kind; answerBox.replaceChildren();
  if (title) { const h = document.createElement('h3'); h.textContent = title; answerBox.append(h); }
  nodes.forEach(n => answerBox.append(n));
}
const para = text => Object.assign(document.createElement('p'), { textContent: text });

function showSolution(solution) {
  const lines = solution.split('\n').map(l => l.trim()).filter(Boolean);
  const list = document.createElement('ol');
  lines.forEach(l => { const li = document.createElement('li'); li.textContent = l.replace(/^\d+[.)]\s*/, ''); list.append(li); });
  showBox('ok', 'Solution:', list);
}

async function askQuestion() {
  const question = qInput.value.trim();
  if (!question) return showBox('err', '', para('Please enter your question.'));
  if (question.length > MAX_QUESTION) return showBox('err', '', para('Please keep your question under 1000 characters.'));
  sendBtn.disabled = true; showBox('', '', para('Checking...'));
  try {
    const r = await api('/api/support/question', { json: { question } });
    if (r.found) showSolution(r.solution);
    else showBox('warn', "We couldn't find a solution for this question.", para(r.message));
    qInput.value = '';
  } catch (err) {
    showBox('err', '', para(err.message));            // server sends safe, user-friendly messages only
  } finally { sendBtn.disabled = false; qInput.focus(); }
}

(async () => {
  await initPage();                                   // auth check + navbar email (common.js)
  sendBtn.addEventListener('click', askQuestion);
  qInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); askQuestion(); } });
})();
