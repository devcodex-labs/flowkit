[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Node,[switch]$DisposableRunner)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$DisposableRunner) { throw 'Use an explicitly designated disposable Windows runner' }
if ($PSVersionTable.PSEdition -ne 'Desktop' -or ![Environment]::Is64BitProcess) {
  throw 'Use 64-bit Windows PowerShell for LocalAccounts and DirectorySecurity'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$operator = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$operator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Provisioning the disposable account pair requires an elevated bootstrap'
}
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$Node = (Resolve-Path -LiteralPath $Node).Path
$parent = [Environment]::GetFolderPath('CommonApplicationData')
$suffix = [Guid]::NewGuid().ToString('N').Substring(0,12)
$root = Join-Path $parent "FlowKit-Profile-$suffix"
$publicDir = Join-Path $root 'public'
$hostDir = Join-Path $root 'host-private'
$modelDir = Join-Path $root 'model-scratch'
$hostUser = $modelUser = $hostProcess = $modelProcess = $null
$admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$hostPassword = ConvertTo-SecureString ('Fk1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
$modelPassword = ConvertTo-SecureString ('Fk1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force

function New-ProtectedDirectory([string]$Path,[hashtable[]]$Grants) {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true,$false)
  foreach ($sid in @($admins,$system)) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'
    ))
  }
  foreach ($grant in $Grants) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $grant.Sid,$grant.Rights,'ContainerInherit,ObjectInherit','None','Allow'
    ))
  }
  [void][IO.Directory]::CreateDirectory($Path,$security)
}

function Read-Record([string]$Path) {
  return (Get-Content -LiteralPath $Path -Encoding UTF8 -Raw | ConvertFrom-Json)
}

function Wait-Record($Child,[string]$Path) {
  $deadline = [DateTime]::UtcNow.AddSeconds(18)
  while (![IO.File]::Exists($Path)) {
    if ($Child.HasExited) { throw "Worker $($Child.Id) exited before producing its record" }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Worker startup timed out' }
    Start-Sleep -Milliseconds 100
  }
  return Read-Record $Path
}

function Start-ProfileWorker($Account,[Security.SecureString]$Password,[string]$Role,[string]$Scratch,[string]$TargetId='') {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Join-Path $publicDir 'node.exe'
  $start.WorkingDirectory = $publicDir
  $arguments = @((Join-Path $publicDir 'tests\security\secure-host-worker.mjs'),$Role,$root)
  if ($TargetId) { $arguments += $TargetId }
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = 'Hidden'
  $start.Domain = $env:COMPUTERNAME
  $start.UserName = $Account.Name
  $start.Password = $Password
  $start.EnvironmentVariables.Clear()
  $start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
  $start.EnvironmentVariables['ComSpec'] = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $start.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
  $start.EnvironmentVariables['TEMP'] = $Scratch
  $start.EnvironmentVariables['TMP'] = $Scratch
  if ($Role -eq 'host') { $start.EnvironmentVariables['FLOWKIT_HOST_CANARY'] = 'flowkit-disposable-host-fixture' }
  $child = [Diagnostics.Process]::Start($start)
  Write-Host (@{event='spawn';role=$Role;pid=$child.Id;account=$Account.Name;sid=$Account.SID.Value;
    executable=$start.FileName;arguments=$arguments} | ConvertTo-Json -Compress)
  return $child
}

function Wait-Success($Child,[int]$TimeoutMilliseconds) {
  if (!$Child.WaitForExit($TimeoutMilliseconds)) { throw "Worker $($Child.Id) timed out" }
  if ($Child.ExitCode -ne 0) { throw "Worker $($Child.Id) exited $($Child.ExitCode)" }
}

