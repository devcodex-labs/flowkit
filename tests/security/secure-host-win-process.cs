using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public static class FlowKitProcessAccess {
  private const uint QueryLimitedInformation = 0x1000;
  private const uint WriteDacl = 0x00040000;
  private const uint TokenQuery = 0x0008;
  private const uint DaclSecurityInformation = 0x00000004;
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process, uint rights, out IntPtr token);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  private static extern int GetCurrentProcessId();
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);

  // Ask for access and immediately close any returned handle.
  private static int CheckProcess(int pid, uint rights) {
    IntPtr handle = OpenProcess(rights, false, pid);
    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return 0;
  }

  private static int CheckToken(int pid, uint rights) {
    IntPtr process = OpenProcess(QueryLimitedInformation, false, pid);
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

  // The Host invokes this in the disposable profile before creating private data.
  // The helper must run with the same account as the target Host process.
  private static void Restrict(int pid) {
    IntPtr process = OpenProcess(WriteDacl | QueryLimitedInformation, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open Host process");
    try {
      IntPtr token;
      if (!OpenProcessToken(process, WriteDacl | TokenQuery, out token)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Open Host token");
      }
      try {
        string sid;
        using (WindowsIdentity current = WindowsIdentity.GetCurrent())
        using (WindowsIdentity target = new WindowsIdentity(token)) {
          sid = current.User.Value;
          if (sid != target.User.Value) throw new InvalidOperationException("Host identity mismatch");
        }
        RawSecurityDescriptor security = new RawSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + sid + ")");
        byte[] descriptor = new byte[security.BinaryLength];
        security.GetBinaryForm(descriptor, 0);
        if (!SetKernelObjectSecurity(token, DaclSecurityInformation, descriptor)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Restrict Host token DACL");
        }
        if (!SetKernelObjectSecurity(process, DaclSecurityInformation, descriptor)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Restrict Host process DACL");
        }
        Console.WriteLine("{\"sid\":\"" + sid + "\",\"processDaclApplied\":true,\"tokenDaclApplied\":true}");
      } finally {
        CloseHandle(token);
      }
    } finally {
      CloseHandle(process);
    }
  }

  public static int Main(string[] args) {
    int host;
    int self = GetCurrentProcessId();
    bool restrict = args.Length == 2 && args[0] == "restrict";
    if ((!restrict && args.Length != 1) || !Int32.TryParse(args[restrict ? 1 : 0], out host)
      || host <= 1 || host == self) return 2;
    if (restrict) {
      Restrict(host);
      return 0;
    }
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
