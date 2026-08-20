using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

internal static class Program
{
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_UILIMIT_HANDLES = 0x00000001;
    private const uint JOB_OBJECT_UILIMIT_READCLIPBOARD = 0x00000002;
    private const uint JOB_OBJECT_UILIMIT_WRITECLIPBOARD = 0x00000004;
    private const uint JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS = 0x00000008;
    private const uint JOB_OBJECT_UILIMIT_DISPLAYSETTINGS = 0x00000010;
    private const uint JOB_OBJECT_UILIMIT_GLOBALATOMS = 0x00000020;
    private const uint JOB_OBJECT_UILIMIT_DESKTOP = 0x00000040;
    private const uint JOB_OBJECT_UILIMIT_EXITWINDOWS = 0x00000080;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicUIRestrictions = 4;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TOKEN_QUERY = 0x0008;
    private const int TokenAppContainerSid = 31;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int ERROR_NOT_FOUND = 1168;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = new IntPtr(0x00020009);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_UI_RESTRICTIONS
    {
        public uint UIRestrictionsClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_APPCONTAINER_INFORMATION
    {
        public IntPtr TokenAppContainer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    private sealed class AclTarget
    {
        public string Path;
        public bool Directory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")]
    private static extern bool SetExtendedJobInformation(
        IntPtr hJob,
        int JobObjectInfoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")]
    private static extern bool SetUiJobInformation(
        IntPtr hJob,
        int JobObjectInfoClass,
        ref JOBOBJECT_BASIC_UI_RESTRICTIONS lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION lpJobObjectInfo,
        uint cbJobObjectInfoLength,
        IntPtr lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        [In] ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        int dwAttributeCount,
        uint dwFlags,
        ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr Attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr TokenHandle,
        int TokenInformationClass,
        IntPtr TokenInformation,
        int TokenInformationLength,
        out int ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool EqualSid(IntPtr pSid1, IntPtr pSid2);

    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr pSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string pszAppContainerName,
        string pszDisplayName,
        string pszDescription,
        IntPtr pCapabilities,
        uint dwCapabilityCount,
        out IntPtr ppSidAppContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string pszAppContainerName);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string pszAppContainerName,
        out IntPtr ppsidAppContainerSid);

    private static void Usage()
    {
        Console.Error.WriteLine("usage: devbridge-windows-sandbox.exe --probe");
        Console.Error.WriteLine("   or: devbridge-windows-sandbox.exe --run-appcontainer <id> <exe-b64> <cmd-b64> <cwd-b64> <env-list-b64> <readonly-list-b64> <readwrite-list-b64>");
        Console.Error.WriteLine("   or: devbridge-windows-sandbox.exe --cleanup-appcontainer <id> <readonly-list-b64> <readwrite-list-b64>");
        Console.Error.WriteLine("   or: devbridge-windows-sandbox.exe --terminate-appcontainer <id>");
        Console.Error.WriteLine("   or: devbridge-windows-sandbox.exe --executable <path> --command-line-base64 <base64>");
    }

    private static void ThrowLastError(string label)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), label);
    }

    private static int HResultFromWin32(int error)
    {
        return unchecked((int)(0x80070000u | ((uint)error & 0xFFFFu)));
    }

    private static void ThrowHResult(string label, int hr)
    {
        throw new InvalidOperationException(label + " (HRESULT 0x" + unchecked((uint)hr).ToString("X8") + ")");
    }

    private static string DecodeUtf8(string value, string label)
    {
        try
        {
            string decoded = Encoding.UTF8.GetString(Convert.FromBase64String(value));
            if (decoded.IndexOf('\0') >= 0) throw new InvalidOperationException(label + " contains NUL");
            return decoded;
        }
        catch (FormatException error)
        {
            throw new InvalidOperationException(label + " is not valid base64", error);
        }
    }

    private static string[] DecodeList(string value, string label)
    {
        string decoded;
        try { decoded = Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
        catch (FormatException error) { throw new InvalidOperationException(label + " is not valid base64", error); }
        string[] pieces = decoded.Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            if (piece.IndexOf('\0') >= 0) throw new InvalidOperationException(label + " contains NUL");
        }
        return pieces;
    }

