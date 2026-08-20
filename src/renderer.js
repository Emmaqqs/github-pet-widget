const { ipcRenderer, shell } = require('electron');

const bubble = document.getElementById('bubble');
const alertsSection = document.getElementById('alerts-section');
const alertsList = document.getElementById('alerts-list');
const userHeader = document.getElementById('user-header');
const authSection = document.getElementById('auth-section');
const aiSettingsSection = document.getElementById('ai-settings-section');
const tokenInput = document.getElementById('token-input');
const authErrorMsg = document.getElementById('auth-error-msg');
const tokenHistoryList = document.getElementById('token-history-list');
const tokenChips = document.getElementById('token-chips');
const pet = document.getElementById('pet');
const petContainer = document.getElementById('pet-container');
const badge = document.getElementById('badge');
const toastMsg = document.getElementById('toast-msg');
const body = document.body;

// Toggle de Auto-Pilot
const chkAutopilot = document.getElementById('chk-autopilot');

let isBubbleVisible = true;
let prevTotalAlerts = -1;
let alertFilter = 'active';
const alertStore = new Map();
const viewedAt = new Map();
let toastTimer = null;

function showToast(text, isError = false) {
    if (toastTimer) clearTimeout(toastTimer);
    toastMsg.textContent = text;
    toastMsg.style.display = 'block';
    toastMsg.style.background = isError ? '#991b1b' : '#1e293b';
    toastTimer = setTimeout(() => {
        toastMsg.style.display = 'none';
    }, 4500);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function alertKey(a) { return String(a.url || a.title || ''); }
function isViewed(a) {
    const seen = viewedAt.get(alertKey(a));
    return Boolean(seen && new Date(a.latest_activity_at || a.updated_at || 0) <= new Date(seen));
}

// Clic en la mascota para expandir / ocultar el globo suavemente (sin mover el contenedor)
pet.addEventListener('click', (e) => {
    isBubbleVisible = !isBubbleVisible;
    if (isBubbleVisible) {
        bubble.classList.remove('hidden');
    } else {
        bubble.classList.add('hidden');
    }
});

pet.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ipcRenderer.send('show-context-menu');
});

function updateBadge(count) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = count > 0 ? 'flex' : 'none';
}

function triggerAlertAnimation() {
    pet.classList.remove('anim-bounce', 'anim-new-alert');
    void pet.offsetWidth;
    pet.classList.add('anim-new-alert');
    setTimeout(() => { pet.classList.remove('anim-new-alert'); pet.classList.add('anim-bounce'); }, 800);
}

function triggerHappyAnimation() {
    pet.classList.remove('anim-happy');
    void pet.offsetWidth;
    pet.classList.add('anim-happy');
}

function markSeen(url, updatedAt) {
    viewedAt.set(url, updatedAt || new Date().toISOString());
    ipcRenderer.send('mark-seen', { url, updatedAt: updatedAt || new Date().toISOString() });
    renderAlerts();
}

function markUnseen(url) {
    viewedAt.delete(url);
    ipcRenderer.send('mark-unseen', { url });
    renderAlerts();
}
window.markSeen = markSeen;
window.markUnseen = markUnseen;

function openURL(url) { shell.openExternal(url); }
window.openURL = openURL;

// =========================================================================
// ACCIONES 1-CLICK AUTÓNOMAS DIRECTAS (WORKTREE + TESTS + PUSH + GITHUB API)
// =========================================================================

function triggerAutoReview(url, btn) {
    const alert = alertStore.get(url);
    if (!alert) return;
    btn.disabled = true;
    btn.textContent = '⚙️ Publicando Review...';
    body.className = 'state-working';
    showToast(`🤖 Generando y publicando Code Review para PR #${alert.number}...`);
    ipcRenderer.send('execute-auto-review', alert);
}

function triggerAutoFixFeedback(url, btn) {
    const alert = alertStore.get(url);
    if (!alert) return;
    btn.disabled = true;
    btn.textContent = '⚙️ Auto-Fix en Worktree...';
    body.className = 'state-working';
    showToast(`⚡ Creando worktree, aplicando fixes y corriendo tests para PR #${alert.number}...`);
    ipcRenderer.send('execute-autofix-worktree', alert);
}

