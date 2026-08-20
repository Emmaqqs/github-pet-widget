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
const badge = document.getElementById('badge');
const dragHandle = document.getElementById('drag-handle');
const body = document.body;

let isBubbleVisible = true;
let prevTotalAlerts = -1;

// ── SA1: Arrastre libre ───────────────────────────────────────────────────────
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

dragHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.screenX - dragStartX;
    const deltaY = e.screenY - dragStartY;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    ipcRenderer.send('drag-move', { deltaX, deltaY });
});

document.addEventListener('mouseup', () => { isDragging = false; });

// ── Mascota ───────────────────────────────────────────────────────────────────
pet.addEventListener('click', () => {
    isBubbleVisible = !isBubbleVisible;
    bubble.style.display = isBubbleVisible ? 'block' : 'none';
});

pet.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ipcRenderer.send('show-context-menu');
});

// ── Badge y animación ─────────────────────────────────────────────────────────
function updateBadge(count) {
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

function triggerAlertAnimation() {
    pet.classList.remove('anim-bounce', 'anim-new-alert');
    void pet.offsetWidth;
    pet.classList.add('anim-new-alert');
    setTimeout(() => {
        pet.classList.remove('anim-new-alert');
        pet.classList.add('anim-bounce');
    }, 800);
}

// ── SA2: Marcar como Visto — respuesta instantánea en DOM ────────────────────
function markSeen(url, updatedAt, btn) {
    // Eliminar item del DOM de inmediato sin esperar la API
    const item = btn ? btn.closest('.alert-item') : null;
    if (item) {
        item.style.transition = 'opacity 0.25s, max-height 0.3s, padding 0.3s, margin 0.3s';
        item.style.overflow = 'hidden';
        item.style.opacity = '0';
        item.style.maxHeight = item.offsetHeight + 'px';
        setTimeout(() => {
            item.style.maxHeight = '0';
            item.style.padding = '0';
            item.style.marginBottom = '0';
            setTimeout(() => {
                item.remove();
                // Recalcular estado después de eliminar
                const remaining = alertsList.querySelectorAll('.alert-item').length;
                prevTotalAlerts = Math.max(0, remaining);
                updateBadge(remaining);
                if (remaining === 0) {
                    // Limpiar títulos de sección vacíos y mostrar "Todo al día"
                    alertsList.innerHTML = '<div style="padding:8px 0; color:#10b981; font-weight:600;">✨ ¡Todo al día! Sin pendientes.</div>';
                    body.className = 'state-happy';
                }
            }, 300);
        }, 50);
    }
    // Persistir en disco (sin updateStatus para evitar lag)
    ipcRenderer.send('mark-seen', { url, updatedAt });
}
window.markSeen = markSeen;

function buildAlertItem(a) {
    const safeUrl = a.url.replace(/'/g, '%27');
    const safeUpdatedAt = (a.updated_at || '').replace(/'/g, '');
    const stateHtml = a.state
        ? `<span style="font-size:10px; color:#57606a; display:block; margin-top:2px;">${a.state}</span>`
        : '';
    return `<div class="alert-item">
        <button class="btn-seen" onclick="markSeen('${safeUrl}','${safeUpdatedAt}',this)">✓ Visto</button>
        <a href="#" onclick="openURL('${safeUrl}')">${a.title}</a>
        ${stateHtml}
    </div>`;
}

// ── Historial de tokens ───────────────────────────────────────────────────────
function renderTokenHistory(history) {
    if (!history || history.length === 0) {
        tokenHistoryList.style.display = 'none';
        return;
    }
    tokenHistoryList.style.display = 'block';
    tokenChips.innerHTML = history.map(h =>
        `<button class="token-chip" title="${h.token}" onclick="useToken('${h.token}')">@${h.username}</button>`
    ).join('');
}

function useToken(token) {
    tokenInput.value = token;
    saveToken();
}
window.useToken = useToken;

ipcRenderer.on('token-history', (event, history) => {
    renderTokenHistory(history);
});

// ── Utilidades ────────────────────────────────────────────────────────────────
function openURL(url) { shell.openExternal(url); }
window.openURL = openURL;

function openTokenHelp() {
    shell.openExternal('https://github.com/settings/tokens/new?scopes=repo,read:user&description=GitHub%20Pet%20Widget');
}
window.openTokenHelp = openTokenHelp;

function saveToken() {
    const token = tokenInput.value.trim();
    if (!token) { showError("Por favor ingresa un token válido."); return; }
    authErrorMsg.style.display = 'none';
    document.getElementById('save-token-btn').textContent = "Verificando...";
    ipcRenderer.send('set-token', token);
}
window.saveToken = saveToken;

function showSettings() {
    alertsSection.style.display = 'none';
    authSection.style.display = 'block';
    authErrorMsg.style.display = 'none';
    document.getElementById('save-token-btn').textContent = "Guardar y Conectar";
    // Pedir historial de tokens al proceso principal
    ipcRenderer.send('get-token-history');
}
window.showSettings = showSettings;

function showError(msg) {
    authErrorMsg.textContent = msg;
    authErrorMsg.style.display = 'block';
    document.getElementById('save-token-btn').textContent = "Guardar y Conectar";
    body.className = 'state-disconnected';
}

// ── IPC desde main ────────────────────────────────────────────────────────────
ipcRenderer.on('show-settings', () => showSettings());
ipcRenderer.on('always-on-top-state', () => { /* reservado */ });

ipcRenderer.on('auth-success', (event, { username, tokenHistory }) => {
    authSection.style.display = 'none';
    alertsSection.style.display = 'block';
    userHeader.textContent = `👤 @${username}`;
    if (tokenHistory) renderTokenHistory(tokenHistory);
});

ipcRenderer.on('auth-error', (event, error) => { showError(error); });

ipcRenderer.on('status-update', (event, alerts) => {
    let totalAlerts = 0;
    let html = '';

    if (alerts.review_required && alerts.review_required.length > 0) {
        html += '<div class="section-title title-review">⏳ Revisión Requerida</div>';
        alerts.review_required.forEach(a => { html += buildAlertItem(a); totalAlerts++; });
        body.className = 'state-alert';
    }

    if (alerts.re_review_needed && alerts.re_review_needed.length > 0) {
        html += '<div class="section-title title-rereview">🔄 Re-revisión Pendiente</div>';
        alerts.re_review_needed.forEach(a => { html += buildAlertItem(a); totalAlerts++; });
        if (body.className !== 'state-alert') body.className = 'state-rereview';
    }

    if (alerts.my_pr_activity && alerts.my_pr_activity.length > 0) {
        html += '<div class="section-title title-action">⚡ Actividad en tus PRs</div>';
        alerts.my_pr_activity.forEach(a => { html += buildAlertItem(a); totalAlerts++; });
        if (body.className === 'state-happy' || body.className === 'state-disconnected') {
            body.className = 'state-action';
        }
    }

    if (totalAlerts === 0) {
        alertsList.innerHTML = '<div style="padding:8px 0; color:#10b981; font-weight:600;">✨ ¡Todo al día! Sin pendientes.</div>';
        body.className = 'state-happy';
    } else {
        alertsList.innerHTML = html;
    }

    if (prevTotalAlerts >= 0 && totalAlerts > prevTotalAlerts) {
        triggerAlertAnimation();
    }
    prevTotalAlerts = totalAlerts;
    updateBadge(totalAlerts);
});

tokenInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveToken(); });
