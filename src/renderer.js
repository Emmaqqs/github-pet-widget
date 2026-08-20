const { ipcRenderer, shell } = require('electron');

const bubble = document.getElementById('bubble');
const alertsSection = document.getElementById('alerts-section');
const logsSection = document.getElementById('logs-section');
const aiSettingsSection = document.getElementById('ai-settings-section');
const authSection = document.getElementById('auth-section');

const alertsList = document.getElementById('alerts-list');
const logsList = document.getElementById('logs-list');
const userHeader = document.getElementById('user-header');
const tokenInput = document.getElementById('token-input');
const authErrorMsg = document.getElementById('auth-error-msg');
const tokenHistoryList = document.getElementById('token-history-list');
const tokenChips = document.getElementById('token-chips');
const pet = document.getElementById('pet');
const badge = document.getElementById('badge');
const toastMsg = document.getElementById('toast-msg');
const body = document.body;

const chkAutopilot = document.getElementById('chk-autopilot');
const selDaysThreshold = document.getElementById('sel-days-threshold');
const chkRecentOnly = document.getElementById('chk-recent-only');
const chkShowWaiting = document.getElementById('chk-show-waiting');
const chkShowViewed = document.getElementById('chk-show-viewed');

let isBubbleVisible = true;
let prevTotalAlerts = -1;
let currentCategoryFilter = 'all';
let daysThreshold = 7;
const alertStore = new Map();
const viewedAt = new Map();
let actionLogs = [];
let toastTimer = null;

