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

        let resolved = await this.aiService.callGeminiWithRotation(prompt);
        resolved = resolved.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
        return resolved;
    }

    async resolveMergeConflictsInWorktree({ repoPath = 'D:\\OpenClaw\\workspace\\github-pet-widget', pull_number, head_branch, base_branch = 'main' }) {
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

                // 4. Resolver cada archivo en conflicto con la IA
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

            // 6. Ejecutar tests del proyecto
            if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
                try {
                    await execPromise('npm test', worktreePath);
                    result.testsPassed = true;
                } catch (testErr) {
                    result.testsPassed = false;
                    result.testError = testErr.message;
                }
            } else {
                result.testsPassed = true;
            }

            // 7. Push directo a GitHub si los tests pasaron
            if (result.testsPassed) {
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.message = `✅ Conflictos de merge resueltos y pusheados a ${head_branch} con tests pasando.`;
            } else {
                result.message = '⚠️ Conflictos resueltos localmente pero los tests fallaron; no se realizó push.';
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

    async autoFixReviewFeedbackInWorktree({ repoPath = 'D:\\OpenClaw\\workspace\\github-pet-widget', pull_number, head_branch, feedbackText, diff }) {
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

                        let fixedCode = await this.aiService.callGeminiWithRotation(prompt);
                        fixedCode = fixedCode.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
                        fs.writeFileSync(fullPath, fixedCode, 'utf8');
                        await execPromise(`git add "${file}"`, worktreePath);
                        result.modifiedFiles.push(file);
                    }
                }

                // 4. Commit del fix
                await execPromise('git commit -m "fix: address review feedback automatically via OpenClaw AI"', worktreePath);
            }

            // 5. Ejecutar tests
            if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
                try {
                    await execPromise('npm test', worktreePath);
                    result.testsPassed = true;
                } catch (testErr) {
                    result.testsPassed = false;
                    result.testError = testErr.message;
                }
            } else {
                result.testsPassed = true;
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
