@echo off
echo =====================================================
echo Тестирование интеграции локального LLM сервера
echo =====================================================

echo.
echo Шаг 1: Проверка подключения устройства...
adb devices

echo.
echo Шаг 2: Установка APK файла...
adb install -r android\app\build\outputs\apk\prod\debug\app-prod-debug.apk

echo.
echo Шаг 3: Запуск приложения...
adb shell monkey -p com.pocketpal.ai 1

echo.
echo Тестирование завершено!
echo Пожалуйста, проверьте устройство:
echo 1. Приложение открыто
echo 2. Найдите Settings экран
echo 3. Проверьте наличие раздела "Local LLM Server"
echo 4. Убедитесь, что компонент ServerMenu отображается корректно

pause