function triggerMergeConflictResolution(url, btn) {
    const alert = alertStore.get(url);
    if (!alert) return;
    btn.disabled = true;
    btn.textContent = '⚙️ Resolviendo en Worktree...';
    body.className = 'state-working';
    showToast(`🔀 Resolviendo conflictos en worktree y pusheando para PR #${alert.number}...`);
    ipcRenderer.send('execute-merge-conflict-worktree', alert);
}

ipcRenderer.on('action-completed', (event, result) => {
    if (result.success) {
        showToast(result.message || '🚀 ¡Tarea completada y pusheada a GitHub con éxito!');
        triggerHappyAnimation();
    } else {
        showToast('❌ ' + (result.error || 'No se pudo completar la acción.'), true);
    }
});

// Auto-Pilot Background Status
ipcRenderer.on('autopilot-status', (event, { text }) => {
    body.className = 'state-working';
    showToast(text);
});

ipcRenderer.on('autopilot-finished', (event, { pr, result }) => {
    if (result?.pushed || result?.success) {
        showToast(`✨ Auto-Pilot: PR #${pr.number} resuelto y pusheado con tests verdes.`);
        triggerHappyAnimation();
    }
});

function createAlertItem(a, viewed) {
    const item = document.createElement('div');
    item.className = 'alert-item';
    item.dataset.url = alertKey(a);

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.justifyContent = 'space-between';
    topRow.style.alignItems = 'flex-start';

    const link = document.createElement('a');
    link.href = '#';
    link.textContent = a.title || 'Pull Request sin título';
    link.title = a.title || '';
    link.style.flex = '1';
    link.addEventListener('click', (e) => { e.preventDefault(); openURL(a.url); });

    const button = document.createElement('button');
    button.className = viewed ? 'btn-seen btn-unseen' : 'btn-seen';
    button.textContent = viewed ? '↩ No visto' : '✓ Visto';
    button.addEventListener('click', () => viewed
        ? markUnseen(alertKey(a))
        : markSeen(alertKey(a), a.latest_activity_at || a.updated_at));

    topRow.append(link, button);
    item.appendChild(topRow);

    if (a.state) {
        const detail = document.createElement('span');
        detail.className = 'alert-detail';
        detail.textContent = a.state;
        item.appendChild(detail);
    }

    // Botones de acción 1-click end-to-end
    const actions = document.createElement('div');
    actions.className = 'alert-actions';

    // Si tiene conflictos de merge -> Botón Resolver & Push
    if (a.has_conflict) {
        const conflictBtn = document.createElement('button');
        conflictBtn.className = 'btn-action-ai btn-action-conflict';
        conflictBtn.innerHTML = '<span>🔀</span> Resolver & Push';
        conflictBtn.title = 'Crear worktree aislado, resolver marcadores con IA, verificar tests y hacer git push';
        conflictBtn.addEventListener('click', () => triggerMergeConflictResolution(alertKey(a), conflictBtn));
        actions.appendChild(conflictBtn);
    }

    // Si es mi PR y me dejaron cambios o feedback -> Botón Auto-Fix & Push
    if (a.type === 'my_pr_activity' && a.state && (a.state.includes('Cambios pedidos') || a.state.includes('Comentario'))) {
        const fixBtn = document.createElement('button');
        fixBtn.className = 'btn-action-ai';
        fixBtn.innerHTML = '<span>⚡</span> Auto-Fix & Push';
        fixBtn.title = 'Crear worktree, aplicar correcciones de código solicitadas con IA, verificar tests y hacer git push';
        fixBtn.addEventListener('click', () => triggerAutoFixFeedback(alertKey(a), fixBtn));
        actions.appendChild(fixBtn);
    }

    // Si me asignaron para revisar -> Botón Revisar & Publicar
    if (a.type === 'review_required' || a.type === 're_review_needed') {
        const reviewBtn = document.createElement('button');
        reviewBtn.className = 'btn-action-ai';
        reviewBtn.innerHTML = '<span>🤖</span> Revisar & Publicar';
        reviewBtn.title = 'Analizar diff con IA y publicar la revisión oficial directamente en GitHub';
        reviewBtn.addEventListener('click', () => triggerAutoReview(alertKey(a), reviewBtn));
        actions.appendChild(reviewBtn);
    }

    if (actions.children.length > 0) {
        item.appendChild(actions);
    }

    return item;
}