    private static void ValidateContainerId(string containerId)
    {
        if (string.IsNullOrWhiteSpace(containerId) || containerId.Length > 120 || containerId.IndexOf('\0') >= 0)
            throw new InvalidOperationException("AppContainer identity is invalid");
        for (int i = 0; i < containerId.Length; i++)
        {
            char c = containerId[i];
            if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.'))
                throw new InvalidOperationException("AppContainer identity contains an unsupported character");
        }
    }

    private static IntPtr CreateKillJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastError("CreateJobObject failed");
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!SetExtendedJobInformation(job, JobObjectExtendedLimitInformation, ref info, size))
                ThrowLastError("SetInformationJobObject limits failed");

            JOBOBJECT_BASIC_UI_RESTRICTIONS ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS();
            ui.UIRestrictionsClass =
                JOB_OBJECT_UILIMIT_HANDLES |
                JOB_OBJECT_UILIMIT_READCLIPBOARD |
                JOB_OBJECT_UILIMIT_WRITECLIPBOARD |
                JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS |
                JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
                JOB_OBJECT_UILIMIT_GLOBALATOMS |
                JOB_OBJECT_UILIMIT_DESKTOP |
                JOB_OBJECT_UILIMIT_EXITWINDOWS;
            uint uiSize = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_UI_RESTRICTIONS));
            if (!SetUiJobInformation(job, JobObjectBasicUIRestrictions, ref ui, uiSize))
                ThrowLastError("SetInformationJobObject UI restrictions failed");
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    private static IntPtr InheritableStdHandle(int kind, string label)
    {
        IntPtr handle = GetStdHandle(kind);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
            throw new InvalidOperationException(label + " is unavailable");
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
            ThrowLastError("SetHandleInformation failed for " + label);
        return handle;
    }

    private static void ClearInherit(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
    }

    private static bool ProcessMatchesAppContainer(IntPtr processHandle, IntPtr expectedSid)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr buffer = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(processHandle, TOKEN_QUERY, out token)) return false;
            int required;
            bool first = GetTokenInformation(token, TokenAppContainerSid, IntPtr.Zero, 0, out required);
            if (!first && Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER) return false;
            if (required <= 0) return false;
            buffer = Marshal.AllocHGlobal(required);
            if (!GetTokenInformation(token, TokenAppContainerSid, buffer, required, out required)) return false;
            TOKEN_APPCONTAINER_INFORMATION info = (TOKEN_APPCONTAINER_INFORMATION)Marshal.PtrToStructure(buffer, typeof(TOKEN_APPCONTAINER_INFORMATION));
            if (info.TokenAppContainer == IntPtr.Zero) return false;
            return EqualSid(info.TokenAppContainer, expectedSid);
        }
        finally
        {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static int SweepAppContainer(IntPtr expectedSid, bool terminate, out int terminated)
    {
        int matches = 0;
        terminated = 0;
        Process[] processes;
        try { processes = Process.GetProcesses(); }
        catch { return 0; }

        foreach (Process candidate in processes)
        {
            try
            {
                uint pid = unchecked((uint)candidate.Id);
                uint desiredAccess = PROCESS_QUERY_LIMITED_INFORMATION | (terminate ? PROCESS_TERMINATE : 0);
                IntPtr processHandle = OpenProcess(desiredAccess, false, pid);
                bool canTerminate = !terminate || processHandle != IntPtr.Zero;
                if (processHandle == IntPtr.Zero && terminate)
                    processHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (processHandle == IntPtr.Zero) continue;
                try
                {
                    if (!ProcessMatchesAppContainer(processHandle, expectedSid)) continue;
                    matches += 1;
                    if (terminate && canTerminate && TerminateProcess(processHandle, 0xDB)) terminated += 1;
                }
                finally { CloseHandle(processHandle); }
            }
            catch { }
            finally { candidate.Dispose(); }
        }
        return matches;
    }

    private static int ReapAppContainer(string containerId, bool quiet)
    {
        ValidateContainerId(containerId);
        IntPtr sid = IntPtr.Zero;
        int hr = DeriveAppContainerSidFromAppContainerName(containerId, out sid);
        if (hr != 0 || sid == IntPtr.Zero) ThrowHResult("DeriveAppContainerSidFromAppContainerName failed", hr);
        try
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            int totalTerminated = 0;
            int emptyPasses = 0;
            while (DateTime.UtcNow < deadline)
            {
                int terminated;
                int matches = SweepAppContainer(sid, true, out terminated);
                totalTerminated += terminated;
                if (matches == 0)
                {
                    emptyPasses += 1;
                    if (emptyPasses >= 2)
                    {
                        if (!quiet) Console.Out.WriteLine("appcontainer-cleanup container=" + containerId + " terminated=" + totalTerminated + " survivors=0");
                        return 0;
                    }
                }
                else { emptyPasses = 0; }
                Thread.Sleep(100);
            }
            int ignored;
            int survivors = SweepAppContainer(sid, false, out ignored);
            if (survivors != 0)
            {
                if (!quiet) Console.Error.WriteLine("AppContainer cleanup left " + survivors + " matching process(es) for " + containerId);
                return 71;
            }
            if (!quiet) Console.Out.WriteLine("appcontainer-cleanup container=" + containerId + " terminated=" + totalTerminated + " survivors=0");
            return 0;
        }
        finally { FreeSid(sid); }
    }

    private static SecurityIdentifier SidIdentity(IntPtr sid)
    {
        return new SecurityIdentifier(sid);
    }

    private static FileSystemAccessRule DirectoryRule(SecurityIdentifier sid, bool write)
    {
        FileSystemRights rights = write
            ? (FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize)
            : (FileSystemRights.ReadAndExecute | FileSystemRights.ReadAttributes | FileSystemRights.ReadExtendedAttributes | FileSystemRights.ReadPermissions | FileSystemRights.Synchronize);
        return new FileSystemAccessRule(
            sid,
            rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow);
    }

    private static FileSystemAccessRule FileRule(SecurityIdentifier sid, bool write)
    {
        FileSystemRights rights = write
            ? (FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize)
            : (FileSystemRights.ReadAndExecute | FileSystemRights.ReadAttributes | FileSystemRights.ReadExtendedAttributes | FileSystemRights.ReadPermissions | FileSystemRights.Synchronize);
        return new FileSystemAccessRule(sid, rights, AccessControlType.Allow);
    }

    private static void AddGrant(string candidate, SecurityIdentifier sid, bool write, List<AclTarget> applied)
    {
        string full = Path.GetFullPath(candidate);
        if (Directory.Exists(full))
        {
            DirectoryInfo info = new DirectoryInfo(full);
            DirectorySecurity security = info.GetAccessControl(AccessControlSections.Access);
            security.AddAccessRule(DirectoryRule(sid, write));
            info.SetAccessControl(security);
            AclTarget target = new AclTarget(); target.Path = full; target.Directory = true; applied.Add(target);
            return;
        }
        if (File.Exists(full))
        {
            FileInfo info = new FileInfo(full);
            FileSecurity security = info.GetAccessControl(AccessControlSections.Access);
            security.AddAccessRule(FileRule(sid, write));
            info.SetAccessControl(security);
            AclTarget target = new AclTarget(); target.Path = full; target.Directory = false; applied.Add(target);
            return;
        }
        throw new FileNotFoundException("AppContainer grant target does not exist", full);
    }

    private static List<AclTarget> ApplyGrants(SecurityIdentifier sid, string[] readOnly, string[] readWrite)
    {
        List<AclTarget> applied = new List<AclTarget>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (string path in readOnly)
            {
                string full = Path.GetFullPath(path);
                if (seen.Add(full)) AddGrant(full, sid, false, applied);
            }
            foreach (string path in readWrite)
            {
                string full = Path.GetFullPath(path);
                if (seen.Add(full)) AddGrant(full, sid, true, applied);
            }
            return applied;
        }
        catch
        {
            PurgeGrants(sid, applied);
            throw;
        }
    }

    private static void PurgeGrant(SecurityIdentifier sid, AclTarget target)
    {
        if (target.Directory)
        {
            if (!Directory.Exists(target.Path)) return;
            DirectoryInfo info = new DirectoryInfo(target.Path);
            DirectorySecurity security = info.GetAccessControl(AccessControlSections.Access);
            security.PurgeAccessRules(sid);
            info.SetAccessControl(security);
        }
        else
        {
            if (!File.Exists(target.Path)) return;
            FileInfo info = new FileInfo(target.Path);
            FileSecurity security = info.GetAccessControl(AccessControlSections.Access);
            security.PurgeAccessRules(sid);
            info.SetAccessControl(security);
        }
    }

    private static void PurgeGrants(SecurityIdentifier sid, List<AclTarget> applied)
    {
        Exception first = null;
        for (int i = applied.Count - 1; i >= 0; i--)
        {
            try { PurgeGrant(sid, applied[i]); }
            catch (Exception error) { if (first == null) first = error; }
        }
        if (first != null) throw first;
    }

    private static void PurgeNamedPaths(SecurityIdentifier sid, string[] readOnly, string[] readWrite)
    {
        List<AclTarget> targets = new List<AclTarget>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string raw in readOnly)
        {
            string full = Path.GetFullPath(raw);
            if (!seen.Add(full)) continue;
            if (Directory.Exists(full)) { AclTarget t = new AclTarget(); t.Path = full; t.Directory = true; targets.Add(t); }
            else if (File.Exists(full)) { AclTarget t = new AclTarget(); t.Path = full; t.Directory = false; targets.Add(t); }
        }
        foreach (string raw in readWrite)
        {
            string full = Path.GetFullPath(raw);
            if (!seen.Add(full)) continue;
            if (Directory.Exists(full)) { AclTarget t = new AclTarget(); t.Path = full; t.Directory = true; targets.Add(t); }
            else if (File.Exists(full)) { AclTarget t = new AclTarget(); t.Path = full; t.Directory = false; targets.Add(t); }
        }
        PurgeGrants(sid, targets);
    }

    private static void DeleteProfileIfPresent(string containerId)
    {
        int hr = DeleteAppContainerProfile(containerId);
        if (hr == 0 || hr == HResultFromWin32(ERROR_NOT_FOUND) || hr == HResultFromWin32(ERROR_FILE_NOT_FOUND)) return;
        ThrowHResult("DeleteAppContainerProfile failed", hr);
    }

    private static IntPtr CreateFreshProfile(string containerId)
    {
        ValidateContainerId(containerId);
        ReapAppContainer(containerId, true);
        try { DeleteProfileIfPresent(containerId); } catch { }
        IntPtr sid;
        int hr = CreateAppContainerProfile(containerId, containerId, "DevBridge sandbox", IntPtr.Zero, 0, out sid);
        if (hr != 0 || sid == IntPtr.Zero) ThrowHResult("CreateAppContainerProfile failed", hr);
        return sid;
    }

    private static IntPtr BuildEnvironment(string[] entries)
    {
        string block = string.Join("\0", entries) + "\0\0";
        byte[] bytes = Encoding.Unicode.GetBytes(block);
        IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, memory, bytes.Length);
        return memory;
    }

    private static IntPtr BuildAttributeList(IntPtr sid, IntPtr[] handles, out IntPtr capabilitiesMemory, out IntPtr handlesMemory)
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        if (size == IntPtr.Zero) ThrowLastError("InitializeProcThreadAttributeList sizing failed");
        IntPtr attributes = Marshal.AllocHGlobal(size);
        capabilitiesMemory = IntPtr.Zero;
        handlesMemory = IntPtr.Zero;
        try
        {
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size))
                ThrowLastError("InitializeProcThreadAttributeList failed");

            SECURITY_CAPABILITIES capabilities = new SECURITY_CAPABILITIES();
            capabilities.AppContainerSid = sid;
            capabilities.Capabilities = IntPtr.Zero;
            capabilities.CapabilityCount = 0;
            capabilities.Reserved = 0;
            int capabilitiesSize = Marshal.SizeOf(typeof(SECURITY_CAPABILITIES));
            capabilitiesMemory = Marshal.AllocHGlobal(capabilitiesSize);
            Marshal.StructureToPtr(capabilities, capabilitiesMemory, false);
            if (!UpdateProcThreadAttribute(
                attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                capabilitiesMemory, new IntPtr(capabilitiesSize), IntPtr.Zero, IntPtr.Zero))
                ThrowLastError("UpdateProcThreadAttribute SECURITY_CAPABILITIES failed");

            handlesMemory = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
            for (int i = 0; i < handles.Length; i++) Marshal.WriteIntPtr(handlesMemory, i * IntPtr.Size, handles[i]);
            if (!UpdateProcThreadAttribute(
                attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handlesMemory, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero))
                ThrowLastError("UpdateProcThreadAttribute HANDLE_LIST failed");

            return attributes;
        }
        catch
        {
            if (capabilitiesMemory != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesMemory);
            if (handlesMemory != IntPtr.Zero) Marshal.FreeHGlobal(handlesMemory);
            Marshal.FreeHGlobal(attributes);
            throw;
        }
    }

    private static void WaitForJobEmpty(IntPtr job, int milliseconds)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < deadline)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                out accounting,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                IntPtr.Zero))
                ThrowLastError("QueryInformationJobObject failed");
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(50);
        }
        throw new InvalidOperationException("sandbox job did not become empty after termination");
    }

    private static int RunAppContainer(string[] args)
    {
        string containerId = args[1];
        string executable = Path.GetFullPath(DecodeUtf8(args[2], "executable"));
        string commandLine = DecodeUtf8(args[3], "command line");
        string cwd = Path.GetFullPath(DecodeUtf8(args[4], "working directory"));
        string[] environment = DecodeList(args[5], "environment");
        string[] readOnly = DecodeList(args[6], "read-only paths");
        string[] readWrite = DecodeList(args[7], "read-write paths");
        if (!File.Exists(executable)) throw new FileNotFoundException("sandbox executable does not exist", executable);
        if (!Directory.Exists(cwd)) throw new DirectoryNotFoundException("sandbox working directory does not exist: " + cwd);

        IntPtr sid = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr capabilitiesMemory = IntPtr.Zero;
        IntPtr handlesMemory = IntPtr.Zero;
        IntPtr environmentMemory = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        bool processCreated = false;
        List<AclTarget> grants = null;
        IntPtr stdin = IntPtr.Zero;
        IntPtr stdout = IntPtr.Zero;
        IntPtr stderr = IntPtr.Zero;
        Exception cleanupFailure = null;
        int resultCode = 70;
        try
        {
            sid = CreateFreshProfile(containerId);
            SecurityIdentifier identity = SidIdentity(sid);
            grants = ApplyGrants(identity, readOnly, readWrite);
            job = CreateKillJob();

            stdin = InheritableStdHandle(STD_INPUT_HANDLE, "stdin");
            stdout = InheritableStdHandle(STD_OUTPUT_HANDLE, "stdout");
            stderr = InheritableStdHandle(STD_ERROR_HANDLE, "stderr");
            attributes = BuildAttributeList(sid, new IntPtr[] { stdin, stdout, stderr }, out capabilitiesMemory, out handlesMemory);
            environmentMemory = BuildEnvironment(environment);

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdin;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.lpAttributeList = attributes;

            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            bool created;
            try
            {
                created = CreateProcessW(
                    executable,
                    mutableCommandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                    environmentMemory,
                    cwd,
                    ref startup,
                    out processInfo);
            }
            finally
            {
                ClearInherit(stdin);
                ClearInherit(stdout);
                ClearInherit(stderr);
            }
            if (!created) ThrowLastError("CreateProcessW AppContainer launch failed");
            processCreated = true;

            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(processInfo.hProcess, 1);
                throw new Win32Exception(error, "AssignProcessToJobObject sandbox root failed");
            }
            uint resumed = ResumeThread(processInfo.hThread);
            if (resumed == 0xFFFFFFFF)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(processInfo.hProcess, 1);
                throw new Win32Exception(error, "ResumeThread sandbox root failed");
            }

            uint waited = WaitForSingleObject(processInfo.hProcess, INFINITE);
            if (waited != 0) ThrowLastError("WaitForSingleObject sandbox root failed");
            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode)) ThrowLastError("GetExitCodeProcess sandbox root failed");

            if (!TerminateJobObject(job, 0xDB)) ThrowLastError("TerminateJobObject sandbox tree failed");
            WaitForJobEmpty(job, 5000);
            resultCode = unchecked((int)exitCode);
        }
        finally
        {
            if (processCreated)
            {
                if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
                if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            if (attributes != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }
            if (capabilitiesMemory != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesMemory);
            if (handlesMemory != IntPtr.Zero) Marshal.FreeHGlobal(handlesMemory);
            if (environmentMemory != IntPtr.Zero) Marshal.FreeHGlobal(environmentMemory);

            if (sid != IntPtr.Zero)
            {
                SecurityIdentifier identity = SidIdentity(sid);
                try { if (grants != null) PurgeGrants(identity, grants); }
                catch (Exception error) { cleanupFailure = error; }
                try
                {
                    int reaped = ReapAppContainer(containerId, true);
                    if (reaped != 0 && cleanupFailure == null) cleanupFailure = new InvalidOperationException("AppContainer cleanup left surviving processes");
                }
                catch (Exception error) { if (cleanupFailure == null) cleanupFailure = error; }
                try { DeleteProfileIfPresent(containerId); }
                catch (Exception error) { if (cleanupFailure == null) cleanupFailure = error; }
                FreeSid(sid);
            }
            if (cleanupFailure != null) throw cleanupFailure;
        }
        return resultCode;
    }

    private static int CleanupAppContainer(string[] args)
    {
        string containerId = args[1];
        string[] readOnly = DecodeList(args[2], "read-only paths");
        string[] readWrite = DecodeList(args[3], "read-write paths");
        ValidateContainerId(containerId);
        IntPtr sid = IntPtr.Zero;
        int hr = DeriveAppContainerSidFromAppContainerName(containerId, out sid);
        if (hr != 0 || sid == IntPtr.Zero) ThrowHResult("DeriveAppContainerSidFromAppContainerName failed", hr);
        try
        {
            int reaped = ReapAppContainer(containerId, true);
            if (reaped != 0) return reaped;
            PurgeNamedPaths(SidIdentity(sid), readOnly, readWrite);
            DeleteProfileIfPresent(containerId);
            Console.Out.WriteLine("appcontainer-cleanup container=" + containerId + " survivors=0");
            return 0;
        }
        finally { FreeSid(sid); }
    }

    private static int Probe()
    {
        string id = "devbridge-probe-" + Guid.NewGuid().ToString("N");
        IntPtr sid = IntPtr.Zero;
        try
        {
            sid = CreateFreshProfile(id);
            Console.Out.WriteLine("{\"provider\":\"windows-appcontainer\",\"available\":true}");
            return 0;
        }
        finally
        {
            if (sid != IntPtr.Zero) FreeSid(sid);
            try { DeleteProfileIfPresent(id); } catch { }
        }
    }

    // Retained temporarily for source compatibility with the earlier helper
    // tests. The production provider no longer uses this outer-launcher mode.
    private static int LegacyRun(string executable, string commandLine)
    {
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool processCreated = false;
        try
        {
            job = CreateKillJob();
            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = InheritableStdHandle(STD_INPUT_HANDLE, "stdin");
            startup.StartupInfo.hStdOutput = InheritableStdHandle(STD_OUTPUT_HANDLE, "stdout");
            startup.StartupInfo.hStdError = InheritableStdHandle(STD_ERROR_HANDLE, "stderr");
            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            if (!CreateProcessW(
                executable,
                mutableCommandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero,
                Environment.CurrentDirectory,
                ref startup,
                out process))
                ThrowLastError("CreateProcessW failed");
            processCreated = true;
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(error, "AssignProcessToJobObject failed");
            }
            if (ResumeThread(process.hThread) == 0xFFFFFFFF) ThrowLastError("ResumeThread failed");
            if (WaitForSingleObject(process.hProcess, INFINITE) != 0) ThrowLastError("WaitForSingleObject failed");
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) ThrowLastError("GetExitCodeProcess failed");
            if (!TerminateJobObject(job, 0xDB)) ThrowLastError("TerminateJobObject failed");
            WaitForJobEmpty(job, 5000);
            return unchecked((int)exitCode);
        }
        finally
        {
            if (processCreated)
            {
                if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--probe") return Probe();
            if (args.Length == 8 && args[0] == "--run-appcontainer") return RunAppContainer(args);
            if (args.Length == 4 && args[0] == "--cleanup-appcontainer") return CleanupAppContainer(args);
            if (args.Length == 2 && args[0] == "--terminate-appcontainer") return ReapAppContainer(args[1], false);
            if (args.Length == 4 && args[0] == "--executable" && args[2] == "--command-line-base64")
            {
                string executable = Path.GetFullPath(args[1]);
                if (!File.Exists(executable)) throw new InvalidOperationException("launcher executable does not name an existing absolute file");
                string commandLine = Encoding.UTF8.GetString(Convert.FromBase64String(args[3]));
                if (commandLine.IndexOf('\0') >= 0) throw new InvalidOperationException("launcher command line contains NUL");
                return LegacyRun(executable, commandLine);
            }
            Usage();
            return 64;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[devbridge-windows-sandbox] " + error.Message);
            return 70;
        }
    }
}
