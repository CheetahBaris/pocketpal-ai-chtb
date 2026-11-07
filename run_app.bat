@echo off
echo Запуск приложения на Android устройстве

REM Получаем пакетное имя приложения (предполагаем, что это com.pocketpal.ai)
echo Проверка установленного приложения...
adb shell pm list packages | findstr pocketpal

echo.
echo Запуск приложения...
adb shell monkey -p com.pocketpal.ai 1

echo.
echo Приложение запущено!
pause