const sections = [
    ['merge_conflicts', 'title-conflict', '💥 Conflictos de Merge'],
    ['my_pr_activity', 'title-action', '⚡ Actividad en tus PRs'],
    ['re_review_needed', 'title-rereview', '🔄 Re-revisión Pendiente'],
    ['review_required', 'title-review', '⏳ Revisión Requerida']
];

function renderAlerts() {
    alertsList.replaceChildren();
    let shown = 0;
    sections.forEach(([type, className, label]) => {
        const items = [...alertStore.values()].filter(a => a.type === type &&
            (alertFilter === 'active' ? !isViewed(a) : isViewed(a)));
        if (!items.length) return;
        const title = document.createElement('div');
        title.className = `section-title ${className}`;
        title.textContent = label;
        alertsList.appendChild(title);
        items.forEach(a => { alertsList.appendChild(createAlertItem(a, alertFilter === 'viewed')); shown++; });
    });
    if (!shown) {
        alertsList.innerHTML = alertFilter === 'viewed'
            ? '<div class="empty-state">No hay alertas vistas.</div>'
            : '<div class="empty-state happy-message">✨ ¡Todo al día! Sin pendientes.</div>';
    }
    const activeCount = [...alertStore.values()].filter(a => !isViewed(a)).length;
    updateBadge(activeCount);
}

function setAlertFilter(filter) {
    alertFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
    renderAlerts();
}
window.setAlertFilter = setAlertFilter;

function refreshStatus() {
    const button = document.getElementById('refresh-btn');
    if (button) { button.disabled = true; button.textContent = 'Actualizando…'; }
    ipcRenderer.send('refresh-status');
    setTimeout(() => {
        if (button) { button.disabled = false; button.textContent = '↻ Actualizar'; }
    }, 1500);
}
window.refreshStatus = refreshStatus;

// Configuración de Prompts e IA y Auto-Pilot
function showAISettings() {
    alertsSection.style.display = 'none';
    authSection.style.display = 'none';
    aiSettingsSection.style.display = 'block';
    ipcRenderer.send('get-ai-templates');
}
window.showAISettings = showAISettings;

function showAlertsView() {
    aiSettingsSection.style.display = 'none';
    authSection.style.display = 'none';
    alertsSection.style.display = 'block';
}
window.showAlertsView = showAlertsView;

ipcRenderer.on('ai-templates-data', (event, { templates, autopilot_enabled }) => {
    document.getElementById('tpl-review').value = templates.review_prompt_template || '';
    document.getElementById('tpl-autofix').value = templates.autofix_commit_template || '';
    document.getElementById('tpl-conflict').value = templates.merge_conflict_template || '';
    chkAutopilot.checked = Boolean(autopilot_enabled);
});

function saveAISettings() {
    const payload = {
        templates: {
            review_prompt_template: document.getElementById('tpl-review').value,
            autofix_commit_template: document.getElementById('tpl-autofix').value,
            merge_conflict_template: document.getElementById('tpl-conflict').value,
        },
        autopilot_enabled: chkAutopilot.checked,
    };
    ipcRenderer.send('save-ai-templates', payload);
    const feedback = document.getElementById('ai-save-feedback');
    feedback.style.display = 'block';
    setTimeout(() => { feedback.style.display = 'none'; }, 2000);
}
window.saveAISettings = saveAISettings;

