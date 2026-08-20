const { ipcRenderer, shell, clipboard } = require('electron');

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
const body = document.body;

// Modal de IA
const aiModal = document.getElementById('ai-modal');
const aiModalTitle = document.getElementById('ai-modal-title');
const aiModalBody = document.getElementById('ai-modal-body');

let isBubbleVisible = true;
let prevTotalAlerts = -1;
let alertFilter = 'active';
const alertStore = new Map();
const viewedAt = new Map();
let currentAIReviewText = '';

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

// -------------------------------------------------------------
// ARRASTRE MULTI-MONITOR DIRECTO SIN DERIVA VERTICAL (ZERO DRIFT)
// -------------------------------------------------------------
let isDragging = false;
let didDrag = false;
let dragStartClientX = 0;
let dragStartClientY = 0;
let activePointerId = null;

function endDrag() {
    if (!isDragging) return;
    if (activePointerId !== null && typeof petContainer.releasePointerCapture === 'function') {
        try { petContainer.releasePointerCapture(activePointerId); } catch (_) {}
    }
    activePointerId = null;
    isDragging = false;
    ipcRenderer.send('drag-end');
}

petContainer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    isDragging = true;
    didDrag = false;
    activePointerId = e.pointerId ?? null;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    
    // Enviamos las coordenadas del clic relativas a la ventana (320x380)
    ipcRenderer.send('drag-start', { clientX: e.clientX, clientY: e.clientY });
    
    if (activePointerId !== null && typeof petContainer.setPointerCapture === 'function') {
        try { petContainer.setPointerCapture(activePointerId); } catch (_) {}
    }
    e.preventDefault();
});

document.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - dragStartClientX;
    const deltaY = e.clientY - dragStartClientY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) didDrag = true;
    ipcRenderer.send('drag-move');
});

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

pet.addEventListener('click', () => {
    if (didDrag) { didDrag = false; return; }
    isBubbleVisible = !isBubbleVisible;
    bubble.style.display = isBubbleVisible ? 'block' : 'none';
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

// Acciones de IA
function requestAutoReview(url) {
    const alert = alertStore.get(url);
    if (!alert) return;
    aiModalTitle.textContent = `🔍 Review IA: ${alert.title}`;
    aiModalBody.textContent = '🤖 Analizando diff del PR con Gemini AI Studio...\n\n(Criterios: Seguridad, Rendimiento, Clean Code y Cobertura)';
    aiModal.style.display = 'flex';
    ipcRenderer.send('request-auto-review', alert);
}
window.requestAutoReview = requestAutoReview;

function closeAIModal() {
    aiModal.style.display = 'none';
}
window.closeAIModal = closeAIModal;

function copyAIReview() {
    if (currentAIReviewText) {
        clipboard.writeText(currentAIReviewText);
        const originalText = aiModalTitle.textContent;
        aiModalTitle.textContent = '✅ ¡Copiado al portapapeles!';
        setTimeout(() => { aiModalTitle.textContent = originalText; }, 1500);
    }
}
window.copyAIReview = copyAIReview;

ipcRenderer.on('auto-review-result', (event, result) => {
    if (result.success) {
        currentAIReviewText = result.review;
        aiModalBody.textContent = result.review;
    } else {
        aiModalBody.textContent = `❌ Error al generar revisión: ${result.error || 'Ocurrió un error inesperado.'}`;
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

    // Botones de acción IA
    const actions = document.createElement('div');
    actions.className = 'alert-actions';

    const reviewBtn = document.createElement('button');
    reviewBtn.className = 'btn-action-ai';
    reviewBtn.innerHTML = '<span>🤖</span> Auto-Review';
    reviewBtn.addEventListener('click', () => requestAutoReview(alertKey(a)));
    actions.appendChild(reviewBtn);

    if (a.has_conflict) {
        const conflictBtn = document.createElement('button');
        conflictBtn.className = 'btn-action-ai';
        conflictBtn.style.color = '#b91c1c';
        conflictBtn.style.borderColor = '#fca5a5';
        conflictBtn.style.background = '#fef2f2';
        conflictBtn.innerHTML = '<span>🔀</span> Conflictos';
        conflictBtn.addEventListener('click', () => requestAutoReview(alertKey(a)));
        actions.appendChild(conflictBtn);
    }

    item.appendChild(actions);
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

// Configuración de Prompts e IA
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

ipcRenderer.on('ai-templates-data', (event, templates) => {
    document.getElementById('tpl-review').value = templates.review_prompt_template || '';
    document.getElementById('tpl-autofix').value = templates.autofix_commit_template || '';
    document.getElementById('tpl-conflict').value = templates.merge_conflict_template || '';
    document.getElementById('tpl-autopilot').value = templates.autoreview_eval_template || '';
});

function saveAITemplates() {
    const templates = {
        review_prompt_template: document.getElementById('tpl-review').value,
        autofix_commit_template: document.getElementById('tpl-autofix').value,
        merge_conflict_template: document.getElementById('tpl-conflict').value,
        autoreview_eval_template: document.getElementById('tpl-autopilot').value,
    };
    ipcRenderer.send('save-ai-templates', templates);
    const feedback = document.getElementById('ai-save-feedback');
    feedback.style.display = 'block';
    setTimeout(() => { feedback.style.display = 'none'; }, 2000);
}
window.saveAITemplates = saveAITemplates;

function resetAITemplates() {
    ipcRenderer.send('reset-ai-templates');
    const feedback = document.getElementById('ai-save-feedback');
    feedback.textContent = '🔄 Valores por defecto restaurados';
    feedback.style.display = 'block';
    setTimeout(() => {
        feedback.textContent = '✅ Prompts guardados correctamente';
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
