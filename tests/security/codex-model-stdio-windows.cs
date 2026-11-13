using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class FlowKitModelStdio {
  private const uint UseStdHandles = 0x100;
  private const uint ExtendedStartupInfo = 0x80000;
  private const uint CreateSuspended = 4;
  private const uint CreateNoWindow = 0x08000000;
  private const uint FileTypePipe = 3;

  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfo {
    public uint size;
    public IntPtr reserved, desktop, title;
    public uint x, y, width, height, columns, rows, fill, flags;
    public ushort showWindow, reservedSize;
    public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct StartupInfoEx {
    public StartupInfo info;
    public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInfo {
    public IntPtr process, thread;
    public uint pid, tid;
  }

  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
    out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
    IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
  private static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
    ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int returned);

  private static Win32Exception Win32(string operation) {
    return new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  private static IntPtr CopyPipe(int which) {
    IntPtr original = GetStdHandle(which);
    if (GetFileType(original) != FileTypePipe) throw new InvalidOperationException("Stdio must be piped");
    IntPtr copy;
    IntPtr self = GetCurrentProcess();
    if (!DuplicateHandle(self, original, self, out copy, 0, true, 2)) throw Win32("Duplicate stdio pipe");
    return copy;
  }

  private static string OrdinaryUserSid(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 8, out token)) throw Win32("Open model token");
    try {
      using (WindowsIdentity user = new WindowsIdentity(token)) {
        var principal = new WindowsPrincipal(user);
        int elevationType, length;
        if (!GetTokenInformation(token, 18, out elevationType, sizeof(int), out length))
          throw Win32("Read process token elevation type");
        if (elevationType != 1 || principal.IsInRole(WindowsBuiltInRole.Administrator)
          || user.IsSystem || user.User.IsWellKnown(WellKnownSidType.AnonymousSid)
          || user.User.IsWellKnown(WellKnownSidType.LocalServiceSid)
          || user.User.IsWellKnown(WellKnownSidType.NetworkServiceSid))
          throw new InvalidOperationException("The process must run as an ordinary account");
        return user.User.Value;
      }
    } finally { CloseHandle(token); }
  }

  private static int Run(string executable) {
    string sid = OrdinaryUserSid(GetCurrentProcess());
    var stdio = new IntPtr[3];
    IntPtr list = IntPtr.Zero, handles = IntPtr.Zero, listSize = IntPtr.Zero;
    bool initialized = false, completed = false;
    var child = new ProcessInfo();
    try {
      for (int i = 0; i < stdio.Length; i++) stdio[i] = CopyPipe(-10-i);
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);
      if (listSize == IntPtr.Zero) throw Win32("Size startup attributes");
      list = Marshal.AllocHGlobal(listSize);
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref listSize)) throw Win32("Initialize startup attributes");
      initialized = true;
      int bytes = IntPtr.Size * stdio.Length;
      handles = Marshal.AllocHGlobal(bytes);
      Marshal.Copy(stdio, 0, handles, stdio.Length);
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST. No other handle is inherited.
      if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(bytes),
        IntPtr.Zero, IntPtr.Zero)) throw Win32("Restrict inherited handles");
      var startup = new StartupInfoEx();
      startup.info.size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
      startup.info.flags = UseStdHandles;
      startup.info.stdin = stdio[0];
      startup.info.stdout = stdio[1];
      startup.info.stderr = stdio[2];
      startup.attributes = list;
      var command = new StringBuilder("\"" + executable + "\" app-server --listen stdio:// -c \"web_search=\\\"disabled\\\"\"");
      if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
        CreateSuspended | CreateNoWindow | ExtendedStartupInfo, IntPtr.Zero, null, ref startup, out child))
        throw Win32("Start Codex App Server");
      if (OrdinaryUserSid(child.process) != sid) throw new InvalidOperationException("Codex model SID mismatch");
      Console.Out.WriteLine("{\"method\":\"flowkit/profile/identity\",\"params\":{\"modelSid\":\"" + sid
        + "\",\"modelElevated\":false,\"pid\":" + child.pid + ",\"stdioAllowlist\":true}}");
      Console.Out.Flush();
      if (ResumeThread(child.thread) == UInt32.MaxValue) throw Win32("Resume Codex App Server");
      if (WaitForSingleObject(child.process, UInt32.MaxValue) != 0) throw Win32("Wait for Codex App Server");
      completed = true;
      uint code;
      if (!GetExitCodeProcess(child.process, out code)) throw Win32("Read Codex exit code");
      return unchecked((int)code);
    } finally {
      if (child.process != IntPtr.Zero) {
        if (!completed) TerminateProcess(child.process, 1);
        CloseHandle(child.process);
        CloseHandle(child.thread);
      }
      foreach (IntPtr pipe in stdio) if (pipe != IntPtr.Zero) CloseHandle(pipe);
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
  }

  public static int Main(string[] args) {
    if (args.Length != 1) return 2;
    try {
      if (args[0] == "--host-identity") {
        Console.WriteLine(OrdinaryUserSid(GetCurrentProcess()));
        return 0;
      }
      if (!Path.IsPathRooted(args[0]) || args[0].Contains("\"") || !File.Exists(args[0])) return 2;
      string executable = Path.GetFullPath(args[0]);
      if (!String.Equals(executable, args[0], StringComparison.OrdinalIgnoreCase)) return 2;
      return Run(executable);
    }
    catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
  }
}