function resetAITemplates() {
    ipcRenderer.send('reset-ai-templates');
    const feedback = document.getElementById('ai-save-feedback');
    feedback.textContent = '🔄 Valores por defecto restaurados';
    feedback.style.display = 'block';
    setTimeout(() => {
        feedback.textContent = '✅ Ajustes guardados correctamente';
        feedback.style.display = 'none';
    }, 2000);
}
window.resetAITemplates = resetAITemplates;

function renderTokenHistory(history) {
    if (!history || history.length === 0) { tokenHistoryList.style.display = 'none'; return; }
    tokenHistoryList.style.display = 'block';
    tokenChips.replaceChildren();
    history.forEach(h => {
        const button = document.createElement('button');
        button.className = 'token-chip';
        button.title = h.token;
        button.textContent = `@${h.username}`;
        button.addEventListener('click', () => { tokenInput.value = h.token; saveToken(); });
        tokenChips.appendChild(button);
    });
}
ipcRenderer.on('token-history', (event, history) => renderTokenHistory(history));
ipcRenderer.on('seen-prs', (event, seen) => {
    viewedAt.clear();
    Object.entries(seen || {}).forEach(([url, timestamp]) => viewedAt.set(url, timestamp));
    renderAlerts();
});

function openTokenHelp() { shell.openExternal('https://github.com/settings/tokens/new?scopes=repo,read:user&description=GitHub%20Pet%20Widget'); }
window.openTokenHelp = openTokenHelp;

function saveToken() {
    const token = tokenInput.value.trim();
    if (!token) { showError('Por favor ingresa un token válido.'); return; }
    authErrorMsg.style.display = 'none';
    document.getElementById('save-token-btn').textContent = 'Verificando...';
    ipcRenderer.send('set-token', token);
}
window.saveToken = saveToken;

function showSettings() {
    alertsSection.style.display = 'none';
    aiSettingsSection.style.display = 'none';
    authSection.style.display = 'block';
    authErrorMsg.style.display = 'none';
    document.getElementById('save-token-btn').textContent = 'Guardar y Conectar';
    ipcRenderer.send('get-token-history');
}
window.showSettings = showSettings;

function showError(msg) {
    authErrorMsg.textContent = msg;
    authErrorMsg.style.display = 'block';
    document.getElementById('save-token-btn').textContent = 'Guardar y Conectar';
    body.className = 'state-disconnected';
}

ipcRenderer.on('show-settings', () => showSettings());
ipcRenderer.on('show-ai-settings', () => showAISettings());
ipcRenderer.on('always-on-top-state', () => {});
ipcRenderer.on('auth-success', (event, { username, tokenHistory }) => {
    authSection.style.display = 'none';
    aiSettingsSection.style.display = 'none';
    alertsSection.style.display = 'block';
    userHeader.textContent = `👤 @${username}`;
    if (tokenHistory) renderTokenHistory(tokenHistory);
});
ipcRenderer.on('auth-error', (event, error) => showError(error));

ipcRenderer.on('status-update', (event, alerts) => {
    const incoming = [];
    sections.forEach(([type]) => (alerts[type] || []).forEach(a => incoming.push({ ...a, type })));
    const incomingKeys = new Set(incoming.map(alertKey));
    
    [...alertStore.keys()].forEach(key => {
        if (!incomingKeys.has(key) && !viewedAt.has(key)) alertStore.delete(key);
    });
    incoming.forEach(a => alertStore.set(alertKey(a), a));

    const active = incoming.filter(a => !isViewed(a));
    const priority = active.some(a => a.type === 'merge_conflicts') ? 'state-conflict'
        : active.some(a => a.type === 'my_pr_activity') ? 'state-action'
        : active.some(a => a.type === 're_review_needed') ? 'state-rereview'
        : active.some(a => a.type === 'review_required') ? 'state-alert' : 'state-happy';
    body.className = priority;
    renderAlerts();
    if (prevTotalAlerts >= 0 && active.length > prevTotalAlerts) triggerAlertAnimation();
    if (active.length === 0) triggerHappyAnimation();
    prevTotalAlerts = active.length;
});

tokenInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveToken(); });
