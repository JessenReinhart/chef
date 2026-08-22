param(
  [switch]$Quiet,
  [switch]$StartMenu
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") { exit 0 }

$root = Split-Path -Parent $PSScriptRoot
$asset = Join-Path $root "assets\chef-icon.svg"
$cmd = Join-Path $root "Chef.cmd"
$brandDir = Join-Path $env:LOCALAPPDATA "Chef\branding"
$iconPath = Join-Path $brandDir "chef.ico"
$rootShortcut = Join-Path $root "Chef.lnk"

function Write-ChefInfo([string]$Message) {
  if (-not $Quiet) { Write-Host "[Chef] $Message" }
}

if (-not (Test-Path $asset)) { throw "Chef brand asset was not found: $asset" }
if (-not (Test-Path $cmd)) { throw "Chef launcher was not found: $cmd" }

New-Item -ItemType Directory -Force -Path $brandDir | Out-Null

# The repository keeps one canonical SVG wrapper around the selected raster
# artwork. Extract its embedded image and materialize a Windows .ico locally.
$svg = [System.IO.File]::ReadAllText($asset)
$match = [System.Text.RegularExpressions.Regex]::Match($svg, 'base64,([^"'']+)')
if (-not $match.Success) { throw "Chef brand asset does not contain embedded image data." }

$bytes = [Convert]::FromBase64String($match.Groups[1].Value)
$stream = [System.IO.MemoryStream]::new($bytes)

Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromStream($stream)
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.DrawImage($source, 0, 0, 256, 256)

$iconHandle = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$file = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create)
$icon.Save($file)
$file.Dispose()
$icon.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$source.Dispose()
$stream.Dispose()

$shell = New-Object -ComObject WScript.Shell

function Save-ChefShortcut([string]$Path) {
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $cmd
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = "Chef local AI workspace"
  $shortcut.Save()
}

Save-ChefShortcut $rootShortcut
Write-ChefInfo "Branded launcher ready: $rootShortcut"

if ($StartMenu) {
  $programs = [Environment]::GetFolderPath("Programs")
  if ($programs) {
    $startMenuShortcut = Join-Path $programs "Chef.lnk"
    Save-ChefShortcut $startMenuShortcut
    Write-ChefInfo "Start Menu shortcut ready: $startMenuShortcut"
  }
}
