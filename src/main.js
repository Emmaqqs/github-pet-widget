const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const GitHubService = require('./github_service');
const WorktreeService = require('./worktree_service');
const { AIService, DEFAULT_REVIEW_PROMPT_TEMPLATE, DEFAULT_AUTOFIX_COMMIT_TEMPLATE, DEFAULT_MERGE_CONFLICT_TEMPLATE } = require('./ai_service');

let mainWindow;
let github = null;
let aiService = null;
let worktreeService = null;
let currentToken = null;
let pollTimer = null;
let alwaysOnTop = true;
let savePositionTimer = null;
const autoPilotProcessing = new Set();

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error("Error reading config:", e);
    }
    return {};
}

function saveConfig(data) {
    try {
        const current = loadConfig();
        const updated = { ...current, ...data };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
        return updated;
    } catch (e) {
        console.error("Error saving config:", e);
        return loadConfig();
    }
}

function addActionLog(entry) {
    const cfg = loadConfig();
    const logs = cfg.action_logs || [];
    logs.unshift({
        id: 'log_' + Date.now(),
        timestamp: new Date().toISOString(),
        ...entry
    });
    saveConfig({ action_logs: logs.slice(0, 50) });
    mainWindow?.webContents.send('action-logs-data', logs.slice(0, 50));
}

