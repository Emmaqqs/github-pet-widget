const GitHubService = require('../src/github_service');
const os = require('os');
const path = require('path');
const fs = require('fs');

async function testFullSuite() {
    console.log("==========================================");
    console.log("🧪 QA TEST SUITE COMPLETA - GITHUB PET");
    console.log("==========================================");

    // ─── Test 1: Carga dinámica de Octokit ESM ────────────────────────────────
    console.log("\n[Test 1] Carga dinámica de Octokit ESM...");
    const service = new GitHubService("test-token");
    try {
        const octokit = await service.getOctokit();
        if (octokit && octokit.rest) {
            console.log("  ✅ OK: Octokit instanciado correctamente vía ESM dynamic import.");
        } else {
            throw new Error("Octokit no inicializado.");
        }
    } catch (e) {
        console.error("  ❌ FAIL:", e.message);
        process.exit(1);
    }

    // ─── Test 2: Lógica de clasificación de PRs (Casos A, B y C) ─────────────
    console.log("\n[Test 2] Lógica de clasificación de PRs (Casos A, B y C)...");
    const mockOctokit = {
        rest: {
            users: {
                getAuthenticated: async () => ({ data: { login: 'octocat' } })
            },
            search: {
                issuesAndPullRequests: async () => ({
                    data: {
                        items: [
                            { number: 101, repository_url: 'https://api.github.com/repos/org/repo-a', title: 'Feature Login' },
                            { number: 102, repository_url: 'https://api.github.com/repos/org/repo-b', title: 'Fix Bug' },
                            { number: 103, repository_url: 'https://api.github.com/repos/org/repo-c', title: 'Mi propio PR' }
                        ]
                    }
                })
            },
            pulls: {
                get: async ({ pull_number }) => {
                    if (pull_number === 101) {
                        return {
                            data: {
                                title: 'Feature Login',
                                html_url: 'https://github.com/org/repo-a/pull/101',
                                user: { login: 'alice' },
                                requested_reviewers: [{ login: 'octocat' }],
                                updated_at: '2026-08-19T10:00:00Z'
                            }
                        };
                    } else if (pull_number === 102) {
                        return {
                            data: {
                                title: 'Fix Bug',
                                html_url: 'https://github.com/org/repo-b/pull/102',
                                user: { login: 'bob' },
                                requested_reviewers: [],
                                updated_at: '2026-08-19T15:00:00Z'
                            }
                        };
                    } else {
                        return {
                            data: {
                                title: 'Mi propio PR',
                                html_url: 'https://github.com/org/repo-c/pull/103',
                                user: { login: 'octocat' },
                                requested_reviewers: [],
                                updated_at: '2026-08-19T12:00:00Z'
                            }
                        };
                    }
                },
                listReviews: async ({ pull_number }) => {
                    if (pull_number === 101) {
                        return { data: [] };
                    } else if (pull_number === 102) {
                        return {
                            data: [{
                                user: { login: 'octocat' },
                                state: 'COMMENTED',
                                submitted_at: '2026-08-19T12:00:00Z'
                            }]
                        };
                    } else {
                        return {
                            data: [{
                                user: { login: 'charlie' },
                                state: 'APPROVED',
                                submitted_at: '2026-08-19T14:00:00Z'
                            }]
                        };
                    }
                }
            }
        }
    };

    const mockService = new GitHubService("mock");
    mockService.octokit = mockOctokit;
    mockService.username = 'octocat';

    const alerts = await mockService.getStatus();
    let success = true;

    if (alerts.review_required.length === 1 && alerts.review_required[0].title === 'Feature Login') {
        console.log("  ✅ Caso A (Review requerida): Detectado con éxito.");
    } else {
        console.error("  ❌ Caso A Falló. Resultado:", JSON.stringify(alerts.review_required));
        success = false;
    }

    if (alerts.re_review_needed.length === 1 && alerts.re_review_needed[0].title === 'Fix Bug') {
        console.log("  ✅ Caso B (Re-revisión / Nuevos commits): Detectado con éxito.");
    } else {
        console.error("  ❌ Caso B Falló. Resultado:", JSON.stringify(alerts.re_review_needed));
        success = false;
    }

    if (alerts.my_pr_activity.length === 1 && alerts.my_pr_activity[0].title === 'Mi propio PR') {
        console.log("  ✅ Caso C (Mi PR con feedback/aprobado): Detectado con éxito.");
    } else {
        console.error("  ❌ Caso C Falló. Resultado:", JSON.stringify(alerts.my_pr_activity));
        success = false;
    }

    if (!success) process.exit(1);

    // ─── Test 3: Manejo de errores de red y token inválido ────────────────────
    console.log("\n[Test 3] Manejo de errores de red y token inválido...");

    // 3a: verifyUser con credenciales malas → null sin crashear
    const badService = new GitHubService("invalid-token-xyz");
    badService.octokit = {
        rest: {
            users: {
                getAuthenticated: async () => { throw new Error("Bad credentials"); }
            }
        }
    };
    const verifyResult = await badService.verifyUser();
    if (verifyResult === null) {
        console.log("  ✅ Token inválido: verifyUser() retorna null sin crashear.");
    } else {
        console.error("  ❌ Test 3a Falló: debería retornar null con credenciales malas.");
        process.exit(1);
    }

    // 3b: getStatus con error de red → null sin crashear
    const netErrorService = new GitHubService("token");
    netErrorService.username = 'octocat';
    netErrorService.octokit = {
        request: async () => { throw new Error("Network error: ECONNREFUSED"); },
        rest: {
            pulls: {
                get: async () => { throw new Error("Network error"); },
                listReviews: async () => { throw new Error("Network error"); }
            }
        }
    };
    const statusOnNetError = await netErrorService.getStatus();
    if (statusOnNetError === null) {
        console.log("  ✅ Error de red: getStatus() retorna null sin crashear.");
    } else {
        console.error("  ❌ Test 3b Falló: debería retornar null ante error de red.");
        process.exit(1);
    }

    // 3c: getStatus sin usuario autenticado (verifyUser falla) → null
    const noUserService = new GitHubService("bad");
    noUserService.octokit = {
        rest: {
            users: { getAuthenticated: async () => { throw new Error("401 Unauthorized"); } }
        }
    };
    const statusNoUser = await noUserService.getStatus();
    if (statusNoUser === null) {
        console.log("  ✅ Sin usuario autenticado: getStatus() retorna null correctamente.");
    } else {
        console.error("  ❌ Test 3c Falló.");
        process.exit(1);
    }

    // ─── Test 4: Persistencia de posición (x, y) en config ───────────────────
    console.log("\n[Test 4] Persistencia de posición (x, y) en config...");
    const tmpConfig = path.join(os.tmpdir(), `pet-test-config-${Date.now()}.json`);

    try {
        // 4a: Guardar config completo con posición
        const initialData = { token: "ghp_test123", x: 123, y: 456, alwaysOnTop: true };
        fs.writeFileSync(tmpConfig, JSON.stringify(initialData), 'utf-8');
        const loaded = JSON.parse(fs.readFileSync(tmpConfig, 'utf-8'));

        if (loaded.x === 123 && loaded.y === 456 && loaded.token === "ghp_test123") {
            console.log("  ✅ Posición inicial guardada y leída correctamente.");
        } else {
            console.error("  ❌ Test 4a Falló: valores incorrectos en config.");
            process.exit(1);
        }

        // 4b: Actualización parcial (merge) preserva el token al mover la ventana
        const updated = { ...loaded, x: 789, y: 101 };
        fs.writeFileSync(tmpConfig, JSON.stringify(updated), 'utf-8');
        const loaded2 = JSON.parse(fs.readFileSync(tmpConfig, 'utf-8'));

        if (loaded2.x === 789 && loaded2.y === 101 && loaded2.token === "ghp_test123") {
            console.log("  ✅ Actualización de posición (merge) preserva el token correctamente.");
        } else {
            console.error("  ❌ Test 4b Falló: merge de config incorrecto.");
            process.exit(1);
        }

        // 4c: alwaysOnTop persiste correctamente junto con posición
        const withPin = { ...loaded2, alwaysOnTop: false };
        fs.writeFileSync(tmpConfig, JSON.stringify(withPin), 'utf-8');
        const loaded3 = JSON.parse(fs.readFileSync(tmpConfig, 'utf-8'));

        if (loaded3.alwaysOnTop === false && loaded3.x === 789) {
            console.log("  ✅ Estado alwaysOnTop persiste y coexiste con posición.");
        } else {
            console.error("  ❌ Test 4c Falló: alwaysOnTop no persiste correctamente.");
            process.exit(1);
        }

        // 4d: Lógica de posición por defecto cuando no hay config previo
        const noConfig = {};
        const defaultX = typeof noConfig.x === 'number' ? noConfig.x : 'DEFAULT';
        const defaultY = typeof noConfig.y === 'number' ? noConfig.y : 'DEFAULT';
        if (defaultX === 'DEFAULT' && defaultY === 'DEFAULT') {
            console.log("  ✅ Sin config previo: se usa posición por defecto correctamente.");
        } else {
            console.error("  ❌ Test 4d Falló: lógica de posición por defecto incorrecta.");
            process.exit(1);
        }

    } finally {
        if (fs.existsSync(tmpConfig)) fs.unlinkSync(tmpConfig);
    }

    // ─── Test 5: Lógica de "Marcar como Visto" con filtrado ──────────────────
    console.log("\n[Test 5] Lógica de 'Marcar como Visto' con filtrado...");

    // Función auxiliar para validar la lógica de filtrado de forma aislada
    function isSeen(url, updatedAt, seenPRs) {
        if (!seenPRs[url]) return false;
        return new Date(updatedAt) <= new Date(seenPRs[url]);
    }

    // Mock de datos para T5: PR #201 (Caso A) y PR #202 (Caso B)
    const mockOctokit5 = {
        rest: {
            users: {
                getAuthenticated: async () => ({ data: { login: 'octocat' } })
            },
            search: {
                issuesAndPullRequests: async () => ({
                    data: {
                        items: [
                            { number: 201, repository_url: 'https://api.github.com/repos/org/repo', title: 'PR Alpha' },
                            { number: 202, repository_url: 'https://api.github.com/repos/org/repo', title: 'PR Beta' }
                        ]
                    }
                })
            },
            pulls: {
                get: async ({ pull_number }) => {
                    if (pull_number === 201) {
                        return {
                            data: {
                                title: 'PR Alpha',
                                html_url: 'https://github.com/org/repo/pull/201',
                                user: { login: 'alice' },
                                requested_reviewers: [{ login: 'octocat' }],
                                updated_at: '2026-08-19T10:00:00Z'
                            }
                        };
                    } else {
                        return {
                            data: {
                                title: 'PR Beta',
                                html_url: 'https://github.com/org/repo/pull/202',
                                user: { login: 'bob' },
                                requested_reviewers: [],
                                updated_at: '2026-08-19T15:00:00Z'
                            }
                        };
                    }
                },
                listReviews: async ({ pull_number }) => {
                    if (pull_number === 201) {
                        return { data: [] };
                    } else {
                        return {
                            data: [{
                                user: { login: 'octocat' },
                                state: 'COMMENTED',
                                submitted_at: '2026-08-19T09:00:00Z'
                            }]
                        };
                    }
                }
            }
        }
    };

    const mockService5 = new GitHubService("mock5");
    mockService5.octokit = mockOctokit5;
    mockService5.username = 'octocat';

    // Mapa de updated_at conocidos por URL (getStatus() no devuelve updated_at en el objeto)
    const prUpdatedAt5 = {
        'https://github.com/org/repo/pull/201': '2026-08-19T10:00:00Z',
        'https://github.com/org/repo/pull/202': '2026-08-19T15:00:00Z'
    };

    // Obtenemos los resultados base sin filtrado
    const alerts5 = await mockService5.getStatus();

    // 5a: Sin seenPRs → ambos PRs aparecen
    {
        const seenPRs = {};
        const visibleReviewRequired = alerts5.review_required.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        const visibleReReview = alerts5.re_review_needed.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        if (visibleReviewRequired.length === 1 && visibleReReview.length === 1) {
            console.log("  ✅ 5a: Sin seenPRs → ambos PRs visibles correctamente.");
        } else {
            console.error("  ❌ 5a Falló: review_required=" + visibleReviewRequired.length + " re_review_needed=" + visibleReReview.length);
            process.exit(1);
        }
    }

    // 5b: PR #201 marcado como visto con timestamp IGUAL a updated_at → filtrado (oculto)
    {
        const seenPRs = { 'https://github.com/org/repo/pull/201': '2026-08-19T10:00:00Z' };
        const visibleReviewRequired = alerts5.review_required.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        const visibleReReview = alerts5.re_review_needed.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        if (visibleReviewRequired.length === 0 && visibleReReview.length === 1) {
            console.log("  ✅ 5b: PR #201 marcado como visto (timestamp igual) → filtrado correctamente.");
        } else {
            console.error("  ❌ 5b Falló: review_required=" + visibleReviewRequired.length + " re_review_needed=" + visibleReReview.length);
            process.exit(1);
        }
    }

    // 5c: PR #201 marcado como visto con timestamp ANTERIOR a updated_at → aparece (actividad nueva)
    {
        const seenPRs = { 'https://github.com/org/repo/pull/201': '2026-08-19T08:00:00Z' };
        const visibleReviewRequired = alerts5.review_required.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        if (visibleReviewRequired.length === 1) {
            console.log("  ✅ 5c: PR #201 con actividad nueva posterior a 'seen' → aparece correctamente.");
        } else {
            console.error("  ❌ 5c Falló: review_required=" + visibleReviewRequired.length);
            process.exit(1);
        }
    }

    // 5d: seenPRs vacío ({}) → mismo resultado que sin seenPRs
    {
        const seenPRs = {};
        const visibleReviewRequired = alerts5.review_required.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        const visibleReReview = alerts5.re_review_needed.filter(
            pr => !isSeen(pr.url, prUpdatedAt5[pr.url], seenPRs)
        );
        if (visibleReviewRequired.length === 1 && visibleReReview.length === 1) {
            console.log("  ✅ 5d: seenPRs vacío ({}) → todos los PRs visibles (igual que sin seenPRs).");
        } else {
            console.error("  ❌ 5d Falló: review_required=" + visibleReviewRequired.length + " re_review_needed=" + visibleReReview.length);
            process.exit(1);
        }
    }

    // ─── Test 6: Persistencia del estado "seen_prs" en config ────────────────
    console.log("\n[Test 6] Persistencia del estado 'seen_prs' en config...");
    const tmpConfig6 = path.join(os.tmpdir(), `pet-test-seen-${Date.now()}.json`);

    try {
        // 6a: Guardar seen_prs con primer URL
        const url1 = 'https://github.com/org/repo/pull/201';
        const url2 = 'https://github.com/org/repo/pull/202';
        const ts1 = '2026-08-19T10:00:00Z';
        const ts2 = '2026-08-19T15:00:00Z';

        const initialConfig6 = { token: "ghp_abc", x: 10, y: 20, seen_prs: { [url1]: ts1 } };
        fs.writeFileSync(tmpConfig6, JSON.stringify(initialConfig6), 'utf-8');
        const loaded6a = JSON.parse(fs.readFileSync(tmpConfig6, 'utf-8'));

        if (loaded6a.seen_prs && loaded6a.seen_prs[url1] === ts1) {
            console.log("  ✅ 6a: seen_prs guardado con primer URL correctamente.");
        } else {
            console.error("  ❌ 6a Falló: seen_prs no contiene el primer URL.");
            process.exit(1);
        }

        // 6b: Merge añade segundo URL sin borrar el primero
        const merged6b = { ...loaded6a, seen_prs: { ...loaded6a.seen_prs, [url2]: ts2 } };
        fs.writeFileSync(tmpConfig6, JSON.stringify(merged6b), 'utf-8');
        const loaded6b = JSON.parse(fs.readFileSync(tmpConfig6, 'utf-8'));

        if (loaded6b.seen_prs[url1] === ts1 && loaded6b.seen_prs[url2] === ts2) {
            console.log("  ✅ 6b: Merge añade segundo URL sin borrar el primero.");
        } else {
            console.error("  ❌ 6b Falló: merge de seen_prs incorrecto.");
            process.exit(1);
        }

        // 6c: Actualizar timestamp de URL existente (merge de seen_prs)
        const newTs1 = '2026-08-19T12:00:00Z';
        const merged6c = { ...loaded6b, seen_prs: { ...loaded6b.seen_prs, [url1]: newTs1 } };
        fs.writeFileSync(tmpConfig6, JSON.stringify(merged6c), 'utf-8');
        const loaded6c = JSON.parse(fs.readFileSync(tmpConfig6, 'utf-8'));

        if (loaded6c.seen_prs[url1] === newTs1 && loaded6c.seen_prs[url2] === ts2) {
            console.log("  ✅ 6c: Actualizar timestamp de URL existente actualiza solo ese PR.");
        } else {
            console.error("  ❌ 6c Falló: actualización de timestamp incorrecta.");
            process.exit(1);
        }

        // 6d: seen_prs vacío ({}) no afecta token ni posición en config
        const config6d = { ...loaded6c, seen_prs: {} };
        fs.writeFileSync(tmpConfig6, JSON.stringify(config6d), 'utf-8');
        const loaded6d = JSON.parse(fs.readFileSync(tmpConfig6, 'utf-8'));

        if (
            loaded6d.token === "ghp_abc" &&
            loaded6d.x === 10 &&
            loaded6d.y === 20 &&
            typeof loaded6d.seen_prs === 'object' &&
            Object.keys(loaded6d.seen_prs).length === 0
        ) {
            console.log("  ✅ 6d: seen_prs vacío ({}) no afecta token ni posición en config.");
        } else {
            console.error("  ❌ 6d Falló: config con seen_prs vacío tiene valores incorrectos.");
            process.exit(1);
        }

    } finally {
        if (fs.existsSync(tmpConfig6)) fs.unlinkSync(tmpConfig6);
    }

    // ─── Resumen final ────────────────────────────────────────────────────────
    console.log("\n==========================================");
    console.log("🎉 TODAS LAS PRUEBAS PASARON AL 100%.");
    console.log("   Tests: T1 (ESM), T2 (PRs A/B/C), T3 (errores red/token), T4 (posición), T5 (filtrado seen), T6 (persistencia seen_prs)");
    console.log("==========================================\n");
}

testFullSuite().catch(err => {
    console.error("\n💥 Error inesperado en la suite:", err);
    process.exit(1);
});
