$ErrorActionPreference = 'Stop'

$root = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..\..')).FullName
$scratch = Join-Path $root ('.tmp\codex-local-pipe-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$binary = Join-Path $scratch 'flowkit-codex-pipe-tests.exe'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$implementation = Join-Path $root 'plugins\flowkit-codex\windows\LocalHostPipe.cs'
$tests = Join-Path $PSScriptRoot 'flowkit-codex-local-pipe.cs'

& $compiler /nologo /warnaserror /utf8output /target:exe "/out:$binary" $implementation $tests
if ($LASTEXITCODE -ne 0) { throw "Native pipe tests did not compile (exit $LASTEXITCODE)" }
& $binary
if ($LASTEXITCODE -ne 0) { throw "Native pipe tests failed (exit $LASTEXITCODE)" }
