const { ipcRenderer, shell } = require('electron');

const bubble = document.getElementById('bubble');
const alertsSection = document.getElementById('alerts-section');
const alertsList = document.getElementById('alerts-list');
const userHeader = document.getElementById('user-header');
const authSection = document.getElementById('auth-section');
const tokenInput = document.getElementById('token-input');
const authErrorMsg = document.getElementById('auth-error-msg');
const tokenHistoryList = document.getElementById('token-history-list');
const tokenChips = document.getElementById('token-chips');
const pet = document.getElementById('pet');
const petContainer = document.getElementById('pet-container');
const badge = document.getElementById('badge');
const body = document.body;

let isBubbleVisible = true;
let prevTotalAlerts = -1;
let alertFilter = 'active';
const alertStore = new Map();
const viewedAt = new Map();

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function alertKey(a) { return String(a.url || a.title || ''); }
function isViewed(a) {
    const seen = viewedAt.get(alertKey(a));
    return Boolean(seen && new Date(a.updated_at || 0) <= new Date(seen));
}

// La mascota completa es el área de arrastre; el encabezado ya no es un handle exclusivo.
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
    if (e.button !== 0) return;
    if (e.isPrimary === false) return;
    isDragging = true;
    didDrag = false;
    activePointerId = e.pointerId ?? null;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    ipcRenderer.send('drag-start', { screenX: e.screenX, screenY: e.screenY });
    if (activePointerId !== null && typeof petContainer.setPointerCapture === 'function') {
        try { petContainer.setPointerCapture(activePointerId); } catch (_) {}
    }
    e.preventDefault();
});
document.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - dragStartClientX;
    const deltaY = e.clientY - dragStartClientY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 2) didDrag = true;
    ipcRenderer.send('drag-move', { screenX: e.screenX, screenY: e.screenY });
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

function sendSeen(url, updatedAt) { ipcRenderer.send('mark-seen', { url, updatedAt }); }

function markSeen(url, updatedAt, btn) {
    viewedAt.set(url, updatedAt || new Date().toISOString());
    sendSeen(url, updatedAt || new Date().toISOString());
    renderAlerts();
}
function markUnseen(url, updatedAt) {
    viewedAt.delete(url);
    // El timestamp antiguo hace que el próximo sondeo vuelva a reportar el PR.
    ipcRenderer.send('mark-unseen', { url });
    renderAlerts();
}
window.markSeen = markSeen;
window.markUnseen = markUnseen;

function openURL(url) { shell.openExternal(url); }
window.openURL = openURL;

function createAlertItem(a, viewed) {
    const item = document.createElement('div');
    item.className = 'alert-item';
    item.dataset.url = alertKey(a);

    const button = document.createElement('button');
    button.className = viewed ? 'btn-seen btn-unseen' : 'btn-seen';
    button.textContent = viewed ? '↩ No visto' : '✓ Visto';
    button.addEventListener('click', () => viewed
        ? markUnseen(alertKey(a), a.updated_at)
        : markSeen(alertKey(a), a.updated_at, button));

    const link = document.createElement('a');
    link.href = '#';
    link.textContent = a.title || 'Pull Request sin título';
    link.title = a.title || '';
    link.addEventListener('click', (e) => { e.preventDefault(); openURL(a.url); });

    item.append(button, link);
    if (a.state) {
        const detail = document.createElement('span');
        detail.className = 'alert-detail';
        detail.textContent = a.state;
        item.appendChild(detail);
    }
    return item;
}

const sections = [
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
    alertsSection.style.display = 'none'; authSection.style.display = 'block';
    authErrorMsg.style.display = 'none';
    document.getElementById('save-token-btn').textContent = 'Guardar y Conectar';
    ipcRenderer.send('get-token-history');
}
window.showSettings = showSettings;
function showError(msg) {
    authErrorMsg.textContent = msg; authErrorMsg.style.display = 'block';
    document.getElementById('save-token-btn').textContent = 'Guardar y Conectar';
    body.className = 'state-disconnected';
}

ipcRenderer.on('show-settings', () => showSettings());
ipcRenderer.on('always-on-top-state', () => {});
ipcRenderer.on('auth-success', (event, { username, tokenHistory }) => {
    authSection.style.display = 'none'; alertsSection.style.display = 'block';
    userHeader.textContent = `👤 @${username}`;
    if (tokenHistory) renderTokenHistory(tokenHistory);
});
ipcRenderer.on('auth-error', (event, error) => showError(error));

ipcRenderer.on('status-update', (event, alerts) => {
    const incoming = [];
    sections.forEach(([type]) => (alerts[type] || []).forEach(a => incoming.push({ ...a, type })));
    const incomingKeys = new Set(incoming.map(alertKey));
    // GitHub deja de devolver PRs resueltos/cerrados; no los mantengas como pendientes.
    [...alertStore.keys()].forEach(key => {
        if (!incomingKeys.has(key) && !viewedAt.has(key)) alertStore.delete(key);
    });
    incoming.forEach(a => alertStore.set(alertKey(a), a));

    const active = incoming.filter(a => !isViewed(a));
    const priority = active.some(a => a.type === 'my_pr_activity') ? 'state-action'
        : active.some(a => a.type === 're_review_needed') ? 'state-rereview'
        : active.some(a => a.type === 'review_required') ? 'state-alert' : 'state-happy';
    body.className = priority;
    renderAlerts();
    if (prevTotalAlerts >= 0 && active.length > prevTotalAlerts) triggerAlertAnimation();
    if (active.length === 0) triggerHappyAnimation();
    prevTotalAlerts = active.length;
});

tokenInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveToken(); });
