using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class FlowKitProcessAccess {
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process, uint rights, out IntPtr token);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  private static extern int GetCurrentProcessId();

  // Ask for access and immediately close any returned handle.
  private static int CheckProcess(int pid, uint rights) {
    IntPtr handle = OpenProcess(rights, false, pid);
    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return 0;
  }

  private static int CheckToken(int pid, uint rights) {
    const uint queryLimitedInformation = 0x1000;
    IntPtr process = OpenProcess(queryLimitedInformation, false, pid);
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

  private static string Check(string name, int positiveControl, int result) {
    if (positiveControl != 0) throw new InvalidOperationException("Positive control failed: " + name);
    return "{\"operation\":\"" + name + "\",\"denied\":" + (result == 5 ? "true" : "false")
      + ",\"win32Error\":" + result.ToString(CultureInfo.InvariantCulture) + "}";
  }

  public static int Main(string[] args) {
    int host;
    int self = GetCurrentProcessId();
    if (args.Length != 1 || !Int32.TryParse(args[0], out host) || host <= 1 || host == self) return 2;
    string[] results = {
      Check("process-vm-read", CheckProcess(self, 0x0010), CheckProcess(host, 0x0010)),
      Check("process-vm-write", CheckProcess(self, 0x0020), CheckProcess(host, 0x0020)),
      Check("process-duplicate-handle", CheckProcess(self, 0x0040), CheckProcess(host, 0x0040)),
      Check("process-create-thread", CheckProcess(self, 0x0002), CheckProcess(host, 0x0002)),
      Check("token-duplicate", CheckToken(self, 0x0002), CheckToken(host, 0x0002)),
      Check("token-assign-primary", CheckToken(self, 0x0001), CheckToken(host, 0x0001))
    };
    Console.WriteLine("[" + String.Join(",", results) + "]");
    return 0;
  }
}
