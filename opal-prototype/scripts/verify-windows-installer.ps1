param(
  [Parameter(Mandatory = $true)][string]$CurrentInstaller,
  [Parameter(Mandatory = $true)][string]$BaselineInstaller,
  [Parameter(Mandatory = $true)][string]$UpgradeFixture
)

$ErrorActionPreference = "Stop"
$CurrentInstaller = (Resolve-Path $CurrentInstaller).Path
$BaselineInstaller = (Resolve-Path $BaselineInstaller).Path
$UpgradeFixture = (Resolve-Path $UpgradeFixture).Path
$InstallDirectory = Join-Path $env:RUNNER_TEMP "opal-current-user-install"
$LibraryDirectory = Join-Path $env:APPDATA "com.opal.library"
$DatabasePath = Join-Path $LibraryDirectory "opal.sqlite"

function Install-CurrentUser([string]$Installer) {
  $process = Start-Process -FilePath $Installer -ArgumentList @("/S", "/D=$InstallDirectory") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
  if (-not (Test-Path $InstallDirectory)) {
    throw "Current-user installation directory was not created."
  }
}

function Start-And-CheckApp([string]$stage) {
  $application = Get-ChildItem -Path $InstallDirectory -Filter "*.exe" -Recurse |
    Where-Object { $_.Name -notmatch "^(unins|uninstall)" } |
    Select-Object -First 1
  if (-not $application) {
    throw "Could not find the installed OPAL executable during $stage."
  }

  $process = Start-Process -FilePath $application.FullName -PassThru
  Start-Sleep -Seconds 7
  $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  if (-not $running) {
    throw "OPAL exited during the $stage launch smoke check."
  }
  Stop-Process -Id $process.Id -Force
  Start-Sleep -Milliseconds 500

  if (-not (Test-Path $DatabasePath)) {
    throw "OPAL did not leave its library database available after $stage."
  }
}

function Get-LibraryCounts {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $manifestPath = Join-Path $projectRoot "src-tauri/Cargo.toml"
  $result = & cargo run --quiet --manifest-path $manifestPath --example inspect-library -- $DatabasePath
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the OPAL upgrade fixture database."
  }
  return ($result | ConvertFrom-Json)
}

function Assert-SameLibrary($before, $after, [string]$stage) {
  if ($before.projects -ne $after.projects -or $before.tracks -ne $after.tracks) {
    throw "Library project or track counts changed unexpectedly during $stage."
  }
}

function Uninstall-CurrentUser {
  Stop-Process -Name opal -Force -ErrorAction SilentlyContinue
  $uninstaller = Get-ChildItem -Path $InstallDirectory -Filter "*unins*.exe" -Recurse |
    Select-Object -First 1
  if (-not $uninstaller) {
    $uninstaller = Get-ChildItem -Path $InstallDirectory -Filter "*uninstall*.exe" -Recurse |
      Select-Object -First 1
  }
  if (-not $uninstaller) {
    throw "Could not find the NSIS uninstaller."
  }
  $process = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($process.ExitCode)."
  }
  if (Test-Path $InstallDirectory) {
    Remove-Item -Path $InstallDirectory -Recurse -Force
  }
}

if (Test-Path $LibraryDirectory) {
  $existingEntries = @(Get-ChildItem -Force $LibraryDirectory -ErrorAction SilentlyContinue)
  if ($existingEntries.Count -gt 0) {
    throw "Refusing to run the installer smoke test over a non-empty OPAL library."
  }
}

New-Item -ItemType Directory -Path $LibraryDirectory -Force | Out-Null
Copy-Item -Path (Join-Path $UpgradeFixture "*") -Destination $LibraryDirectory -Recurse -Force
if (-not (Test-Path $DatabasePath)) {
  throw "The upgrade fixture does not contain opal.sqlite."
}

Install-CurrentUser $BaselineInstaller
Start-And-CheckApp "baseline version"
$baselineCounts = Get-LibraryCounts
if ($baselineCounts.schema -lt 1 -or $baselineCounts.projects -lt 1 -or $baselineCounts.tracks -lt 1) {
  throw "The baseline fixture did not open with a valid schema and library content."
}

Install-CurrentUser $CurrentInstaller
Start-And-CheckApp "current alpha upgrade"
$currentCounts = Get-LibraryCounts
Assert-SameLibrary $baselineCounts $currentCounts "baseline to current alpha upgrade"

$sentinel = Join-Path $LibraryDirectory ".opal-uninstall-preservation-check"
Set-Content -Path $sentinel -Value "Keep local library data" -NoNewline
Uninstall-CurrentUser
if (-not (Test-Path $sentinel) -or -not (Test-Path $DatabasePath)) {
  throw "Uninstall removed OPAL library data; expected the user library to remain."
}

Install-CurrentUser $CurrentInstaller
Start-And-CheckApp "current alpha reinstall"
$reinstalledCounts = Get-LibraryCounts
Assert-SameLibrary $currentCounts $reinstalledCounts "current alpha reinstall"
if (-not (Test-Path $sentinel)) {
  throw "Reinstall did not preserve the existing OPAL user data."
}

Uninstall-CurrentUser
if (-not (Test-Path $sentinel) -or -not (Test-Path $DatabasePath)) {
  throw "Final uninstall removed the OPAL library; it must remain in user data."
}

Write-Host "Windows current-user install, launch, upgrade, uninstall, and reinstall passed."
