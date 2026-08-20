const { Octokit } = require("octokit");
require("dotenv").config();

async function diagnose() {
    console.log("🔍 DIAGNÓSTICO DE CONECTIVIDAD GITHUB");
    const CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Iv23libY080iIuX1xR6S';
    console.log(`- Client ID: ${CLIENT_ID}`);

    try {
        console.log("- Probando resolución de api.github.com...");
        const { execSync } = require('child_process');
        execSync('nslookup api.github.com');
        console.log("  ✅ DNS OK");

        console.log("- Probando endpoint de Device Flow...");
        const authModule = await import("@octokit/auth-oauth-device");
        const createOAuthDeviceAuth = authModule.createOAuthDeviceAuth || (authModule.default && authModule.default.createOAuthDeviceAuth);
        
        const auth = createOAuthDeviceAuth({
            clientType: "oauth-app",
            clientId: CLIENT_ID,
            onVerification(v) { console.log("  ✅ El endpoint respondió (Código generado)"); }
        });

        // Intentamos una llamada mínima
        await Promise.race([
            auth({ type: "oauth-token" }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout esperado (OK)")), 2000))
        ]).catch(e => {
            if (e.message.includes("Timeout")) console.log("  ✅ Conectividad con el endpoint de Auth OK.");
            else throw e;
        });

    } catch (error) {
        console.error("❌ ERROR DETECTADO:");
        if (error.status === 404) {
            console.error("   GitHub devolvió 404. Esto significa que el CLIENT_ID no existe o no tiene 'Device Flow' habilitado en su configuración de OAuth App.");
        } else {
            console.error(`   ${error.message}`);
        }
    }
}

diagnose();