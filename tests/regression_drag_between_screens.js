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

function testMainProcessDrag() {
    const { ipcMain, window, setCursor } = loadMainWithElectronStub();
    window.position = [1800, 700];

    setCursor({ x: 1900, y: 800 });
    ipcMain.emit('drag-start', {}, { screenX: 17, screenY: 23 });
    setCursor({ x: -80, y: 120 });
    ipcMain.emit('drag-move', {}, { screenX: 9999, screenY: 9999 });
    assert.deepEqual(window.getPosition(), [-180, 20],
        'el delta físico conserva el cruce a coordenadas negativas e ignora el payload');

    ipcMain.emit('drag-end');
    setCursor({ x: 500, y: 500 });
    ipcMain.emit('drag-move', {}, { screenX: 0, screenY: 0 });
    assert.deepEqual(window.getPosition(), [-180, 20],
        'después de drag-end un movimiento no debe reposicionar la ventana');
}

function testScaledMonitorOffset() {
    const { ipcMain, window, setCursor } = loadMainWithElectronStub();
    window.position = [400, 200];
    setCursor({ x: 1200, y: 300 });
    ipcMain.emit('drag-start', {}, { screenX: 100, screenY: 50 });
    setCursor({ x: 1680, y: 660 });
    ipcMain.emit('drag-move', {}, { screenX: 200, screenY: 100 });
    assert.deepEqual(window.getPosition(), [880, 560],
        'el delta usa coordenadas físicas aunque cambien escala y offset del monitor');
}

function testPayloadFallback() {
    const { ipcMain, window } = loadMainWithElectronStub({ cursorApi: false });
    window.position = [100, 200];
    ipcMain.emit('drag-start', {}, { screenX: 300, screenY: 400 });
    ipcMain.emit('drag-move', {}, { screenX: -20, screenY: 80 });
    assert.deepEqual(window.getPosition(), [-220, -120],
        'si la API no existe se usa de forma segura el payload del renderer');
}

function testRendererPointerCleanup() {
    const listeners = new Map();
    const sent = [];
    const makeElement = () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
        addEventListener(type, callback) { listeners.set(`${this.id || 'element'}:${type}`, callback); },
        setPointerCapture() {}, releasePointerCapture() {},
        append() {}, appendChild() {}, replaceChildren() {},
        querySelectorAll: () => [],
        set textContent(value) { this._text = value; }, get textContent() { return this._text; }
    });
    const elements = {};
    const ids = ['bubble', 'alerts-section', 'alerts-list', 'user-header', 'auth-section',
        'token-input', 'auth-error-msg', 'token-history-list', 'token-chips', 'pet',
        'pet-container', 'badge', 'refresh-btn', 'save-token-btn'];
    ids.forEach(id => { elements[id] = makeElement(); elements[id].id = id; });
    const document = {
        getElementById: id => elements[id],
        addEventListener: (type, callback) => listeners.set(`document:${type}`, callback),
        querySelectorAll: () => []
    };
    const ipcRenderer = { send: (channel, payload) => sent.push({ channel, payload }), on: () => {} };
    const filename = path.join(__dirname, '..', 'src', 'renderer.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: request => request === 'electron' ? { ipcRenderer, shell: { openExternal() {} } } : require(request),
        document,
        window: { addEventListener: (type, callback) => listeners.set(`window:${type}`, callback) },
        console, setTimeout, clearTimeout, Map, Date, String, Boolean, Math
    }, { filename });

    listeners.get('pet-container:pointerdown')({
        button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 20,
        screenX: 1900, screenY: 800, preventDefault() {}
    });
    listeners.get('document:pointermove')({ clientX: 20, clientY: 30, screenX: -80, screenY: 120 });
    listeners.get('document:pointerup')();
    assert.deepEqual(sent.map(item => item.channel), ['drag-start', 'drag-move', 'drag-end']);

    sent.length = 0;
    listeners.get('pet-container:pointerdown')({
        button: 0, isPrimary: true, pointerId: 2, clientX: 10, clientY: 20,
        screenX: 999, screenY: 999, preventDefault() {}
    });
    listeners.get('window:blur')();
    listeners.get('document:pointermove')({ clientX: 100, clientY: 100, screenX: 1, screenY: 1 });
    assert.deepEqual(sent.map(item => item.channel), ['drag-start', 'drag-end'],
        'blur finaliza el arrastre y evita movimientos posteriores');
}

testWorkAreaOrigin();
testMainProcessDrag();
testScaledMonitorOffset();
testPayloadFallback();
testRendererPointerCleanup();
console.log('✅ Regresión de arrastre entre pantallas: 5 casos pasaron.');
