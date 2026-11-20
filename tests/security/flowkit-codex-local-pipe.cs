using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security;
using System.Security.Principal;
using System.Reflection;
using System.Threading.Tasks;
using FlowKit.Codex.Windows;

public static class FlowKitCodexLocalPipeTests {
  private static NamedPipeClientStream CreateClient(string name, TokenImpersonationLevel level) {
    return new NamedPipeClientStream(".", name,
      PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.Synchronize,
      PipeOptions.None, level, HandleInheritability.None);
  }

  private static int RunChildClient(string name) {
    using (var client = CreateClient(name, TokenImpersonationLevel.Identification)) {
      client.Connect(3000);
      client.WriteByte(42);
      return client.ReadByte() == 42 ? 0 : 1;
    }
  }

  private static void ExpectCrossProcessBind(SecurityIdentifier account, SecurityIdentifier logon) {
    string name = "flowkit-test-" + Guid.NewGuid().ToString("N");
    using (var listener = new LocalHostPipe(name, account, logon)) {
      var command = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--client " + name);
      command.UseShellExecute = false;
      command.CreateNoWindow = true;
      using (var child = Process.Start(command)) {
        try {
          var receiver = Task.Run(delegate {
            listener.WaitForConnection();
            var buffer = new byte[1];
            if (listener.ReadMessage(buffer, 0, 1) != 1 || buffer[0] != 42)
              throw new InvalidOperationException("Expected a request from the child process");
            listener.WriteMessage(buffer, 0, 1);
          });
          if (!receiver.Wait(5000) || !child.WaitForExit(5000) || child.ExitCode != 0)
            throw new IOException("The independent client did not complete the pipe exchange");
        } finally {
          if (!child.HasExited) {
            child.Kill();
            child.WaitForExit(3000);
          }
        }
      }
    }
    Console.WriteLine("PASS independent Windows process verified");
  }

  private static void ExpectBind(string label, SecurityIdentifier account, SecurityIdentifier logon,
    TokenImpersonationLevel level, bool allowed, bool oversized = false) {
    string name = "flowkit-test-" + Guid.NewGuid().ToString("N");
    using (var listener = new LocalHostPipe(name, account, logon))
    using (var client = CreateClient(name, level)) {
      var receiver = Task.Run(delegate {
        listener.WaitForConnection();
        var buffer = new byte[1];
        try {
          int read = listener.ReadMessage(buffer, 0, 1);
          if (!allowed || read != 1 || buffer[0] != 42)
            throw new InvalidOperationException("Unexpected authenticated pipe read");
          listener.WriteMessage(buffer, 0, read);
        } catch (Exception error) {
          if (allowed || buffer[0] != 0) throw;
          if (oversized && !(error is InvalidDataException)) throw;
          if (!oversized && !(error is SecurityException)
            && !(level == TokenImpersonationLevel.Anonymous && error is IOException)) throw;
        }
      });
      client.Connect(3000);
      var message = oversized ? new byte[] { 42, 42 } : new byte[] { 42 };
      client.Write(message, 0, message.Length);
      client.Flush();
      if (!receiver.Wait(5000)) throw new TimeoutException(label);
      if (allowed && client.ReadByte() != 42) throw new IOException("Expected the authenticated response");
    }
    Console.WriteLine("PASS " + label);
  }

  private static void ExpectFirstInstance(SecurityIdentifier account, SecurityIdentifier logon) {
    string name = "flowkit-test-" + Guid.NewGuid().ToString("N");
    using (var active = new LocalHostPipe(name, account, logon)) {
      try {
        active.WriteMessage(new byte[] { 42 }, 0, 1);
        throw new InvalidOperationException("Sent a response before verifying its peer");
      } catch (SecurityException) { }
      try {
        using (var duplicate = new LocalHostPipe(name, account, logon))
          throw new InvalidOperationException("Accepted duplicate host endpoint");
      } catch (Win32Exception error) {
        if (error.NativeErrorCode != 5 && error.NativeErrorCode != 231)
          throw new InvalidOperationException("Unexpected duplicate endpoint error: " + error.NativeErrorCode, error);
      }
    }
    Console.WriteLine("PASS duplicate host endpoint refused");
  }

  public static int Main(string[] args) {
    try {
      if (args.Length == 2 && args[0] == "--client") return RunChildClient(args[1]);
      if (args.Length != 0) return 2;
      using (var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query)) {
        var logon = LocalHostPipe.ReadLogonSid(identity);
        var identification = TokenImpersonationLevel.Identification;
        ExpectBind("OS account and logon match", identity.User, logon, identification, true);
        ExpectCrossProcessBind(identity.User, logon);
        ExpectBind("wrong account rejected", new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
          logon, identification, false);
        ExpectBind("wrong logon rejected", identity.User, new SecurityIdentifier("S-1-5-5-0-1"), identification, false);
        ExpectBind("anonymous token rejected", identity.User, logon, TokenImpersonationLevel.Anonymous, false);
        ExpectBind("oversized record rejected", identity.User, logon, identification, false, true);
        ExpectFirstInstance(identity.User, logon);
      }
      return 0;
    } catch (Exception error) {
      var cause = error.GetBaseException();
      Console.Error.WriteLine(cause.GetType().Name + ": " + cause.Message);
      return 1;
    }
  }
}
