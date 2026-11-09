param(
    [Parameter(Mandatory)][string]$AppPath,
    [Parameter(Mandatory)][string]$OutDir,
    # Wildcard on the check file name without .ps1, such as "lossless-*".
    [string]$Filter = '*'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$AppPath = (Resolve-Path $AppPath).Path
$OutDir = (Resolve-Path $OutDir).Path

foreach ($tool in 'ffmpeg', 'ffprobe') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" }
}

$checks = @(Get-ChildItem (Join-Path $PSScriptRoot 'checks') -Filter '*.ps1' |
    Where-Object { $_.BaseName -like $Filter } | Sort-Object Name)
if ($checks.Count -eq 0) { throw "no checks match '$Filter'" }

# Test clips, made once. Kept out of the artifact.
$media = Join-Path ([IO.Path]::GetTempPath()) 'fc-ui-media'
New-Item -ItemType Directory -Force -Path $media | Out-Null
$clips = [ordered]@{
    # A WebView2 <video> cannot play WMV, which is the case the lossless container fix is about.
    'clip.wmv'  = @('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
                    '-t', '6', '-c:v', 'wmv2', '-b:v', '1500k', '-g', '30', '-c:a', 'wmav2', '-b:a', '128k')
    'clip.mp4'  = @('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                    '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-movflags', '+faststart')
    # Long enough that its export is still running when the close check closes the window.
    'long.mp4'  = @('-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
                    '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-movflags', '+faststart')
    # An existing file for exports to overwrite. Different content from every export.
    'other.mp4' = @('-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p')
}
foreach ($name in $clips.Keys) {
    $path = Join-Path $media $name
    if (Test-Path $path) { continue }
    $start = Get-Date
    & ffmpeg -hide_banner -loglevel error -y @($clips[$name]) $path
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $path)) { throw "ffmpeg could not make $name" }
    Write-Host ("made {0} ({1:N0} KB) in {2:N0} s" -f $name, ((Get-Item $path).Length / 1KB), ((Get-Date) - $start).TotalSeconds)
}

$results = foreach ($check in $checks) {
    $dir = Join-Path $OutDir $check.BaseName
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $log = Join-Path $dir 'log.txt'

    $work = Join-Path ([IO.Path]::GetTempPath()) "fc-ui-work-$($check.BaseName)"
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    $env:FC_UI_APP = $AppPath
    $env:FC_UI_OUT = $dir
    $env:FC_UI_WORK = $work
    $env:FC_UI_MEDIA = $media
    $env:FC_UI_MODULE = Join-Path $PSScriptRoot 'Fc.psm1'

    Write-Host "::group::$($check.BaseName)"
    $start = Get-Date
    & pwsh -NoProfile -File $check.FullName *>&1 | Tee-Object -FilePath $log | Out-Host
    $code = $LASTEXITCODE
    $seconds = [int]((Get-Date) - $start).TotalSeconds

    Import-Module $env:FC_UI_MODULE -Force
    # A check that throws leaves the app or an export running, which would spoil the next check.
    Stop-FcAll
    Write-Host '::endgroup::'

    $line = if ($code -eq 0) { "PASS $($check.BaseName)" } else { "FAIL $($check.BaseName)" }
    Write-Host $line
    [pscustomobject]@{ Check = $check.BaseName; Passed = ($code -eq 0); Seconds = $seconds }
}

$summary = @('| Check | Result | Seconds |', '| --- | --- | ---: |')
$summary += $results | ForEach-Object { "| $($_.Check) | $(if ($_.Passed) { 'PASS' } else { '**FAIL**' }) | $($_.Seconds) |" }
$summary | Set-Content -Encoding utf8 (Join-Path $OutDir 'summary.md')
if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content -Encoding utf8 $env:GITHUB_STEP_SUMMARY }
$summary | Out-Host

if ($results | Where-Object { -not $_.Passed }) { exit 1 }
