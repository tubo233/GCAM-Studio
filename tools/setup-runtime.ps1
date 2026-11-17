param(
    [string]$Python = 'python',
    [string]$Rscript = 'Rscript',
    [string]$ProxyUri = 'http://127.0.0.1:1080',
    [switch]$SkipNode,
    [switch]$SkipR
)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $studioRoot

function Invoke-Download([string]$Program, [string[]]$Arguments) {
    $previous = @{}
    foreach ($key in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
    try {
        $env:HTTP_PROXY = $ProxyUri; $env:HTTPS_PROXY = $ProxyUri; $env:ALL_PROXY = $ProxyUri
        $env:NO_PROXY = 'localhost,127.0.0.1'
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            Write-Host "Proxy attempt $attempt/3 : $Program"
            & $Program @Arguments
            if ($LASTEXITCODE -eq 0) { return }
        }
        Write-Warning 'Three proxy attempts failed; falling back to a direct connection for this operation.'
        $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''; $env:ALL_PROXY = ''
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Download/install failed: $Program" }
    } finally {
        foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
    }
}

& $Python -m venv runtime/venv
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer is required.' }
$venvPython = Join-Path $studioRoot 'runtime/venv/Scripts/python.exe'
Invoke-Download $venvPython @('-m','pip','install','--retries','0','--timeout','20','-r','backend/requirements-dev.txt')
if (-not $SkipNode) { Invoke-Download 'npm.cmd' @('ci','--fetch-retries=0','--fetch-timeout=20000') }
if (-not $SkipR) {
    $rCode = 'dir.create("runtime/r-lib",recursive=TRUE,showWarnings=FALSE); install.packages(c("assertthat","dplyr","tidyr","readr","data.table","stringr","pkgload","xml2"),lib="runtime/r-lib",repos="https://cloud.r-project.org",type="binary")'
    Invoke-Download $Rscript @('--vanilla','-e',$rCode)
}
Write-Host 'Runtime ready. Add runtime/venv/Scripts to PATH before npm run build.'
