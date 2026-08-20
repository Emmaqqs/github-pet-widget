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

function testStationaryCursorZeroDrift() {
    const { ipcMain, window, setCursor } = loadMainWithElectronStub();
    window.position = [1800, 700];

    // Clic en (50, 50) dentro de la ventana cuando el cursor está en global (1850, 750)
    setCursor({ x: 1850, y: 750 });
    ipcMain.emit('drag-start', {}, { clientX: 50, clientY: 50 });
    
    // Si el cursor no se mueve físicamente:
    ipcMain.emit('drag-move', {});
    assert.deepEqual(window.getPosition(), [1800, 700],
        'el cursor estático produce exactamente 0 deriva vertical');

    // Movimiento a monitor secundario a la izquierda (coordenadas negativas)
    setCursor({ x: -500, y: 300 });
    ipcMain.emit('drag-move', {});
    assert.deepEqual(window.getPosition(), [-550, 250],
        'el arrastre a monitor secundario ubica la ventana con el offset exacto');

    ipcMain.emit('drag-end');
    setCursor({ x: 500, y: 500 });
    ipcMain.emit('drag-move', {});
    assert.deepEqual(window.getPosition(), [-550, 250],
        'después de drag-end no se reposiciona la ventana');
}

function testRendererPointerCleanup() {
    const listeners = new Map();
    const sent = [];
    const makeElement = () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
        addEventListener(type, callback) { listeners.set((this.id || 'element') + ':' + type, callback); },
        setPointerCapture() {}, releasePointerCapture() {},
        append() {}, appendChild() {}, replaceChildren() {},
        querySelectorAll: () => [],
        set textContent(value) { this._text = value; }, get textContent() { return this._text; },
        set value(v) { this._val = v; }, get value() { return this._val; }
    });
    const elements = {};
    const ids = ['bubble', 'alerts-section', 'alerts-list', 'user-header', 'auth-section',
        'ai-settings-section', 'token-input', 'auth-error-msg', 'token-history-list', 'token-chips', 'pet',
        'pet-container', 'badge', 'refresh-btn', 'save-token-btn', 'ai-modal', 'ai-modal-title', 'ai-modal-body',
        'tpl-review', 'tpl-autofix', 'tpl-conflict', 'tpl-autopilot', 'ai-save-feedback'];
    ids.forEach(id => { elements[id] = makeElement(); elements[id].id = id; });
    const document = {
        getElementById: id => elements[id],
        addEventListener: (type, callback) => listeners.set('document:' + type, callback),
        querySelectorAll: () => []
    };
    const ipcRenderer = { send: (channel, payload) => sent.push({ channel, payload }), on: () => {} };
    const filename = path.join(__dirname, '..', 'src', 'renderer.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: request => request === 'electron' ? { ipcRenderer, shell: { openExternal() {} }, clipboard: { writeText() {} } } : require(request),
        document,
        window: { addEventListener: (type, callback) => listeners.set('window:' + type, callback) },
        console, setTimeout, clearTimeout, Map, Date, String, Boolean, Math
    }, { filename });

    listeners.get('pet-container:pointerdown')({
        button: 0, isPrimary: true, pointerId: 1, clientX: 50, clientY: 50,
        preventDefault() {}
    });
    listeners.get('document:pointermove')({ clientX: 60, clientY: 70 });
    listeners.get('document:pointerup')();
    assert.deepEqual(sent.map(item => item.channel), ['drag-start', 'drag-move', 'drag-end']);

    sent.length = 0;
    listeners.get('pet-container:pointerdown')({
        button: 0, isPrimary: true, pointerId: 2, clientX: 50, clientY: 50,
        preventDefault() {}
    });
    listeners.get('window:blur')();
    listeners.get('document:pointermove')({ clientX: 100, clientY: 100 });
    assert.deepEqual(sent.map(item => item.channel), ['drag-start', 'drag-end'],
        'blur finaliza el arrastre y cancela el seguimiento');
}

testWorkAreaOrigin();
testStationaryCursorZeroDrift();
testRendererPointerCleanup();
console.log('✅ Regresión de arrastre multi-monitor: Todos los casos pasaron (Zero-Drift verificado).');
