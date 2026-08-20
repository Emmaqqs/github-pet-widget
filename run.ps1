# Script de arranque para GitHub Pet Widget
Write-Host "🚀 Iniciando GitHub Pet Widget..." -ForegroundColor Cyan

Set-Location -Path $PSScriptRoot

# Matar instancias previas para evitar bloqueos
Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force

# Iniciar la app
npm start