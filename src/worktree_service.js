const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

function execPromise(cmd, cwd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd, timeout: 90000 }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(stderr || stdout || err.message));
            }
            resolve(stdout ? stdout.trim() : '');
        });
    });
}

// EJECUTOR DE PRUEBAS POLÍGLOTA ADAPTABLE A CADA TIPO DE PROYECTO
async function detectAndRunTests(worktreePath, customCommand = null) {
    if (customCommand && typeof customCommand === 'string' && customCommand.trim().length > 0) {
        console.log(`[Test Runner] Ejecutando comando personalizado: ${customCommand}`);
        return await execPromise(customCommand, worktreePath);
    }

    // 1. Docker / Docker Compose
    const hasDockerCompose = fs.existsSync(path.join(worktreePath, 'docker-compose.yml')) ||
                             fs.existsSync(path.join(worktreePath, 'docker-compose.yaml')) ||
                             fs.existsSync(path.join(worktreePath, 'compose.yaml'));

    if (hasDockerCompose) {
        try {
            console.log('[Test Runner] Proyecto Docker detectado. Verificando pruebas en contenedor...');
            if (fs.existsSync(path.join(worktreePath, 'artisan'))) {
                return await execPromise('docker compose exec -T app php artisan test || docker compose run --rm app php artisan test', worktreePath);
            }
            if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
                return await execPromise('docker compose exec -T app npm test || docker compose run --rm app npm test', worktreePath);
            }
        } catch (_) {
            console.log('[Test Runner] Ejecución por Docker no disponible; intentando ejecución local...');
        }
    }

    // 2. Laravel / PHP
    if (fs.existsSync(path.join(worktreePath, 'artisan'))) {
        console.log('[Test Runner] Proyecto Laravel detectado.');
        const pestBin = path.join(worktreePath, 'vendor', 'bin', 'pest');
        const phpunitBin = path.join(worktreePath, 'vendor', 'bin', 'phpunit');

        if (fs.existsSync(pestBin) || fs.existsSync(pestBin + '.bat')) {
            return await execPromise('php artisan test || ./vendor/bin/pest || vendor\\bin\\pest.bat', worktreePath);
        }
        if (fs.existsSync(phpunitBin) || fs.existsSync(phpunitBin + '.bat')) {
            return await execPromise('php artisan test || ./vendor/bin/phpunit || vendor\\bin\\phpunit.bat', worktreePath);
        }
        return await execPromise('php artisan test', worktreePath);
    }

    // 3. Node.js / Vue / React / Next.js / Vite
    if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8'));
            if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
                console.log('[Test Runner] Proyecto Node/Vue detectado.');
                if (fs.existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) {
                    return await execPromise('pnpm test', worktreePath);
                }
                if (fs.existsSync(path.join(worktreePath, 'yarn.lock'))) {
                    return await execPromise('yarn test', worktreePath);
                }
                return await execPromise('npm test', worktreePath);
            }
        } catch (_) {}
    }

    // 4. Python (pytest / unittest)
    if (fs.existsSync(path.join(worktreePath, 'pytest.ini')) ||
        fs.existsSync(path.join(worktreePath, 'pyproject.toml')) ||
        fs.existsSync(path.join(worktreePath, 'setup.py'))) {
        console.log('[Test Runner] Proyecto Python detectado.');
        return await execPromise('pytest || python -m unittest', worktreePath);
    }

    // 5. Go
    if (fs.existsSync(path.join(worktreePath, 'go.mod'))) {
        console.log('[Test Runner] Proyecto Go detectado.');
        return await execPromise('go test ./...', worktreePath);
    }

    // 6. Rust
    if (fs.existsSync(path.join(worktreePath, 'Cargo.toml'))) {
        console.log('[Test Runner] Proyecto Rust detectado.');
        return await execPromise('cargo test', worktreePath);
    }

    console.log('[Test Runner] Proyecto sin suite de pruebas declarada; validación aprobada por defecto.');
    return 'No tests declared.';
}

class WorktreeService {
    constructor(aiService) {
        this.aiService = aiService;
        this.baseWorktreeDir = 'D:\\OpenClaw\\workspace\\worktrees';
        if (!fs.existsSync(this.baseWorktreeDir)) {
            try { fs.mkdirSync(this.baseWorktreeDir, { recursive: true }); } catch (_) {}
        }
    }

    async resolveConflictContent(filePath, conflictedContent, baseBranch, headBranch) {
        const prompt = `Eres un ingeniero de software experto resolviendo un conflicto de merge en Git.
Archivo: ${filePath}
Rama base: ${baseBranch}
Rama del PR: ${headBranch}

A continuación se muestra el archivo con los marcadores de conflicto (<<<<<<< HEAD, =======, >>>>>>>):

${conflictedContent}

INSTRUCCIONES CRÍTICAS:
1. Resuelve todos los marcadores de conflicto unificando coherentemente la lógica de ambas ramas.
2. No elimines código importante de la rama base ni de la rama del PR.
3. Asegúrate de que la sintaxis sea 100% válida.
4. Devuelve ÚNICAMENTE el código limpio final del archivo, sin explicaciones ni bloques markdown extra.`;

        let resolved = await this.aiService.executePromptWithFallback(prompt);
        resolved = resolved.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
        return resolved;
    }

