@echo off
echo Установка debug APK на Android устройство
echo Проверка подключения устройства...

REM Проверяем, есть ли подключенные устройства
adb devices

echo.
echo Ожидание подключения устройства...
echo Если устройство не подключено, подключите его через USB и разрешите отладку
echo.

echo Установка APK файла...
adb install -r android\app\build\outputs\apk\prod\debug\app-prod-debug.apk

echo.
echo Установка завершена!
echo Если возникли ошибки, проверьте:
echo 1. Подключено ли устройство к компьютеру
echo 2. Включена ли отладка по USB на устройстве
echo 3. Установлен ли Android SDK и ADB

pause