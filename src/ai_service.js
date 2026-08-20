const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const DEFAULT_REVIEW_PROMPT_TEMPLATE = `Actúa como un Senior Staff Software Engineer realizando un Code Review exhaustivo para el siguiente Pull Request.

Título del PR: {{pr_title}}
Repositorio: {{repository}}
Autor: @{{author}}
URL: {{pr_url}}

### CRITERIOS DE REVISIÓN:
1. 🛡️ Seguridad: Inyecciones, exposición de secretos, sanitización de inputs, validación de permisos.
2. 🚀 Rendimiento y Escalabilidad: Complejidad algorítmica, operaciones bloqueantes, consumo de memoria.
3. 🧹 Clean Code y Arquitectura: Principios SOLID, DRY, nombres claros, manejo de errores robusto.
4. 🧪 Cobertura de Pruebas: Casos límite, regresiones potenciales, tests faltantes.

### FORMATO DE SALIDA (Usa Markdown profesional):
## 📋 Resumen Ejecutivo
(1-2 oraciones resumiendo el propósito y la calidad del cambio)

## 🚦 Veredicto
- **Estado sugerido:** [ ✅ APROBAR / ⚠️ REQUERIR CAMBIOS / 💬 COMENTARIOS ]

## 🔍 Hallazgos Principales
(Lista de puntos clave identificados con nivel de severidad: [ALTA], [MEDIA], [BAJA])

## 💡 Sugerencias y Mejoras de Código
(Comentarios específicos con fragmentos de código sugeridos)
`;

const DEFAULT_AUTOFIX_COMMIT_TEMPLATE = `fix({{scope}}): {{summary}}

- Resuelve feedback de @{{reviewer}}: {{feedback_details}}
- Archivos modificados: {{modified_files}}
`;

const DEFAULT_MERGE_CONFLICT_TEMPLATE = `Analiza el conflicto de merge entre la rama base ({{base_branch}}) y la rama del PR ({{head_branch}}).
Prioriza la integridad lógica del sistema, preservando las nuevas funcionalidades sin borrar código crítico de la rama base.
`;

const DEFAULT_AUTOREVIEW_EVAL_TEMPLATE = `Evalúa si los nuevos commits subidos por @{{author}} resuelven satisfactoriamente el comentario de revisión previo:

Comentario previo: "{{previous_comment}}"
Diff de los nuevos cambios:
{{new_diff}}

Dictamen: Responde indicando si el cambio cumple el requerimiento (CUMPLIDO) o si aún tiene detalles pendientes (PENDIENTE), con una breve justificación en 1 párrafo.
`;

const GEMINI_MODELS_POOL = [
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.7-flash'
];

function loadGoogleKeys(explicitConfig = {}) {
    if (Array.isArray(explicitConfig.googleKeys) && explicitConfig.googleKeys.length > 0) {
        return explicitConfig.googleKeys;
    }
    try {
        const appDataPath = path.join(process.env.APPDATA || '', 'github-pet-widget', 'config.json');
        if (fs.existsSync(appDataPath)) {
            const appConfig = JSON.parse(fs.readFileSync(appDataPath, 'utf8'));
            if (Array.isArray(appConfig.googleKeys) && appConfig.googleKeys.length > 0) {
                return appConfig.googleKeys;
            }
        }
    } catch (_) {}

    try {
        const openClawConfigPath = 'D:\\OpenClaw\\data\\openclaw.json';
        if (fs.existsSync(openClawConfigPath)) {
            const oc = JSON.parse(fs.readFileSync(openClawConfigPath, 'utf8'));
            const keys = [];
            if (oc.auth?.profiles) {
                Object.values(oc.auth.profiles).forEach(p => {
                    if (p.provider === 'google' && p.key) keys.push(p.key);
                });
            }
            if (keys.length > 0) return keys;
        }
    } catch (_) {}

    return [];
}

class AIService {
    constructor(config = {}) {
        this.config = config;
        this.googleKeys = loadGoogleKeys(config);
        this.currentKeyIndex = 0;
        this.currentModelIndex = 0;
    }