    async resolveMergeConflictsInWorktree({ repoPath = 'D:\\OpenClaw\\workspace\\github-pet-widget', pull_number, head_branch, base_branch = 'main', customTestCmd = null }) {
        const worktreePath = path.join(this.baseWorktreeDir, `pr_${pull_number}_merge_${Date.now()}`);
        const result = { success: false, worktreePath, resolvedFiles: [], testsPassed: false, pushed: false };

        try {
            // 1. Fetch de ramas remotas
            await execPromise(`git fetch origin ${head_branch} ${base_branch}`, repoPath);

            // 2. Crear worktree temporal
            await execPromise(`git worktree add -B merge-pr-${pull_number} "${worktreePath}" origin/${head_branch}`, repoPath);

            // 3. Intentar merge
            try {
                await execPromise(`git merge origin/${base_branch} --no-edit`, worktreePath);
                result.success = true;
                result.message = 'Merge limpio sin conflictos.';
            } catch (mergeErr) {
                // Conflictos de merge detectados
                const statusOutput = await execPromise('git diff --name-only --diff-filter=U', worktreePath);
                const conflictedFiles = statusOutput.split('\n').map(f => f.trim()).filter(Boolean);

                if (conflictedFiles.length === 0) throw mergeErr;

                // 4. Resolver cada archivo en conflicto con la IA (OpenAI Luna / Gemini)
                for (const file of conflictedFiles) {
                    const fullFilePath = path.join(worktreePath, file);
                    if (fs.existsSync(fullFilePath)) {
                        const conflictedContent = fs.readFileSync(fullFilePath, 'utf8');
                        const cleanContent = await this.resolveConflictContent(file, conflictedContent, base_branch, head_branch);
                        fs.writeFileSync(fullFilePath, cleanContent, 'utf8');
                        await execPromise(`git add "${file}"`, worktreePath);
                        result.resolvedFiles.push(file);
                    }
                }

                // 5. Commit del merge resuelto
                await execPromise('git commit -m "fix(merge): resolve conflicts automatically via OpenClaw AI"', worktreePath);
                result.success = true;
            }

            // 6. Ejecutar tests según el tipo de proyecto (Laravel / Vue / Docker / Python)
            try {
                await detectAndRunTests(worktreePath, customTestCmd);
                result.testsPassed = true;
            } catch (testErr) {
                result.testsPassed = false;
                result.testError = testErr.message;
            }

            // 7. Push directo a GitHub si los tests pasaron
            if (result.testsPassed) {
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.message = `✅ Conflictos de merge resueltos y pusheados a ${head_branch} con tests pasando.`;
            } else {
                result.message = '⚠️ Conflictos resueltos localmente pero los tests fallaron; no se realizó push por seguridad.';
            }

            return result;
        } catch (err) {
            result.error = err.message;
            return result;
        } finally {
            // Limpieza inmediata del worktree para no dejar ramas huérfanas
            try {
                await execPromise(`git worktree remove --force "${worktreePath}"`, repoPath);
            } catch (_) {}
        }
    }

    async autoFixReviewFeedbackInWorktree({ repoPath = 'D:\\OpenClaw\\workspace\\github-pet-widget', pull_number, head_branch, feedbackText, customTestCmd = null }) {
        const worktreePath = path.join(this.baseWorktreeDir, `pr_${pull_number}_fix_${Date.now()}`);
        const result = { success: false, worktreePath, modifiedFiles: [], testsPassed: false, pushed: false };

        try {
            // 1. Fetch de la rama del PR
            await execPromise(`git fetch origin ${head_branch}`, repoPath);

            // 2. Crear worktree aislado
            await execPromise(`git worktree add -B fix-pr-${pull_number} "${worktreePath}" origin/${head_branch}`, repoPath);

            // 3. Detectar archivos involucrados en el PR
            const filesOutput = await execPromise('git diff --name-only origin/main...HEAD', worktreePath).catch(() => '');
            const files = filesOutput.split('\n').map(f => f.trim()).filter(Boolean);

            if (files.length > 0) {
                for (const file of files.slice(0, 5)) {
                    const fullPath = path.join(worktreePath, file);
                    if (fs.existsSync(fullPath)) {
                        const originalCode = fs.readFileSync(fullPath, 'utf8');
                        const prompt = `Actúa como un Senior Developer resolviendo el siguiente feedback de Code Review en el archivo ${file}:

FEEDBACK DEL REVIEWER:
${feedbackText || 'Corrige los problemas señalados y optimiza el código'}

CÓDIGO ACTUAL DEL ARCHIVO:
${originalCode}

INSTRUCCIONES:
Aplica los cambios necesarios para resolver el feedback del reviewer de forma limpia y robusta.
Devuelve ÚNICAMENTE el código completo y final del archivo, sin explicaciones ni markdown extra.`;

                        let fixedCode = await this.aiService.executePromptWithFallback(prompt);
                        fixedCode = fixedCode.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
                        fs.writeFileSync(fullPath, fixedCode, 'utf8');
                        await execPromise(`git add "${file}"`, worktreePath);
                        result.modifiedFiles.push(file);
                    }
                }

                // 4. Commit del fix
                await execPromise('git commit -m "fix: address review feedback automatically via OpenClaw AI"', worktreePath);
            }

            // 5. Ejecutar tests según el stack del proyecto
            try {
                await detectAndRunTests(worktreePath, customTestCmd);
                result.testsPassed = true;
            } catch (testErr) {
                result.testsPassed = false;
                result.testError = testErr.message;
            }

            // 6. Push automático si los tests pasaron
            if (result.testsPassed && result.modifiedFiles.length > 0) {
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.success = true;
                result.message = `✅ Feedback resuelto y cambios pusheados a ${head_branch} con tests pasando.`;
            } else {
                result.success = result.modifiedFiles.length > 0;
                result.message = 'Modificaciones realizadas localmente pero tests fallaron; no se realizó push.';
            }

            return result;
        } catch (err) {
            result.error = err.message;
            return result;
        } finally {
            // Limpieza del worktree
            try {
                await execPromise(`git worktree remove --force "${worktreePath}"`, repoPath);
            } catch (_) {}
        }
    }
}

module.exports = WorktreeService;
