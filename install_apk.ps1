# Скрипт для установки правильного APK файла
param(
    [string]$apkPath = "android\app\build\outputs\apk\prod\debug\app-prod-debug.apk"
)

Write-Host "Проверка наличия APK файла: $apkPath"
if (Test-Path $apkPath) {
    Write-Host "Файл найден, начинаем установку..."
    adb install -r $apkPath
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Установка прошла успешно!"
    } else {
        Write-Host "Ошибка при установке: $LASTEXITCODE"
    }
} else {
    Write-Host "Файл не найден: $apkPath"
    Write-Host "Доступные APK файлы:"
    Get-ChildItem -Path android\app\build\outputs\apk\ -Include "*.apk" -Recurse
}