function showToast(text, isError = false) {
    if (toastTimer) clearTimeout(toastTimer);
    toastMsg.textContent = text;
    toastMsg.style.display = 'block';
    toastMsg.style.background = isError ? '#991b1b' : '#0f172a';
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

// =========================================================================
// ARRASTRE FLUIDO DE LA MASCOTA Y TOGGLE CON CLIC
// =========================================================================

let isDraggingPet = false;
let petDragStartX = 0;
let petDragStartY = 0;

pet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isDraggingPet = false;
    petDragStartX = e.screenX;
    petDragStartY = e.screenY;
    ipcRenderer.send('start-window-drag', { x: Math.round(e.screenX), y: Math.round(e.screenY) });
    
    const onPointerMove = (moveEv) => {
        const dist = Math.hypot(moveEv.screenX - petDragStartX, moveEv.screenY - petDragStartY);
        if (dist > 3) {
            isDraggingPet = true;
            ipcRenderer.send('window-drag-move', { screenX: Math.round(moveEv.screenX), screenY: Math.round(moveEv.screenY) });
        }
    };

    const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        if (!isDraggingPet) {
            isBubbleVisible = !isBubbleVisible;
            if (isBubbleVisible) bubble.classList.remove('hidden');
            else bubble.classList.add('hidden');
        }
        ipcRenderer.send('end-window-drag');
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
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
// FILTROS AVANZADOS (CATEGORÍAS, 7 DÍAS, EN ESPERA, VISTOS)
// =========================================================================

function setCategoryFilter(filter) {
    currentCategoryFilter = filter;
    document.querySelectorAll('.filter-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderAlerts();
}
window.setCategoryFilter = setCategoryFilter;

function toggleRecentOnly() { renderAlerts(); }
window.toggleRecentOnly = toggleRecentOnly;

function toggleShowWaiting() { renderAlerts(); }
window.toggleShowWaiting = toggleShowWaiting;

function toggleShowViewed() { renderAlerts(); }
window.toggleShowViewed = toggleShowViewed;

// =========================================================================
// ACCIONES 1-CLICK AUTÓNOMAS CON OPENAI LUNA Y WORKTREES
// =========================================================================

function triggerAutoReview(url, btn) {
    const alert = alertStore.get(url);
    if (!alert) return;
    btn.disabled = true;
    btn.textContent = '⚙️ Publicando...';
    body.className = 'state-working';
    showToast(`🤖 Generando revisión con OpenAI Luna para PR #${alert.number}...`);
    ipcRenderer.send('execute-auto-review', alert);
}

function triggerAutoFixFeedback(url, btn) {
    const alert = alertStore.get(url);
    if (!alert) return;
    btn.disabled = true;
    btn.textContent = '⚙️ Aplicando Fix...';
    body.className = 'state-working';
    showToast(`⚡ Creando worktree y aplicando fix con OpenAI Luna para PR #${alert.number}...`);
    ipcRenderer.send('execute-autofix-worktree', alert);
}

function triggerMergeConflictResolution(url, btn) {
    const alert = alertStore.get(url);
    if (!alert) return;
    btn.disabled = true;
    btn.textContent = '⚙️ Resolviendo...';
    body.className = 'state-working';
    showToast(`🔀 Resolviendo conflictos en worktree para PR #${alert.number}...`);
    ipcRenderer.send('execute-merge-conflict-worktree', alert);
}

ipcRenderer.on('action-progress', (event, { text }) => {
    showToast('⏳ ' + text);
});

ipcRenderer.on('action-completed', (event, result) => {
    if (result.success) {
        showToast(result.message || '🚀 ¡Tarea completada y pusheada con éxito!');
        triggerHappyAnimation();
    } else {
        showToast('❌ ' + (result.error || result.message || 'Error en la acción.'), true);
    }
    renderAlerts();
});

// =========================================================================
// RENDERIZADO DE TARJETAS CON ETIQUETAS MÚLTIPLES E HISTORIAL INDIVIDUAL
// =========================================================================

function createAlertCard(a, viewed) {
    const card = document.createElement('div');
    card.className = 'alert-card';
    card.dataset.url = alertKey(a);

    // Fila Superior (Repo y Tiempo)
    const topRow = document.createElement('div');
    topRow.className = 'card-top';

    const repoBadge = document.createElement('span');
    repoBadge.className = 'repo-badge';
    repoBadge.textContent = a.repository || 'repo';
    repoBadge.title = a.repository || '';

    const timeBadge = document.createElement('span');
    timeBadge.className = 'time-badge';
    timeBadge.textContent = a.days_ago === 0 ? 'hoy' : `hace ${a.days_ago}d`;

    topRow.append(repoBadge, timeBadge);
    card.appendChild(topRow);

    // Título Clickable
    const titleLink = document.createElement('a');
    titleLink.className = 'card-title';
    titleLink.href = '#';
    titleLink.textContent = a.title || 'Pull Request sin título';
    titleLink.title = a.title || '';
    titleLink.addEventListener('click', (e) => { e.preventDefault(); openURL(a.url); });
    card.appendChild(titleLink);

    // Fila de Etiquetas Múltiples (Multi-Tags)
    const tagsRow = document.createElement('div');
    tagsRow.className = 'card-tags';
    const tags = a.tags || [];

    if (tags.includes('conflict')) {
        const t = document.createElement('span');
        t.className = 'tag-badge tag-conflict';
        t.innerHTML = '💥 Conflictos';
        tagsRow.appendChild(t);
    }
    if (tags.includes('resolved')) {
        const t = document.createElement('span');
        t.className = 'tag-badge tag-resolved';
        t.innerHTML = '✅ Resuelto por IA';
        tagsRow.appendChild(t);
    }
    if (tags.includes('feedback')) {
        const t = document.createElement('span');
        t.className = 'tag-badge tag-feedback';
        t.innerHTML = '💬 Feedback pendiente';
        tagsRow.appendChild(t);
    }
    if (tags.includes('waiting')) {
        const t = document.createElement('span');
        t.className = 'tag-badge tag-waiting';
        t.innerHTML = '⏳ En espera';
        tagsRow.appendChild(t);
    }
    if (tags.includes('review')) {
        const t = document.createElement('span');
        t.className = 'tag-badge tag-review';
        t.innerHTML = '⏳ Revisión pedida';
        tagsRow.appendChild(t);
    }
    if (tagsRow.children.length > 0) {
        card.appendChild(tagsRow);
    }

    // Estado / Detalle
    if (a.state) {
        const stateEl = document.createElement('div');
        stateEl.className = 'card-state';
        stateEl.textContent = a.state;
        card.appendChild(stateEl);
    }

    // Historial desplegable por PR
    const historyBox = document.createElement('div');
    historyBox.className = 'pr-history-box';
    const timeline = a.historyTimeline || [];
    if (timeline.length > 0) {
        timeline.forEach(ev => {
            const h = document.createElement('div');
            h.className = 'history-event';
            const d = new Date(ev.date);
            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            h.innerHTML = `<strong>@${escapeHtml(ev.user)}</strong> (${time}): ${escapeHtml(ev.bodyExcerpt || ev.state || ev.type)}`;
            historyBox.appendChild(h);
        });
    } else {
        historyBox.innerHTML = '<div style="color: #94a3b8;">Sin eventos recientes registrados.</div>';
    }
    card.appendChild(historyBox);

    // Acciones y Botón de Historial
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    if (a.has_conflict) {
        const btn = document.createElement('button');
        btn.className = 'btn-action-ai btn-action-conflict';
        btn.innerHTML = '<span>🔀</span> Resolver & Push';
        btn.addEventListener('click', () => triggerMergeConflictResolution(alertKey(a), btn));
        actions.appendChild(btn);
    }

    if (tags.includes('feedback') && a.requires_fix) {
        const btn = document.createElement('button');
        btn.className = 'btn-action-ai';
        btn.innerHTML = '<span>⚡</span> Auto-Fix & Push';
        btn.addEventListener('click', () => triggerAutoFixFeedback(alertKey(a), btn));
        actions.appendChild(btn);
    }

    if (tags.includes('review')) {
        const btn = document.createElement('button');
        btn.className = 'btn-action-ai';
        btn.innerHTML = '<span>🤖</span> Revisar & Publicar';
        btn.addEventListener('click', () => triggerAutoReview(alertKey(a), btn));
        actions.appendChild(btn);
    }

    const histToggle = document.createElement('button');
    histToggle.className = 'btn-history-toggle';
    histToggle.textContent = '📜 Historial';
    histToggle.addEventListener('click', () => {
        historyBox.classList.toggle('open');
        histToggle.textContent = historyBox.classList.contains('open') ? '▲ Ocultar' : '📜 Historial';
    });
    actions.appendChild(histToggle);

    const seenBtn = document.createElement('button');
    seenBtn.className = 'btn-seen-toggle';
    seenBtn.textContent = viewed ? '↩ No visto' : '✓ Visto';
    seenBtn.addEventListener('click', () => viewed
        ? markUnseen(alertKey(a))
        : markSeen(alertKey(a), a.latest_activity_at || a.updated_at));
    actions.appendChild(seenBtn);

    card.appendChild(actions);
    return card;
}

function renderAlerts() {
    alertsList.replaceChildren();
    const showViewed = chkShowViewed.checked;
    const showWaiting = chkShowWaiting.checked;
    const recentOnly = chkRecentOnly.checked;

    let items = [...alertStore.values()];

    // 1. Filtro de Vistos
    items = items.filter(a => showViewed ? isViewed(a) : !isViewed(a));

    // 2. Filtro de 7 Días
    if (recentOnly) {
        items = items.filter(a => (a.days_ago || 0) <= daysThreshold);
    }

    // 3. Filtro de "En Espera"
    if (!showWaiting && currentCategoryFilter !== 'all' && currentCategoryFilter !== 'resolved') {
        items = items.filter(a => !a.is_waiting_only);
    } else if (!showWaiting && currentCategoryFilter === 'all') {
        // En "Todos", muestra todo lo que tenga acción o esté resuelto
        items = items.filter(a => !a.is_waiting_only || a.has_conflict || (a.tags && a.tags.includes('resolved')));
    }

    // 4. Filtro por Categoría con Multi-Tags
    if (currentCategoryFilter === 'conflict') {
        items = items.filter(a => a.tags && a.tags.includes('conflict'));
    } else if (currentCategoryFilter === 'feedback') {
        items = items.filter(a => a.tags && a.tags.includes('feedback'));
    } else if (currentCategoryFilter === 'review') {
        items = items.filter(a => a.tags && a.tags.includes('review'));
    } else if (currentCategoryFilter === 'resolved') {
        items = items.filter(a => a.tags && a.tags.includes('resolved'));
    }

    if (items.length === 0) {
        alertsList.innerHTML = showViewed
            ? '<div class="empty-state">No hay alertas en vistos.</div>'
            : '<div class="empty-state happy">✨ ¡Todo al día! Sin pendientes.</div>';
    } else {
        items.forEach(a => alertsList.appendChild(createAlertCard(a, showViewed)));
    }

    const actionableCount = [...alertStore.values()].filter(a => 
        !isViewed(a) && 
        !(a.tags && a.tags.includes('resolved')) && 
        !a.is_waiting_only
    ).length;
    updateBadge(actionableCount);
}

function refreshStatus() {
    const btn = document.getElementById('btn-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    ipcRenderer.send('refresh-status');
    setTimeout(() => {
        if (btn) { btn.disabled = false; btn.textContent = '↻'; }
    }, 1500);
}
window.refreshStatus = refreshStatus;

// =========================================================================
// HISTORIAL DE ACCIONES IA GENERAL
// =========================================================================

function showActionLogs() {
    alertsSection.style.display = 'none';
    aiSettingsSection.style.display = 'none';
    authSection.style.display = 'none';
    logsSection.style.display = 'flex';
    ipcRenderer.send('get-action-logs');
}
window.showActionLogs = showActionLogs;

function clearActionLogs() {
    ipcRenderer.send('clear-action-logs');
}
window.clearActionLogs = clearActionLogs;

function renderLogs(logs) {
    actionLogs = logs || [];
    logsList.replaceChildren();
    if (actionLogs.length === 0) {
        logsList.innerHTML = '<div class="empty-state">No hay acciones registradas aún.</div>';
        return;
    }
    actionLogs.forEach(l => {
        const item = document.createElement('div');
        item.className = 'log-item';
        const d = new Date(l.timestamp);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        item.innerHTML = `
            <div class="log-top">
                <span>${escapeHtml(l.actionType || 'Acción')}</span>
                <span style="font-size: 8.5px; color: #94a3b8;">${timeStr}</span>
            </div>
            <div class="log-msg">${escapeHtml(l.repository)} #${l.prNumber}: ${escapeHtml(l.message || '')}</div>
        `;
        logsList.appendChild(item);
    });
}

ipcRenderer.on('action-logs-data', (event, logs) => renderLogs(logs));

// =========================================================================
// NAVEGACIÓN Y AJUSTES
// =========================================================================

function showAlertsView() {
    logsSection.style.display = 'none';
    aiSettingsSection.style.display = 'none';
    authSection.style.display = 'none';
    alertsSection.style.display = 'flex';
}
window.showAlertsView = showAlertsView;

function showAISettings() {
    alertsSection.style.display = 'none';
    logsSection.style.display = 'none';
    authSection.style.display = 'none';
    aiSettingsSection.style.display = 'flex';
    ipcRenderer.send('get-ai-templates');
}
window.showAISettings = showAISettings;

function showSettings() {
    alertsSection.style.display = 'none';
    logsSection.style.display = 'none';
    aiSettingsSection.style.display = 'none';
    authSection.style.display = 'flex';
    authErrorMsg.style.display = 'none';
    ipcRenderer.send('get-token-history');
}
window.showSettings = showSettings;

ipcRenderer.on('ai-templates-data', (event, { templates, autopilot_enabled, days_threshold }) => {
    document.getElementById('tpl-review').value = templates.review_prompt_template || '';
    document.getElementById('tpl-autofix').value = templates.autofix_commit_template || '';
    document.getElementById('tpl-conflict').value = templates.merge_conflict_template || '';
    chkAutopilot.checked = Boolean(autopilot_enabled);
    if (days_threshold) {
        daysThreshold = Number(days_threshold);
        selDaysThreshold.value = String(days_threshold);
    }
});

ipcRenderer.on('days-threshold', (event, days) => {
    daysThreshold = Number(days) || 7;
    selDaysThreshold.value = String(daysThreshold);
    renderAlerts();
});

function saveAISettings() {
    const payload = {
        templates: {
            review_prompt_template: document.getElementById('tpl-review').value,
            autofix_commit_template: document.getElementById('tpl-autofix').value,
            merge_conflict_template: document.getElementById('tpl-conflict').value,
        },
        autopilot_enabled: chkAutopilot.checked,
        days_threshold: Number(selDaysThreshold.value) || 7
    };
    daysThreshold = payload.days_threshold;
    ipcRenderer.send('save-ai-templates', payload);
    const feedback = document.getElementById('ai-save-feedback');
    feedback.style.display = 'block';
    setTimeout(() => { feedback.style.display = 'none'; }, 2000);
}
window.saveAISettings = saveAISettings;

function resetAITemplates() {
    ipcRenderer.send('reset-ai-templates');
}
window.resetAITemplates = resetAITemplates;

function renderTokenHistory(history) {
    if (!history || history.length === 0) { tokenHistoryList.style.display = 'none'; return; }
    tokenHistoryList.style.display = 'block';
    tokenChips.replaceChildren();
    history.forEach(h => {
        const btn = document.createElement('button');
        btn.className = 'filter-pill';
        btn.style.fontSize = '9px';
        btn.textContent = `@${h.username}`;
        btn.addEventListener('click', () => { tokenInput.value = h.token; saveToken(); });
        tokenChips.appendChild(btn);
    });
}
ipcRenderer.on('token-history', (event, history) => renderTokenHistory(history));
ipcRenderer.on('seen-prs', (event, seen) => {
    viewedAt.clear();
    Object.entries(seen || {}).forEach(([url, timestamp]) => viewedAt.set(url, timestamp));
    renderAlerts();
});

function saveToken() {
    const token = tokenInput.value.trim();
    if (!token) {
        authErrorMsg.textContent = 'Por favor ingresa un token válido.';
        authErrorMsg.style.display = 'block';
        return;
    }
    authErrorMsg.style.display = 'none';
    document.getElementById('save-token-btn').textContent = 'Verificando...';
    ipcRenderer.send('set-token', token);
}
window.saveToken = saveToken;

ipcRenderer.on('auth-success', (event, { username, tokenHistory }) => {
    showAlertsView();
    userHeader.textContent = `👤 @${username}`;
    if (tokenHistory) renderTokenHistory(tokenHistory);
});
ipcRenderer.on('auth-error', (event, error) => {
    authErrorMsg.textContent = error;
    authErrorMsg.style.display = 'block';
    document.getElementById('save-token-btn').textContent = 'Guardar y Conectar';
    body.className = 'state-disconnected';
});

ipcRenderer.on('show-settings', () => showSettings());
ipcRenderer.on('show-ai-settings', () => showAISettings());
ipcRenderer.on('show-action-logs', () => showActionLogs());

ipcRenderer.on('status-update', (event, alerts) => {
    const incoming = alerts.all_prs || [];
    const incomingKeys = new Set(incoming.map(alertKey));
    
    [...alertStore.keys()].forEach(key => {
        if (!incomingKeys.has(key) && !viewedAt.has(key)) alertStore.delete(key);
    });
    incoming.forEach(a => alertStore.set(alertKey(a), a));

    const active = incoming.filter(a => !isViewed(a) && !(a.tags && a.tags.includes('resolved')) && !a.is_waiting_only);
    const priority = active.some(a => a.tags && a.tags.includes('conflict')) ? 'state-conflict'
        : active.some(a => a.tags && a.tags.includes('feedback')) ? 'state-action'
        : active.some(a => a.tags && a.tags.includes('review')) ? 'state-alert' : 'state-happy';
    body.className = priority;
    renderAlerts();
    if (prevTotalAlerts >= 0 && active.length > prevTotalAlerts) triggerAlertAnimation();
    if (active.length === 0) triggerHappyAnimation();
    prevTotalAlerts = active.length;
});

tokenInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveToken(); });
