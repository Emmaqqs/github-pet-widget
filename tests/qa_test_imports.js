/**
 * TEST_QA_01: Validación de carga de módulos ESM y Device Flow
 * Este script simula la carga que realiza el proceso principal de Electron
 * para asegurar que las funciones importadas dinámicamente sean válidas.
 */
async function testImports() {
    console.log("🧪 QA-TEST-01: Verificando compatibilidad de módulos...");
    try {
        const authModule = await import("@octokit/auth-oauth-device");
        console.log("📦 Módulo @octokit/auth-oauth-device cargado.");
        
        // Intentar extraer la función de diferentes formas comunes en bundles ESM/CJS mixtos
        const createOAuthDeviceAuth = authModule.createOAuthDeviceAuth || 
                                        (authModule.default && authModule.default.createOAuthDeviceAuth);
        
        if (typeof createOAuthDeviceAuth === 'function') {
            console.log("✅ ÉXITO: createOAuthDeviceAuth es una función válida.");
        } else {
            console.error("❌ ERROR: createOAuthDeviceAuth no es una función.");
            console.log("Estructura del módulo:", Object.keys(authModule));
            process.exit(1);
        }

        const octokitModule = await import("octokit");
        if (octokitModule.Octokit || (octokitModule.default && octokitModule.default.Octokit)) {
            console.log("✅ ÉXITO: Octokit cargado correctamente.");
        } else {
            console.error("❌ ERROR: No se encontró la clase Octokit.");
            process.exit(1);
        }

    } catch (e) {
        console.error("❌ ERROR CRÍTICO EN CARGA:", e.message);
        process.exit(1);
    }
}

testImports();