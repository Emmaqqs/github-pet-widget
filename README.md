# 🐾 GitHub Pet Widget

Mascota de escritorio flotante para Windows (Always-on-Top, transparente y borderless) que monitorea tus Pull Requests en tiempo real sin consumir tokens de IA.

---

## 🎯 Estados de la Mascota

| Estado | Color | Condición |
|---|---|---|
| **Todo al día** | 🟢 Verde | Sin pendientes de revisión ni actividad pendiente. |
| **Revisión Requerida (Caso A)** | 🟠 Naranja | Te asignaron como reviewer en un PR abierto y no has hecho review. |
| **Re-revisión (Caso B)** | 🔵 Azul | Ya habías revisado un PR, pero el autor subió nuevos commits o cambios. |
| **Acción en tus PRs (Caso C)** | 🔴 Rojo | Dejaron aprobaciones (`APPROVED`) o solicitaron cambios (`CHANGES_REQUESTED`) en tus propios PRs. |
| **Desconectado** | ⚪ Gris | Esperando configuración del token. |

---

## 🚀 Inicio Rápido

1. Ejecuta el script de arranque:
   ```powershell
   cd D:\OpenClaw\workspace\github-pet-widget
   .\run.ps1
   ```
2. La mascota aparecerá en la esquina inferior derecha de tu pantalla.
3. Haz clic en el enlace **"🔑 Generar token en GitHub"** dentro de la burbuja (o ve a `github.com/settings/tokens/new` con permisos `repo` y `read:user`).
4. Pega tu token en el campo de texto y pulsa **"Guardar y Conectar"**.
5. ¡Listo! Tu token queda guardado de forma segura en tu perfil local y la mascota comenzará a monitorear tus PRs automáticamente cada 3 minutos.

---

## 🧪 Pruebas Automatizadas

Puedes correr la suite completa de QA en cualquier momento con:
```powershell
cd D:\OpenClaw\workspace\github-pet-widget
node tests/qa_test_suite.js
```