try {
  $hostUser = New-LocalUser -Name "fkh$suffix" -Password $hostPassword -Description 'FlowKit disposable Host profile'
  $modelUser = New-LocalUser -Name "fkm$suffix" -Password $modelPassword -Description 'FlowKit disposable model profile'
  foreach ($account in @($hostUser,$modelUser)) {
    if (!(Get-LocalGroupMember -SID $users | Where-Object { $_.SID -eq $account.SID })) {
      Add-LocalGroupMember -SID $users -Member $account
    }
  }
  New-ProtectedDirectory $root @(
    @{Sid=$hostUser.SID;Rights='ReadAndExecute'}
    @{Sid=$modelUser.SID;Rights='ReadAndExecute'}
  )
  New-ProtectedDirectory $hostDir @(@{Sid=$hostUser.SID;Rights='Modify'})
  New-ProtectedDirectory $modelDir @(@{Sid=$modelUser.SID;Rights='Modify'})
  [void][IO.Directory]::CreateDirectory($publicDir)
  foreach ($file in @(
    'tests\security\secure-host-worker.mjs','tests\security\secure-host-win-process.ps1',
    'src\interactive\sqlite-store.mjs','src\interactive\canonical.mjs'
  )) {
    $destination = Join-Path $publicDir $file
    [void][IO.Directory]::CreateDirectory((Split-Path $destination -Parent))
    Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $destination
  }
  Copy-Item -LiteralPath $Node -Destination (Join-Path $publicDir 'node.exe')
  [IO.File]::WriteAllText((Join-Path $publicDir 'task.json'),"flowkit-public-task`n")

  $hostProcess = Start-ProfileWorker $hostUser $hostPassword 'host' $hostDir
  $ready = Wait-Record $hostProcess (Join-Path $hostDir 'host-ready.json')
  if ($ready.pid -ne $hostProcess.Id -or $ready.identity.sid -ne $hostUser.SID.Value) { throw 'Host SID/PID mismatch' }
  Write-Host ($ready | ConvertTo-Json -Depth 8 -Compress)
  foreach ($resource in @($root,$publicDir,$hostDir,$modelDir)+
    @($ready.files.PSObject.Properties.Name | ForEach-Object { Join-Path $hostDir $_ })) {
    $acl = Get-Acl -LiteralPath $resource
    Write-Host (@{event='acl';path=$resource;owner=$acl.Owner;sddl=$acl.Sddl} | ConvertTo-Json -Compress)
  }

  $modelProcess = Start-ProfileWorker $modelUser $modelPassword 'model' $modelDir ([string]$ready.pid)
  Wait-Success $modelProcess 45000
  $result = Read-Record (Join-Path $modelDir 'model-result.json')
  if ($result.pid -ne $modelProcess.Id -or $result.identity.sid -ne $modelUser.SID.Value -or
      !$result.publicTaskReadable -or $result.checks.Count -ne 43 -or $result.processEvidence.Count -ne 6) {
    throw 'Model identity or negative test count mismatch'
  }
  Write-Host ($result | ConvertTo-Json -Depth 8 -Compress)
  [IO.File]::WriteAllText((Join-Path $hostDir 'stop'),'stop')
  Wait-Success $hostProcess 15000
  $closed = Read-Record (Join-Path $hostDir 'host-result.json')
  if (!$closed.keyUsable -or !$closed.protectedBytesUnchanged) { throw 'Host postcondition failed' }
  Write-Host ($closed | ConvertTo-Json -Depth 8 -Compress)
} catch {
  foreach ($errorPath in @((Join-Path $hostDir 'host-error.json'),(Join-Path $modelDir 'model-error.json'))) {
    if ([IO.File]::Exists($errorPath)) { Write-Host (Get-Content -LiteralPath $errorPath -Encoding UTF8 -Raw) }
  }
  throw
} finally {
  try {
    foreach ($child in @($modelProcess,$hostProcess)) {
      if ($null -ne $child) {
        if (!$child.HasExited) { $child.Kill(); [void]$child.WaitForExit(5000) }
        $child.Dispose()
      }
    }
    if ([IO.Directory]::Exists($root)) {
      $resolved = Get-Item -LiteralPath $root
      if ($resolved.FullName -ne $root -or $resolved.Parent.FullName -ne $parent -or
          $resolved.Name -ne "FlowKit-Profile-$suffix" -or
          ($resolved.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing to remove a path other than the disposable profile root'
      }
      Remove-Item -LiteralPath $resolved.FullName -Recurse -Force
    }
  } finally {
    foreach ($account in @($modelUser,$hostUser)) {
      if ($null -ne $account) { Remove-LocalUser -SID $account.SID }
    }
  }
}
