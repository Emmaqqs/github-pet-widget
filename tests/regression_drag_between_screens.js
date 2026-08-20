const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const EventEmitter = require('node:events');

function loadMainWithElectronStub({ cursorApi = true, workArea = null } = {}) {
    const ipcMain = new EventEmitter();
    const app = {
        getPath: () => require('node:os').tmpdir(),
        whenReady: () => ({ then: callback => callback() }),
        on: () => {},
        quit: () => {}
    };
    let cursorPoint = { x: 0, y: 0 };
    const screen = {
        getPrimaryDisplay: () => ({
            workAreaSize: { width: 1920, height: 1080 },
            ...(workArea ? { workArea } : {})
        }),
        ...(cursorApi ? { getCursorScreenPoint: () => cursorPoint } : {})
    };
    let windowInstance;
    class FakeWindow extends EventEmitter {
        constructor(options) {
            super();
            this.position = [options.x, options.y];
            this.webContents = new EventEmitter();
        }
        loadFile() {}
        getPosition() { return this.position; }
        setPosition(x, y) { this.position = [x, y]; }
        setAlwaysOnTop() {}
    }
    const electron = {
        app,
        BrowserWindow: class extends FakeWindow {
            constructor(options) { super(options); windowInstance = this; }
        },
        ipcMain,
        screen,
        Menu: { buildFromTemplate: () => ({ popup() {} }) }
    };
    const filename = path.join(__dirname, '..', 'src', 'main.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(source, {
        require: request => request === 'electron' ? electron
            : request === './github_service' ? class FakeGitHubService {}
            : request === './ai_service' ? { AIService: class { getTemplates() { return {}; } } }
            : request === './worktree_service' ? class FakeWorktreeService {}
            : require(request),
        module,
        exports: module.exports,
        __dirname: path.dirname(filename),
        console,
        setTimeout,
        clearTimeout,
        process
    }, { filename });
    return {
        ipcMain,
        window: windowInstance,
        setCursor(point) { cursorPoint = point; }
    };
}

function testWorkAreaOrigin() {
    const { window } = loadMainWithElectronStub({
        workArea: { x: -1920, y: 40, width: 1920, height: 1040 }
    });
    assert.deepEqual(window.getPosition(), [-340, 680],
        'la posición por defecto debe respetar el origen x/y del workArea');
}

function testRendererPetToggle() {
    const listeners = new Map();
    const classes = new Set();
    const makeElement = () => ({
        style: {},
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c) => classes.has(c) ? classes.delete(c) : classes.add(c),
            contains: (c) => classes.has(c)
        },
        dataset: {},
        addEventListener(type, callback) { listeners.set((this.id || 'element') + ':' + type, callback); },
        append() {}, appendChild() {}, replaceChildren() {},
        querySelectorAll: () => [],
        set textContent(value) { this._text = value; }, get textContent() { return this._text; },
        set value(v) { this._val = v; }, get value() { return this._val; }
    });
    const elements = {};
    const ids = [
        'bubble', 'alerts-section', 'logs-section', 'ai-settings-section', 'auth-section',
        'alerts-list', 'logs-list', 'user-header', 'token-input', 'auth-error-msg',
        'token-history-list', 'token-chips', 'pet', 'badge', 'toast-msg',
        'chk-autopilot', 'sel-days-threshold', 'chk-recent-only', 'chk-show-viewed',
        'tpl-review', 'tpl-autofix', 'tpl-conflict', 'ai-save-feedback', 'btn-refresh',
        'btn-logs', 'btn-ai', 'save-token-btn'
    ];
    ids.forEach(id => { elements[id] = makeElement(); elements[id].id = id; });
    const document = {
        getElementById: id => elements[id] || makeElement(),
        addEventListener: (type, callback) => listeners.set('document:' + type, callback),
        querySelectorAll: () => []
    };
    const ipcRenderer = { send: () => {}, on: () => {} };
    const filename = path.join(__dirname, '..', 'src', 'renderer.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: request => request === 'electron' ? { ipcRenderer, shell: { openExternal() {} } } : require(request),
        document,
        window: { addEventListener: (type, callback) => listeners.set('window:' + type, callback) },
        console, setTimeout, clearTimeout, Map, Date, String, Boolean, Math
    }, { filename });

    const petClick = listeners.get('pet:click');
    assert.ok(typeof petClick === 'function', 'el listener de clic en la mascota debe existir');
    
    // Primer clic: oculta el globo
    petClick();
    assert.ok(classes.has('hidden'), 'el primer clic debe agregar .hidden');

    // Segundo clic: muestra el globo
    petClick();
    assert.ok(!classes.has('hidden'), 'el segundo clic debe remover .hidden');
}

testWorkAreaOrigin();
testRendererPetToggle();
console.log('✅ Regresión de UI y arrastre: Todos los casos pasaron al 100%.');
