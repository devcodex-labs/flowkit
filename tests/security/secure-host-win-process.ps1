param([Parameter(Mandatory=$true)][int]$HostProcessId)
$ErrorActionPreference = 'Stop'

# Request and close handles only. This probe never reads memory or uses a token.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlowKitProcessAccess {
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process, uint rights, out IntPtr token);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static int CheckProcess(int pid, uint rights) {
    IntPtr handle = OpenProcess(rights, false, pid);
    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return 0;
  }

  public static int CheckToken(int pid, uint rights) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try {
      IntPtr token;
      if (!OpenProcessToken(process, rights, out token)) return Marshal.GetLastWin32Error();
      CloseHandle(token);
      return 0;
    } finally {
      CloseHandle(process);
    }
  }
}
'@

$checks = @(
  @{ Name='process-vm-read'; Rights=0x0010 }
  @{ Name='process-vm-write'; Rights=0x0020 }
  @{ Name='process-duplicate-handle'; Rights=0x0040 }
  @{ Name='process-create-thread'; Rights=0x0002 }
)
$results = @(
  foreach ($check in $checks) {
    if ([FlowKitProcessAccess]::CheckProcess($PID,$check.Rights) -ne 0) {
      throw "Process access probe did not pass its positive control: $($check.Name)"
    }
    $code = [FlowKitProcessAccess]::CheckProcess($HostProcessId,$check.Rights)
    [pscustomobject]@{ operation=$check.Name; denied=($code -eq 5); win32Error=$code }
  }
  foreach ($check in @(@{Name='token-duplicate';Rights=0x0002},@{Name='token-assign-primary';Rights=0x0001})) {
    if ([FlowKitProcessAccess]::CheckToken($PID,$check.Rights) -ne 0) {
      throw "Token access probe did not pass its positive control: $($check.Name)"
    }
    $code = [FlowKitProcessAccess]::CheckToken($HostProcessId,$check.Rights)
    [pscustomobject]@{ operation=$check.Name; denied=($code -eq 5); win32Error=$code }
  }
)
ConvertTo-Json -InputObject $results -Compress
