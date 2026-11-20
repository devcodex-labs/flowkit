using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace FlowKit.Codex.Windows {
  internal sealed class LocalHostPipe : IDisposable {
    private const uint PipeAccessDuplex = 3;
    private const uint FirstPipeInstance = 0x00080000;
    private const uint MessagePipe = 4 | 2;
    private const uint RejectRemoteClients = 8;
    private const int TokenLogonSid = 28;
    private const int ErrorInsufficientBuffer = 122;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes {
      public int Length;
      public IntPtr Descriptor;
      [MarshalAs(UnmanagedType.Bool)]
      public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenGroupsHeader {
      public uint Count;
      public IntPtr FirstSid;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode,
      uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes security);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr buffer,
      int length, out int required);

    private readonly NamedPipeServerStream pipe;
    private readonly SecurityIdentifier account;
    private readonly SecurityIdentifier logon;
    private readonly object readLock = new object();
    private volatile bool peerVerified;

    public LocalHostPipe(string name, SecurityIdentifier account, SecurityIdentifier logon) {
      if (String.IsNullOrEmpty(name) || name.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0 || name.Length > 128)
        throw new ArgumentException("Invalid local pipe name", "name");
      if (account == null || account.IsWellKnown(WellKnownSidType.AnonymousSid))
        throw new ArgumentException("An authenticated account SID is required", "account");
      if (logon == null || !logon.Value.StartsWith("S-1-5-5-", StringComparison.Ordinal)
        || logon.Value.Split('-').Length != 6)
        throw new ArgumentException("A Windows logon SID is required", "logon");
      this.account = account;
      this.logon = logon;

      using (var impersonated = WindowsIdentity.GetCurrent(true)) {
        if (impersonated != null) throw new SecurityException("The Host must create the pipe as itself");
      }
      var access = new PipeSecurity();
      access.SetAccessRuleProtection(true, false);
      using (var host = WindowsIdentity.GetCurrent(TokenAccessLevels.Query)) {
        access.AddAccessRule(new PipeAccessRule(host.User, PipeAccessRights.FullControl, AccessControlType.Allow));
      }
      // FILE_APPEND_DATA shares a bit with FILE_CREATE_PIPE_INSTANCE. Grant only the required access.
      access.AddAccessRule(new PipeAccessRule(logon,
        PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.Synchronize, AccessControlType.Allow));
      byte[] descriptor = access.GetSecurityDescriptorBinaryForm();
      var pin = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
      try {
        var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)),
          Descriptor = pin.AddrOfPinnedObject(), InheritHandle = false };
        var handle = CreateNamedPipeW(@"\\.\pipe\" + name, PipeAccessDuplex | FirstPipeInstance,
          MessagePipe | RejectRemoteClients, 1, 16384, 16384, 0, ref security);
        if (handle.IsInvalid) {
          var error = new Win32Exception(Marshal.GetLastWin32Error(), "Create FlowKit Host pipe");
          handle.Dispose();
          throw error;
        }
        try {
          pipe = new NamedPipeServerStream(PipeDirection.InOut, false, false, handle);
        } catch {
          handle.Dispose();
          throw;
        }
      } finally {
        pin.Free();
      }
    }

    public void WaitForConnection() {
      pipe.WaitForConnection();
      pipe.ReadMode = PipeTransmissionMode.Message;
    }

    public int ReadMessage(byte[] buffer, int offset, int count) {
      if (count <= 0) throw new ArgumentOutOfRangeException("count");
      lock (readLock) {
        int read = 0;
        try {
          read = pipe.Read(buffer, offset, count);
          if (read == 0) return 0;
          bool matches = false;
          pipe.RunAsClient(delegate {
            using (var peer = WindowsIdentity.GetCurrent(true)) {
              matches = peer != null && account.Equals(peer.User) && logon.Equals(ReadLogonSid(peer));
            }
          });
          if (!matches) throw new SecurityException("FlowKit Host pipe peer is outside the approved logon");
          if (!pipe.IsMessageComplete) throw new InvalidDataException("FlowKit Host pipe message exceeds its buffer");
          peerVerified = true;
          return read;
        } catch {
          if (read > 0) Array.Clear(buffer, offset, read);
          Dispose();
          throw;
        }
      }
    }

    public void WriteMessage(byte[] buffer, int offset, int count) {
      if (!peerVerified) throw new SecurityException("Read and authenticate the request before writing a response");
      pipe.Write(buffer, offset, count);
    }

    internal static SecurityIdentifier ReadLogonSid(WindowsIdentity identity) {
      int need;
      if (GetTokenInformation(identity.Token, TokenLogonSid, IntPtr.Zero, 0, out need)
        || Marshal.GetLastWin32Error() != ErrorInsufficientBuffer || need < Marshal.SizeOf(typeof(TokenGroupsHeader)))
        throw new SecurityException("Cannot size the Windows logon SID");
      IntPtr buffer = Marshal.AllocHGlobal(need);
      try {
        if (!GetTokenInformation(identity.Token, TokenLogonSid, buffer, need, out need))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Read Windows logon SID");
        var groups = (TokenGroupsHeader)Marshal.PtrToStructure(buffer, typeof(TokenGroupsHeader));
        if (groups.Count != 1 || groups.FirstSid == IntPtr.Zero)
          throw new SecurityException("Expected exactly one Windows logon SID");
        return new SecurityIdentifier(groups.FirstSid);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    public void Dispose() {
      peerVerified = false;
      pipe.Dispose();
    }
  }
}
