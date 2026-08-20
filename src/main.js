const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const GitHubService = require('./github_service');
const { AIService, DEFAULT_REVIEW_PROMPT_TEMPLATE, DEFAULT_AUTOFIX_COMMIT_TEMPLATE, DEFAULT_MERGE_CONFLICT_TEMPLATE, DEFAULT_AUTOREVIEW_EVAL_TEMPLATE } = require('./ai_service');

let mainWindow;
let github = null;
let aiService = null;
let currentToken = null;
let pollTimer = null;
let alwaysOnTop = true;
let savePositionTimer = null;
let dragOffset = null;

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

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    aiService = new AIService(config.ai_templates || {});

    // Guardar posición al terminar de mover (debounce 500ms)
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

        // Historial de tokens: mover al frente, máximo 5 entradas
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

async function updateStatus() {
    if (!github || !mainWindow) return;
    try {
        const seenPRs = loadConfig().seen_prs || {};
        const status = await github.getStatus(seenPRs, true);
        if (status) {
            mainWindow.webContents.send('status-update', status);
        }
    } catch (e) {
        console.error("Polling error:", e);
    }
}

ipcMain.on('set-token', async (event, token) => {
    await initializeWithToken(token);
});

// Arrastre multi-monitor sin bucle de DPI (Cálculo directo global)
ipcMain.on('drag-start', (event, { clientX, clientY }) => {
    if (!mainWindow) return;
    dragOffset = {
        x: Number.isFinite(clientX) ? clientX : 160,
        y: Number.isFinite(clientY) ? clientY : 190
    };
});

ipcMain.on('drag-move', () => {
    if (!mainWindow || !dragOffset) return;
    try {
        const point = screen.getCursorScreenPoint();
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            mainWindow.setPosition(
                Math.round(point.x - dragOffset.x),
                Math.round(point.y - dragOffset.y)
            );
        }
    } catch (e) {
        console.error("Error in drag-move:", e);
    }
});

ipcMain.on('drag-end', () => {
    dragOffset = null;
});

ipcMain.on('refresh-status', () => { updateStatus(); });

// Marcar PR como visto
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

// Historial de tokens
ipcMain.on('get-token-history', (event) => {
    const history = loadConfig().token_history || [];
    event.reply('token-history', history);
});

// Configuración de Prompts y Plantillas de IA
ipcMain.on('get-ai-templates', (event) => {
    const config = loadConfig();
    const service = new AIService(config.ai_templates || {});
    event.reply('ai-templates-data', service.getTemplates());
});

ipcMain.on('save-ai-templates', (event, templates) => {
    saveConfig({ ai_templates: templates });
    if (aiService) aiService.config = templates;
    event.reply('ai-templates-saved', { success: true });
});

ipcMain.on('reset-ai-templates', (event) => {
    const defaultTemplates = {
        review_prompt_template: DEFAULT_REVIEW_PROMPT_TEMPLATE,
        autofix_commit_template: DEFAULT_AUTOFIX_COMMIT_TEMPLATE,
        merge_conflict_template: DEFAULT_MERGE_CONFLICT_TEMPLATE,
        autoreview_eval_template: DEFAULT_AUTOREVIEW_EVAL_TEMPLATE,
    };
    saveConfig({ ai_templates: defaultTemplates });
    if (aiService) aiService.config = defaultTemplates;
    event.reply('ai-templates-data', defaultTemplates);
});

// Auto-Review con IA
ipcMain.on('request-auto-review', async (event, pr) => {
    if (!github || !aiService) {
        event.reply('auto-review-result', { success: false, error: 'Servicio no inicializado' });
        return;
    }
    try {
        const [owner, repo] = (pr.repository || '').split('/');
        const diff = await github.getPullRequestDiff(owner, repo, pr.number);
        const review = await aiService.generateCodeReview(pr, diff);
        event.reply('auto-review-result', { success: true, pr, review });
    } catch (err) {
        console.error("Auto review error:", err);
        event.reply('auto-review-result', { success: false, error: err.message });
    }
});

// Auto-Pilot Re-Review
ipcMain.on('request-autopilot-eval', async (event, { pr, previousComment }) => {
    if (!github || !aiService) return;
    try {
        const [owner, repo] = (pr.repository || '').split('/');
        const diff = await github.getPullRequestDiff(owner, repo, pr.number);
        const evaluation = await aiService.evaluateAutoPilot(pr, previousComment, diff);
        event.reply('autopilot-eval-result', { success: true, pr, evaluation });
    } catch (err) {
        console.error("Auto-pilot eval error:", err);
    }
});

ipcMain.on('show-context-menu', () => {
    const pinLabel = alwaysOnTop ? '📌 Siempre visible: ON  ✓' : '📌 Siempre visible: OFF';
    const template = [
        {
            label: '🔄 Actualizar ahora',
            click: () => updateStatus()
        },
        {
            label: '🤖 Configurar Prompts e IA',
            click: () => {
                if (mainWindow) mainWindow.webContents.send('show-ai-settings');
            }
        },
        {
            label: '⚙️ Cambiar Token GitHub',
            click: () => {
                if (mainWindow) mainWindow.webContents.send('show-settings');
            }
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
        {
            label: '❌ Cerrar Mascota',
            click: () => app.quit()
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
