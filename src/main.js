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

    // 1. Conflictos de Merge -> Auto-Resolve & Push
    for (const pr of status.merge_conflicts || []) {
        const key = `conflict_${pr.url}_${pr.updated_at}`;
        if (!autoPilotProcessing.has(key)) {
            autoPilotProcessing.add(key);
            console.log(`[Auto-Pilot] Resolviendo conflictos para PR #${pr.number} en ${pr.repository}...`);
            mainWindow?.webContents.send('autopilot-status', { text: `🔀 Auto-Pilot: Resolviendo PR #${pr.number}...` });
            
            worktreeService.resolveMergeConflictsInWorktree({
                repository: pr.repository,
                pull_number: pr.number,
                head_branch: pr.head_branch,
                base_branch: pr.base_branch || 'main'
            }).then(res => {
                mainWindow?.webContents.send('autopilot-finished', { pr, result: res });
                updateStatus();
            }).catch(e => console.error('[Auto-Pilot] Error en merge:', e));
        }
    }

    // 2. PRs con Cambios Solicitados -> Auto-Fix & Push
    for (const pr of status.my_pr_activity || []) {
        if (pr.state && pr.state.includes('Cambios pedidos')) {
            const key = `fix_${pr.url}_${pr.updated_at}`;
            if (!autoPilotProcessing.has(key)) {
                autoPilotProcessing.add(key);
                console.log(`[Auto-Pilot] Auto-Fix para PR #${pr.number} en ${pr.repository}...`);
                mainWindow?.webContents.send('autopilot-status', { text: `⚡ Auto-Pilot: Aplicando fixes a PR #${pr.number}...` });
                
                worktreeService.autoFixReviewFeedbackInWorktree({
                    repository: pr.repository,
                    pull_number: pr.number,
                    head_branch: pr.head_branch,
                    feedbackText: pr.state
                }).then(async (res) => {
                    if (res.pushed) {
                        const [owner, repo] = pr.repository.split('/');
                        await github.postComment(owner, repo, pr.number, '🤖 *Auto-Pilot: He aplicado las correcciones solicitadas en un worktree y pusheado los cambios con tests pasando.*');
                    }
                    mainWindow?.webContents.send('autopilot-finished', { pr, result: res });
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
        const status = await github.getStatus(seenPRs, true);
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

ipcMain.on('get-ai-templates', (event) => {
    const config = loadConfig();
    const service = new AIService(config.ai_templates || {});
    event.reply('ai-templates-data', {
        templates: service.getTemplates(),
        autopilot_enabled: Boolean(config.autopilot_enabled)
    });
});

ipcMain.on('save-ai-templates', (event, { templates, autopilot_enabled }) => {
    saveConfig({
        ai_templates: templates,
        autopilot_enabled: Boolean(autopilot_enabled)
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
    saveConfig({ ai_templates: defaultTemplates, autopilot_enabled: false });
    if (aiService) aiService.config = defaultTemplates;
    event.reply('ai-templates-data', {
        templates: defaultTemplates,
        autopilot_enabled: false
    });
});

// 1. Revisar y publicar en GitHub
ipcMain.on('execute-auto-review', async (event, pr) => {
    if (!github || !aiService) {
        event.reply('action-completed', { success: false, error: 'Servicio no inicializado' });
        return;
    }
    try {
        const [owner, repo] = (pr.repository || '').split('/');
        const diff = await github.getPullRequestDiff(owner, repo, pr.number);
        const reviewText = await aiService.generateCodeReview(pr, diff);
        const publishResult = await github.submitPullRequestReview(owner, repo, pr.number, reviewText, 'COMMENT');
        
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

        if (result.pushed && github) {
            const [owner, repo] = (pr.repository || '').split('/');
            await github.postComment(owner, repo, pr.number, '🤖 *He resuelto el feedback de revisión automáticamente en un worktree y pusheado los cambios con tests pasando.*');
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
                mainWindow.setAlwaysOnTop(alwaysOnTop);
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
