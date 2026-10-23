param(
    [ValidateSet('Start', 'Status', 'Pause', 'Monitor', 'Init')]
    [string]$Action = 'Status',
    [string]$Root = 'D:\VIPRPG-Rescue\uploaderjp-202611'
)

$ErrorActionPreference = 'Stop'
$taskPython = (Get-Command python.exe -ErrorAction Stop).Source
$taskScript = Join-Path $PSScriptRoot 'uploader_rescue.py'
& $taskPython -X faulthandler $taskScript --root $Root $Action.ToLowerInvariant()
if ($LASTEXITCODE -ne 0) {
    throw "Uploader rescue command failed with exit code $LASTEXITCODE. See $Root\logs."
}