function markPRAsResolved(url, actionType, details = '') {
    const cfg = loadConfig();
    const resolved = cfg.resolved_prs || {};
    resolved[url] = {
        resolvedAt: new Date().toISOString(),
        actionType,
        details
    };
    saveConfig({ resolved_prs: resolved });
}

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea || {
        x: 0,
        y: 0,
        ...primaryDisplay.workAreaSize
    };
    const { x: workAreaX = 0, y: workAreaY = 0, width, height } = workArea;
    const config = loadConfig();

    const winX = typeof config.x === 'number' ? config.x : workAreaX + width - 340;
    const winY = typeof config.y === 'number' ? config.y : workAreaY + height - 400;
    alwaysOnTop = config.alwaysOnTop !== false;

    mainWindow = new BrowserWindow({
        width: 330,
        height: 420,
        x: winX,
        y: winY,
        frame: false,
        transparent: true,
        alwaysOnTop,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    if (alwaysOnTop) {
        mainWindow.setAlwaysOnTop(true, 'floating');
    }

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    aiService = new AIService(config.ai_templates || {});
    worktreeService = new WorktreeService(aiService, config.token || null);

    mainWindow.on('moved', () => {
        if (savePositionTimer) clearTimeout(savePositionTimer);
        savePositionTimer = setTimeout(() => {
            if (!mainWindow) return;
            const [x, y] = mainWindow.getPosition();
            saveConfig({ x, y });
        }, 500);
    });

    mainWindow.webContents.on('did-finish-load', async () => {
        const saved = loadConfig();
        mainWindow.webContents.send('always-on-top-state', alwaysOnTop);
        mainWindow.webContents.send('seen-prs', saved.seen_prs || {});
        mainWindow.webContents.send('action-logs-data', saved.action_logs || []);
        mainWindow.webContents.send('days-threshold', saved.days_threshold || 7);
        mainWindow.webContents.send('autopilot-config', {
            enabled: Boolean(saved.autopilot_enabled)
        });
        if (saved.token) {
            await initializeWithToken(saved.token);
        }
    });
}

async function initializeWithToken(token) {
    try {
        github = new GitHubService(token);
        const user = await github.verifyUser();

        if (!user) {
            mainWindow.webContents.send('auth-error', 'Token inválido o expirado.');
            return false;
        }

        currentToken = token;
        worktreeService = new WorktreeService(aiService, token);

        const cfg = loadConfig();
        const history = (cfg.token_history || []).filter(h => h.token !== token);
        history.unshift({ token, username: user.login, addedAt: new Date().toISOString() });
        saveConfig({ token, token_history: history.slice(0, 5) });

        mainWindow.webContents.send('auth-success', {
            username: user.login,
            tokenHistory: history.slice(0, 5)
        });

        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(updateStatus, 180000);

        updateStatus();
        return true;
    } catch (error) {
        console.error("Error in init:", error);
        mainWindow.webContents.send('auth-error', error.message || 'Error de conexión.');
        return false;
    }
}

async function runAutoPilotTasks(status) {
    const cfg = loadConfig();
    if (!cfg.autopilot_enabled || !github || !worktreeService) return;

    for (const pr of status.merge_conflicts || []) {
        const key = `conflict_${pr.url}_${pr.updated_at}`;
        if (!autoPilotProcessing.has(key)) {
            autoPilotProcessing.add(key);
            console.log(`[Auto-Pilot] Resolviendo conflictos para PR #${pr.number} en ${pr.repository}...`);
            mainWindow?.webContents.send('action-progress', { text: `Auto-Pilot: Resolviendo PR #${pr.number}...` });
            
            worktreeService.resolveMergeConflictsInWorktree({
                repository: pr.repository,
                pull_number: pr.number,
                head_branch: pr.head_branch,
                base_branch: pr.base_branch || 'main',
                onProgress: (t) => mainWindow?.webContents.send('action-progress', { text: t })
            }).then(res => {
                if (res.pushed) {
                    markPRAsResolved(pr.url, 'Conflictos de Merge', res.message);
                    addActionLog({
                        repository: pr.repository,
                        prNumber: pr.number,
                        actionType: '🔀 Resolver Conflictos (Auto-Pilot)',
                        status: 'SUCCESS',
                        message: `Pusheado a ${pr.head_branch} con tests pasando.`
                    });
                }
                mainWindow?.webContents.send('action-completed', res);
                updateStatus();
            }).catch(e => console.error('[Auto-Pilot] Error en merge:', e));
        }
    }

    for (const pr of status.my_pr_activity || []) {
        if (pr.state && pr.state.includes('Cambios pedidos')) {
            const key = `fix_${pr.url}_${pr.updated_at}`;
            if (!autoPilotProcessing.has(key)) {
                autoPilotProcessing.add(key);
                console.log(`[Auto-Pilot] Auto-Fix para PR #${pr.number} en ${pr.repository}...`);
                mainWindow?.webContents.send('action-progress', { text: `Auto-Pilot: Aplicando fixes a PR #${pr.number}...` });
                
                worktreeService.autoFixReviewFeedbackInWorktree({
                    repository: pr.repository,
                    pull_number: pr.number,
                    head_branch: pr.head_branch,
                    feedbackText: pr.state,
                    onProgress: (t) => mainWindow?.webContents.send('action-progress', { text: t })
                }).then(async (res) => {
                    if (res.pushed) {
                        markPRAsResolved(pr.url, 'Auto-Fix', res.message);
                        const [owner, repo] = pr.repository.split('/');
                        await github.postComment(owner, repo, pr.number, '🤖 *Auto-Pilot: He aplicado las correcciones solicitadas en un worktree y pusheado los cambios con tests pasando.*');
                        addActionLog({
                            repository: pr.repository,
                            prNumber: pr.number,
                            actionType: '⚡ Auto-Fix Feedback (Auto-Pilot)',
                            status: 'SUCCESS',
                            message: `Fixes pusheados a ${pr.head_branch}.`
                        });
                    }
                    mainWindow?.webContents.send('action-completed', res);
                    updateStatus();
                }).catch(e => console.error('[Auto-Pilot] Error en auto-fix:', e));
            }
        }
    }
}

async function updateStatus() {
    if (!github || !mainWindow) return;
    try {
        const cfg = loadConfig();
        const seenPRs = cfg.seen_prs || {};
        const resolvedPRs = cfg.resolved_prs || {};
        const watchedDevs = cfg.watched_devs || {};
        const status = await github.getStatus(seenPRs, true, resolvedPRs, watchedDevs);
        if (status) {
            mainWindow.webContents.send('status-update', status);
            runAutoPilotTasks(status);
        }
    } catch (e) {
        console.error("Polling error:", e);
    }
}

ipcMain.on('set-token', async (event, token) => {
    await initializeWithToken(token);
});

ipcMain.on('refresh-status', () => { updateStatus(); });

ipcMain.on('mark-seen', (event, { url, updatedAt }) => {
    const existing = loadConfig().seen_prs || {};
    saveConfig({ seen_prs: { ...existing, [url]: updatedAt } });
});

ipcMain.on('mark-unseen', (event, { url }) => {
    const existing = loadConfig().seen_prs || {};
    delete existing[url];
    saveConfig({ seen_prs: existing });
});

ipcMain.on('get-seen-prs', (event) => {
    event.reply('seen-prs', loadConfig().seen_prs || {});
});

ipcMain.on('get-token-history', (event) => {
    const history = loadConfig().token_history || [];
    event.reply('token-history', history);
});


// GESTIÓN DE DESARROLLADORES MONITOREADOS POR REPOSITORIO
ipcMain.on('get-accessible-repos', async (event) => {
    if (!github) {
        event.reply('accessible-repos-data', []);
        return;
    }
    const repos = await github.getAccessibleRepositories();
    event.reply('accessible-repos-data', repos);
});

ipcMain.on('get-watched-devs', (event) => {
    const config = loadConfig();
    event.reply('watched-devs-data', config.watched_devs || {});
});

ipcMain.on('save-watched-devs', (event, watchedDevs) => {
    saveConfig({ watched_devs: watchedDevs || {} });
    event.reply('watched-devs-saved', { success: true });
    updateStatus();
});

ipcMain.on('get-action-logs', (event) => {
    const logs = loadConfig().action_logs || [];
    event.reply('action-logs-data', logs);
});

ipcMain.on('clear-action-logs', (event) => {
    saveConfig({ action_logs: [] });
    event.reply('action-logs-data', []);
});

ipcMain.on('save-days-threshold', (event, days) => {
    saveConfig({ days_threshold: Number(days) || 7 });
    event.reply('days-threshold', Number(days) || 7);
});

ipcMain.on('get-ai-templates', (event) => {
    const config = loadConfig();
    const service = new AIService(config.ai_templates || {});
    event.reply('ai-templates-data', {
        templates: service.getTemplates(),
        autopilot_enabled: Boolean(config.autopilot_enabled),
        days_threshold: Number(config.days_threshold) || 7
    });
});

ipcMain.on('save-ai-templates', (event, { templates, autopilot_enabled, days_threshold }) => {
    saveConfig({
        ai_templates: templates,
        autopilot_enabled: Boolean(autopilot_enabled),
        days_threshold: Number(days_threshold) || 7
    });
    if (aiService) aiService.config = templates;
    event.reply('ai-templates-saved', { success: true });
    updateStatus();
});

ipcMain.on('reset-ai-templates', (event) => {
    const defaultTemplates = {
        review_prompt_template: DEFAULT_REVIEW_PROMPT_TEMPLATE,
        autofix_commit_template: DEFAULT_AUTOFIX_COMMIT_TEMPLATE,
        merge_conflict_template: DEFAULT_MERGE_CONFLICT_TEMPLATE,
    };
    saveConfig({ ai_templates: defaultTemplates, autopilot_enabled: false, days_threshold: 7 });
    if (aiService) aiService.config = defaultTemplates;
    event.reply('ai-templates-data', {
        templates: defaultTemplates,
        autopilot_enabled: false,
        days_threshold: 7
    });
});

// 1. Revisar y publicar en GitHub
ipcMain.on('execute-auto-review', async (event, pr) => {
    if (!github || !aiService) {
        event.reply('action-completed', { success: false, error: 'Servicio no inicializado' });
        return;
    }
    try {
        event.reply('action-progress', { text: 'Descargando diff del PR...' });
        const [owner, repo] = (pr.repository || '').split('/');
        const diff = await github.getPullRequestDiff(owner, repo, pr.number);
        
        event.reply('action-progress', { text: 'OpenAI Luna generando revisión...' });
        const reviewText = await aiService.generateCodeReview(pr, diff);
        
        event.reply('action-progress', { text: 'Publicando revisión en GitHub...' });
        const publishResult = await github.submitPullRequestReview(owner, repo, pr.number, reviewText, 'COMMENT');
        
        if (publishResult.success) {
            addActionLog({
                repository: pr.repository,
                prNumber: pr.number,
                actionType: '🤖 Code Review Publicado',
                status: 'SUCCESS',
                message: 'Revisión oficial publicada directamente en GitHub.'
            });
        }

        event.reply('action-completed', {
            success: publishResult.success,
            message: `✅ Review publicado exitosamente en GitHub para PR #${pr.number}!`,
            error: publishResult.error
        });
        updateStatus();
    } catch (err) {
        event.reply('action-completed', { success: false, error: err.message });
    }
});

// 2. Auto-Fix en Worktree + Push
ipcMain.on('execute-autofix-worktree', async (event, pr) => {
    if (!worktreeService) {
        event.reply('action-completed', { success: false, error: 'Worktree service no disponible' });
        return;
    }
    try {
        const result = await worktreeService.autoFixReviewFeedbackInWorktree({
            repository: pr.repository,
            pull_number: pr.number,
            head_branch: pr.head_branch || 'dev',
            feedbackText: pr.state || 'Corregir feedback de revisión',
            onProgress: (statusText) => {
                event.reply('action-progress', { text: statusText });
            }
        });

        if (result.pushed) {
            markPRAsResolved(pr.url, 'Auto-Fix', result.message);
            if (github) {
                const [owner, repo] = (pr.repository || '').split('/');
                await github.postComment(owner, repo, pr.number, '🤖 *He resuelto el feedback de revisión automáticamente en un worktree y pusheado los cambios con tests pasando.*');
            }
            addActionLog({
                repository: pr.repository,
                prNumber: pr.number,
                actionType: '⚡ Auto-Fix Feedback',
                status: 'SUCCESS',
                message: `Fixes aplicados y pusheados a ${pr.head_branch}.`
            });
        }

        event.reply('action-completed', {
            success: result.pushed,
            message: result.message || 'Fix aplicado y pusheado.',
            error: result.error || (result.pushed ? null : 'Tests fallaron; no se hizo push')
        });
        updateStatus();
    } catch (err) {
        event.reply('action-completed', { success: false, error: err.message });
    }
});

// 3. Resolver Conflictos de Merge en Worktree + Push
ipcMain.on('execute-merge-conflict-worktree', async (event, pr) => {
    if (!worktreeService) {
        event.reply('action-completed', { success: false, error: 'Worktree service no disponible' });
        return;
    }
    try {
        const result = await worktreeService.resolveMergeConflictsInWorktree({
            repository: pr.repository,
            pull_number: pr.number,
            head_branch: pr.head_branch || 'dev',
            base_branch: pr.base_branch || 'main',
            onProgress: (statusText) => {
                event.reply('action-progress', { text: statusText });
            }
        });

        if (result.pushed) {
            markPRAsResolved(pr.url, 'Conflictos de Merge', result.message);
            addActionLog({
                repository: pr.repository,
                prNumber: pr.number,
                actionType: '🔀 Resolver Conflictos',
                status: 'SUCCESS',
                message: `Conflictos resueltos y pusheados a ${pr.head_branch}.`
            });
        }

        event.reply('action-completed', {
            success: result.pushed,
            message: result.message || 'Conflictos resueltos y pusheados a GitHub.',
            error: result.error || (result.pushed ? null : 'Tests fallaron; no se hizo push')
        });
        updateStatus();
    } catch (err) {
        event.reply('action-completed', { success: false, error: err.message });
    }
});

ipcMain.on('show-context-menu', () => {
    const pinLabel = alwaysOnTop ? '📌 Siempre visible: ON  ✓' : '📌 Siempre visible: OFF';
    const template = [
        { label: '🔄 Actualizar ahora', click: () => updateStatus() },
        {
            label: '📋 Historial de Acciones IA',
            click: () => { if (mainWindow) mainWindow.webContents.send('show-action-logs'); }
        },
        {
            label: '🤖 Configurar Prompts y Auto-Pilot',
            click: () => { if (mainWindow) mainWindow.webContents.send('show-ai-settings'); }
        },
        {
            label: '⚙️ Cambiar Token GitHub',
            click: () => { if (mainWindow) mainWindow.webContents.send('show-settings'); }
        },
        {
            label: pinLabel,
            click: () => {
                alwaysOnTop = !alwaysOnTop;
                mainWindow.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? 'floating' : 'normal');
                saveConfig({ alwaysOnTop });
                mainWindow.webContents.send('always-on-top-state', alwaysOnTop);
            }
        },
        { type: 'separator' },
        { label: '❌ Cerrar Mascota', click: () => app.quit() }
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
});

let dragInitialWinPos = [0, 0];
let dragInitialCursor = { x: 0, y: 0 };

ipcMain.on('start-window-drag', (event, data) => {
    if (mainWindow && data) {
        dragInitialWinPos = mainWindow.getPosition();
        dragInitialCursor = {
            x: Math.round(Number(data.x) || 0),
            y: Math.round(Number(data.y) || 0)
        };
    }
});

ipcMain.on('window-drag-move', (event, data) => {
    if (mainWindow && data) {
        const curX = Math.round(Number(data.screenX) || 0);
        const curY = Math.round(Number(data.screenY) || 0);
        const dx = curX - dragInitialCursor.x;
        const dy = curY - dragInitialCursor.y;
        const newX = Math.round(dragInitialWinPos[0] + dx);
        const newY = Math.round(dragInitialWinPos[1] + dy);
        if (!isNaN(newX) && !isNaN(newY)) {
            mainWindow.setPosition(newX, newY);
        }
    }
});

ipcMain.on('end-window-drag', () => {
    if (mainWindow) {
        const [x, y] = mainWindow.getPosition();
        saveConfig({ x, y });
    }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
