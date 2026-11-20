import { isAbsolute, join } from 'node:path'
import { expandPathVariables, isNetworkPath } from '../lib/localPath'
import { run } from '../lib/run'

interface WindowsModelLocations {
  places: string[]
  installations: string[]
}

/**
 * Reads only fixed install facts: drives' Program Files folders, the Uninstall
 * registry keys and the Start Menu and Desktop shortcuts of the target apps.
 * Every top-level statement ends with a blank line because `-Command -` runs a
 * multi-line statement only after an empty line, as at an interactive prompt.
 */
const query = String.raw`
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$products='(?i)comfyui|comfy[-_ ]desktop|stable[- _]diffusion|sd[-_ ]webui|webui[-_ ]forge|^forge($|[-_ ])'
$launch='(?i)^(comfyui\.exe|comfy desktop\.exe|folder_paths\.py|launch\.py|webui\.(py|bat|sh)|webui-user\.(bat|sh)|run_(nvidia_gpu|cpu).*\.bat)$'
$installations=[Collections.Generic.List[string]]::new()

function Add-Location($value) {
  if ($value -is [string]) {
    $path=$value.Trim().Trim('"')
    if ($path -match '^([a-zA-Z]:[\\/]|%[A-Za-z0-9_()]+%[\\/])') { $installations.Add($path) }
  }
}

# Volume names only: each fixed drive's Program Files folders are fixed install places.
$places=foreach ($drive in [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady }) {
  [IO.Path]::Combine($drive.Name,'Program Files')
  [IO.Path]::Combine($drive.Name,'Program Files (x86)')
}

$places+=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('MyDocuments'))

@{ places=@($places|Where-Object { $_ }) } | ConvertTo-Json -Compress

foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  Get-ItemProperty -Path $key | Where-Object DisplayName -Match $products | ForEach-Object {
    Add-Location $_.InstallLocation
  }
}

$wsh=New-Object -ComObject WScript.Shell

foreach ($folder in @([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Desktop'))) {
  if (!$folder) { continue }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse -Depth 1 |
    Where-Object { $_.BaseName -match $products -or $_.BaseName -match $launch -or $_.BaseName -match '(?i)^webui-user$|^run_(cpu|nvidia_gpu)' } |
    Select-Object -First 80 | ForEach-Object {
      $shortcut=$wsh.CreateShortcut($_.FullName)
      Add-Location $shortcut.WorkingDirectory
      if ($shortcut.TargetPath) {
        Add-Location $shortcut.TargetPath
        Add-Location (Split-Path -Parent $shortcut.TargetPath)
      }
    }
}

@{ installations=@($installations|Select-Object -Unique) } | ConvertTo-Json -Compress

`

/** How long the PowerShell query may take; `run` caps what it captures. */
const DISCOVERY_TIMEOUT_MS = 6000

/** PowerShell queries still running; quitting ends them. */
const running = new Set<AbortController>()

export function stopModelSourceDiscovery(): void {
  for (const controller of running) controller.abort()
  running.clear()
}

/** A local drive path with only the allowed variables expanded; anything else is dropped. */
function localPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(expandPathVariables)
    .filter((path) => isAbsolute(path) && /^[a-z]:[\\/]/i.test(path) && !isNetworkPath(path))
}

export async function windowsModelLocations(): Promise<WindowsModelLocations> {
  const locations: WindowsModelLocations = { places: [], installations: [] }
  if (process.platform !== 'win32') return locations
  const system = process.env.SystemRoot ?? process.env.WINDIR
  if (!system) return locations
  const shell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const controller = new AbortController()
  running.add(controller)
  try {
    const result = await run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      input: query,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      signal: controller.signal,
    })
    // A query cut short by the timeout still printed the lines it finished.
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      const text = line.trim()
      if (!text.startsWith('{') || !text.endsWith('}')) continue
      try {
        const data = JSON.parse(text) as { places?: unknown; installations?: unknown }
        if (data.places) locations.places = localPaths(data.places)
        if (data.installations) locations.installations = localPaths(data.installations)
      } catch {
        // A line that only looks like JSON: the other lines still count.
      }
    }
  } finally {
    running.delete(controller)
  }
  return locations
}
