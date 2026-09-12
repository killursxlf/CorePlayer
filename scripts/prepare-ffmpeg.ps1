$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cacheRoot = Join-Path $projectRoot '.ffmpeg-cache.local'
$destination = Join-Path $projectRoot 'src-tauri/resources/ffmpeg'
$version = '9.0.1'
$expectedHash = '2E8E28AF97C2AE338CCEF92E36DA9B2A4CD21D0CAD9DDE093545606CB07F5B00'
$url = "https://github.com/GyanD/codexffmpeg/releases/download/$version/ffmpeg-$version-full_build.zip"
$archive = Join-Path $cacheRoot "ffmpeg-$version.zip"
New-Item -ItemType Directory -Force -Path $cacheRoot, $destination | Out-Null
if (!(Test-Path -LiteralPath $archive)) {
    Write-Host "Downloading FFmpeg $version for the Windows installer..."
    Invoke-WebRequest -Uri $url -OutFile "$archive.download" -UseBasicParsing
    if ((Get-FileHash -LiteralPath "$archive.download" -Algorithm SHA256).Hash -ne $expectedHash) { throw 'FFmpeg archive checksum mismatch.' }
    Move-Item -LiteralPath "$archive.download" -Destination $archive -Force
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Cached FFmpeg archive checksum mismatch.' }
$stampPath = Join-Path $destination 'bundle.json'
$valid = $false
if (Test-Path -LiteralPath $stampPath) {
    $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json
    $valid = $stamp.archiveSha256 -eq $expectedHash
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt', 'README.txt')) {
        $file = Join-Path $destination $name
        if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $stamp.files.$name) { $valid = $false }
    }
}
if (!$valid) {
    Expand-Archive -LiteralPath $archive -DestinationPath $cacheRoot -Force
    $packageRoot = Join-Path $cacheRoot "ffmpeg-$version-full_build"
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) { Copy-Item -LiteralPath (Join-Path $packageRoot "bin/$name") -Destination (Join-Path $destination $name) -Force }
    Copy-Item -LiteralPath (Join-Path $packageRoot 'LICENSE') -Destination (Join-Path $destination 'LICENSE.txt') -Force
    Copy-Item -LiteralPath (Join-Path $packageRoot 'README.txt') -Destination (Join-Path $destination 'README.txt') -Force
    $files = @{}
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt', 'README.txt')) { $files[$name] = (Get-FileHash -LiteralPath (Join-Path $destination $name) -Algorithm SHA256).Hash }
    @{version=$version; archiveSha256=$expectedHash; download=$url; source='https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a'; distributor='https://www.gyan.dev/ffmpeg/builds/'; files=$files} | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $stampPath -Encoding UTF8
}
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
    $result = & (Join-Path $destination $name) -version
    if ($LASTEXITCODE -ne 0 -or $result[0] -notmatch "version $([regex]::Escape($version))") { throw "Bundled $name did not start correctly." }
    Write-Host $result[0]
}