    getTemplates() {
        return {
            review_prompt_template: this.config.review_prompt_template || DEFAULT_REVIEW_PROMPT_TEMPLATE,
            autofix_commit_template: this.config.autofix_commit_template || DEFAULT_AUTOFIX_COMMIT_TEMPLATE,
            merge_conflict_template: this.config.merge_conflict_template || DEFAULT_MERGE_CONFLICT_TEMPLATE,
            autoreview_eval_template: this.config.autoreview_eval_template || DEFAULT_AUTOREVIEW_EVAL_TEMPLATE,
        };
    }

    interpolate(template, variables) {
        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
            result = result.replace(regex, String(value ?? ''));
        }
        return result;
    }

    // Intenta usar OpenAI Luna vía OpenClaw CLI si está disponible
    async callOpenAILuna(prompt) {
        return new Promise((resolve, reject) => {
            const sanitizedPrompt = prompt.replace(/"/g, '\\"').slice(0, 4000);
            const cmd = `openclaw agent --model openai/gpt-5.6-luna --message "${sanitizedPrompt}"`;
            exec(cmd, { cwd: 'D:\\OpenClaw', timeout: 45000 }, (error, stdout, stderr) => {
                if (!error && stdout && stdout.length > 20) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(stderr || error?.message || 'OpenClaw Luna no disponible'));
                }
            });
        });
    }

    // Generador principal con rotación de modelos y claves de Gemini
    async callGeminiWithRotation(prompt) {
        if (!this.googleKeys || this.googleKeys.length === 0) {
            this.googleKeys = loadGoogleKeys(this.config);
        }

        const totalModels = GEMINI_MODELS_POOL.length;
        const totalKeys = this.googleKeys.length;

        for (let m = 0; m < totalModels; m++) {
            const model = GEMINI_MODELS_POOL[(this.currentModelIndex + m) % totalModels];
            for (let k = 0; k < totalKeys; k++) {
                const key = this.googleKeys[(this.currentKeyIndex + k) % totalKeys];
                try {
                    const result = await this._requestGemini(key, model, prompt);
                    this.currentModelIndex = (this.currentModelIndex + m) % totalModels;
                    this.currentKeyIndex = (this.currentKeyIndex + k) % totalKeys;
                    return result;
                } catch (err) {
                    // Si falla por quota, timeout o 503, continúa al siguiente modelo/clave
                    continue;
                }
            }
        }
        throw new Error('Todos los modelos de Gemini y claves de Google AI Studio están temporalmente saturados.');
    }

    _requestGemini(apiKey, model, prompt) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096,
                }
            });

            const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const options = {
                hostname: 'generativelanguage.googleapis.com',
                port: 443,
                path: path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 20000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) resolve(text);
                            else reject(new Error('Respuesta vacía de Gemini'));
                        } else {
                            reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout en solicitud a Gemini'));
            });

            req.write(payload);
            req.end();
        });
    }

    async generateCodeReview(pr, diff) {
        const templates = this.getTemplates();
        const basePrompt = this.interpolate(templates.review_prompt_template, {
            pr_title: pr.title,
            repository: pr.repository || 'repo',
            author: pr.author,
            pr_url: pr.url
        });

        const diffExcerpt = (diff || '').slice(0, 30000);
        const fullPrompt = basePrompt + '\n\n### DIFF DEL PULL REQUEST:\n```diff\n' + diffExcerpt + '\n```';

        // Intenta primero con OpenAI Luna si está disponible, si no, usa el pool rotativo de Gemini
        try {
            return await this.callOpenAILuna(fullPrompt);
        } catch (_) {
            return await this.callGeminiWithRotation(fullPrompt);
        }
    }

    async evaluateAutoPilot(pr, previousComment, newDiff) {
        const templates = this.getTemplates();
        const fullPrompt = this.interpolate(templates.autoreview_eval_template, {
            author: pr.author,
            previous_comment: previousComment || 'Revisión solicitada',
            new_diff: (newDiff || '').slice(0, 15000)
        });

        // Para auditoría y auto-pilot, usamos Gemini (gratuito y ultra rápido)
        return await this.callGeminiWithRotation(fullPrompt);
    }
}

module.exports = {
    AIService,
    DEFAULT_REVIEW_PROMPT_TEMPLATE,
    DEFAULT_AUTOFIX_COMMIT_TEMPLATE,
    DEFAULT_MERGE_CONFLICT_TEMPLATE,
    DEFAULT_AUTOREVIEW_EVAL_TEMPLATE
};
