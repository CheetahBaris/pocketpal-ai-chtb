# PowerShell script for building debug APK
param(
    [string]$flavor = "prod",
    [string]$buildType = "debug"
)

Write-Host "Building $flavor-$buildType APK..."

# Navigate to android directory and build
cd android
./gradlew assemble$flavor$buildType

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful!"
    # Find the generated APK
    $apkPath = Get-ChildItem -Path "app\build\outputs\apk\$flavor\$buildType" -Filter "*.apk" -Recurse
    Write-Host "APK location: $($apkPath.FullName)"
} else {
    Write-Host "Build failed with exit code: $LASTEXITCODE"
}

cd ..