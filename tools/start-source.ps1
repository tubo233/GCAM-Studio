param(
    [switch]$NoBrowser,
    [switch]$CheckOnly,
    [switch]$SkipUpdate,
    [int]$Port = 0
)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $studioRoot
$env:PYTHONUTF8 = '1'
$candidates = New-Object 'System.Collections.Generic.List[string]'
foreach ($relative in @('runtime/venv-source/Scripts/python.exe','runtime/venv-local/Scripts/python.exe','runtime/venv/Scripts/python.exe')) {
    $candidate = Join-Path $studioRoot $relative
    if (Test-Path -LiteralPath $candidate) { $candidates.Add($candidate) }
}
$pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($pyLauncher) {
    foreach ($version in @('3.13','3.12','3.14','3.11','3')) {
        $ErrorActionPreference = 'Continue'
        $found = & $pyLauncher.Source "-$version" -c 'import sys; print(sys.executable)' 2>$null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -eq 0 -and $found) { $candidates.Add(($found | Select-Object -Last 1)) }
    }
}
$systemPython = Get-Command python.exe -ErrorAction SilentlyContinue
if ($systemPython -and $systemPython.Source -notlike '*\WindowsApps\*') { $candidates.Add($systemPython.Source) }
foreach ($registryRoot in @('HKCU:\Software\Python\PythonCore','HKLM:\Software\Python\PythonCore')) {
    if (Test-Path $registryRoot) {
        foreach ($key in Get-ChildItem $registryRoot) {
            $install = Get-ItemProperty ($key.PSPath + '\InstallPath') -ErrorAction SilentlyContinue
            if ($install.ExecutablePath) { $candidates.Add($install.ExecutablePath) }
        }
    }
}
$selectedPython = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $ErrorActionPreference = 'Continue'
    & $candidate -c "import sys,struct; sys.exit(not(sys.version_info >= (3,11) and struct.calcsize('P')==8))" 2>$null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -eq 0) { $selectedPython = $candidate; break }
}
if (-not $selectedPython) {
    Write-Host '64-bit Python 3.11+ is required. Install Python, then run this launcher again.'
    Write-Host 'https://www.python.org/downloads/windows/'
    exit 1
}
$launchArgs = @()
if ($NoBrowser) { $launchArgs += '--no-browser' }
if ($CheckOnly) { $launchArgs += '--check' }
if ($SkipUpdate) { $launchArgs += '--skip-update' }
if ($Port -gt 0) { $launchArgs += @('--port', [string]$Port) }
& $selectedPython -X utf8 (Join-Path $PSScriptRoot 'start_source.py') @launchArgs
$sourceExit = $LASTEXITCODE
if ($sourceExit -eq 42) {
    Write-Host '[Update] Starting the updated source...'
    # This PowerShell process is outside the old Python Job Object.
    if ($launchArgs -notcontains '--skip-update') { $launchArgs += '--skip-update' }
    & $selectedPython -X utf8 (Join-Path $PSScriptRoot 'start_source.py') @launchArgs
    $sourceExit = $LASTEXITCODE
}
exit $sourceExit
