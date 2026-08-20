const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const GitHubService = require('./github_service');

let mainWindow;
let github = null;
let currentToken = null;
let pollTimer = null;
let alwaysOnTop = true;
let savePositionTimer = null;
let dragOrigin = null;

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
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...data }), 'utf-8');
    } catch (e) {
        console.error("Error saving config:", e);
    }
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const config = loadConfig();

    const winX = typeof config.x === 'number' ? config.x : width - 340;
    const winY = typeof config.y === 'number' ? config.y : height - 400;
    alwaysOnTop = config.alwaysOnTop !== false;

    mainWindow = new BrowserWindow({
        width: 320,
        height: 380,
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

// SA1: arrastre libre con delta de posición
ipcMain.on('drag-start', (event, { screenX, screenY }) => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    dragOrigin = { screenX, screenY, x, y };
});

ipcMain.on('drag-move', (event, { screenX, screenY }) => {
    if (!mainWindow) return;
    if (!dragOrigin) return;
    mainWindow.setPosition(
        Math.round(dragOrigin.x + screenX - dragOrigin.screenX),
        Math.round(dragOrigin.y + screenY - dragOrigin.screenY)
    );
});

ipcMain.on('drag-end', () => { dragOrigin = null; });

ipcMain.on('refresh-status', () => { updateStatus(); });

// SA2: marcar PR como visto — solo persiste en disco; el renderer ya actualizó el DOM
ipcMain.on('mark-seen', (event, { url, updatedAt }) => {
    const existing = loadConfig().seen_prs || {};
    saveConfig({ seen_prs: { ...existing, [url]: updatedAt } });
    // updateStatus() intencionalmente omitido: evita el lag por llamadas reales a GitHub
});

ipcMain.on('mark-unseen', (event, { url }) => {
    const existing = loadConfig().seen_prs || {};
    delete existing[url];
    saveConfig({ seen_prs: existing });
});

ipcMain.on('get-seen-prs', (event) => {
    event.reply('seen-prs', loadConfig().seen_prs || {});
});

// Historial de tokens: renderer lo solicita al abrir la pantalla de config
ipcMain.on('get-token-history', (event) => {
    const history = loadConfig().token_history || [];
    event.reply('token-history', history);
});

ipcMain.on('show-context-menu', () => {
    const pinLabel = alwaysOnTop ? '📌 Siempre visible: ON  ✓' : '📌 Siempre visible: OFF';
    const template = [
        {
            label: '🔄 Actualizar ahora',
            click: () => updateStatus()
        },
        {
            label: '⚙️ Configuración / Cambiar Token',
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
