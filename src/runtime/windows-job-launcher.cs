using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

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
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

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
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string pszAppContainerName,
        out IntPtr ppsidAppContainerSid);

    private static void Usage()
    {
        Console.Error.WriteLine("usage: devbridge-job-launcher.exe --executable <path> --command-line-base64 <base64>");
        Console.Error.WriteLine("   or: devbridge-job-launcher.exe --terminate-appcontainer <container-id>");
    }

    private static void ThrowLastError(string label)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), label);
    }

    private static IntPtr CreateKillJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastError("CreateJobObject failed");

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, size))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "SetInformationJobObject failed");
        }
        return job;
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
            TOKEN_APPCONTAINER_INFORMATION info = (TOKEN_APPCONTAINER_INFORMATION)Marshal.PtrToStructure(
                buffer,
                typeof(TOKEN_APPCONTAINER_INFORMATION));
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
                IntPtr processHandle = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | (terminate ? PROCESS_TERMINATE : 0),
                    false,
                    pid);
                if (processHandle == IntPtr.Zero) continue;
                try
                {
                    if (!ProcessMatchesAppContainer(processHandle, expectedSid)) continue;
                    matches += 1;
                    if (terminate && TerminateProcess(processHandle, 0xDB)) terminated += 1;
                }
                finally
                {
                    CloseHandle(processHandle);
                }
            }
            catch
            {
                // Processes can exit or become inaccessible while enumerating.
                // Only a process whose token positively matches the unique
                // AppContainer SID is a cleanup target.
            }
            finally
            {
                candidate.Dispose();
            }
        }
        return matches;
    }

    private static int TerminateAppContainer(string containerId)
    {
        if (string.IsNullOrWhiteSpace(containerId) || containerId.Length > 120 || containerId.IndexOf('\0') >= 0)
            throw new InvalidOperationException("AppContainer cleanup identity is invalid");

        IntPtr sid = IntPtr.Zero;
        int hr = DeriveAppContainerSidFromAppContainerName(containerId, out sid);
        if (hr != 0 || sid == IntPtr.Zero)
            throw new InvalidOperationException("DeriveAppContainerSidFromAppContainerName failed for cleanup identity (HRESULT 0x" + hr.ToString("X8") + ")");

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
                        Console.Out.WriteLine("appcontainer-cleanup container=" + containerId + " terminated=" + totalTerminated + " survivors=0");
                        return 0;
                    }
                }
                else
                {
                    emptyPasses = 0;
                }
                Thread.Sleep(100);
            }

            int ignored;
            int survivors = SweepAppContainer(sid, false, out ignored);
            if (survivors != 0)
            {
                Console.Error.WriteLine("AppContainer cleanup left " + survivors + " matching process(es) for " + containerId);
                return 71;
            }
            Console.Out.WriteLine("appcontainer-cleanup container=" + containerId + " terminated=" + totalTerminated + " survivors=0");
            return 0;
        }
        finally
        {
            FreeSid(sid);
        }
    }

    private static int Run(string executable, string commandLine)
    {
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool processCreated = false;
        try
        {
            job = CreateKillJob();

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = InheritableStdHandle(STD_INPUT_HANDLE, "stdin");
            startup.hStdOutput = InheritableStdHandle(STD_OUTPUT_HANDLE, "stdout");
            startup.hStdError = InheritableStdHandle(STD_ERROR_HANDLE, "stderr");

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
            {
                ThrowLastError("CreateProcessW failed");
            }
            processCreated = true;

            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(error, "AssignProcessToJobObject failed");
            }

            uint resumed = ResumeThread(process.hThread);
            if (resumed == 0xFFFFFFFF)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(error, "ResumeThread failed");
            }

            uint waited = WaitForSingleObject(process.hProcess, INFINITE);
            if (waited != 0) ThrowLastError("WaitForSingleObject failed");

            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) ThrowLastError("GetExitCodeProcess failed");

            // This job is defense in depth for the launcher/wxc-exec tree. MXC
            // 0.7 assigns the sandboxed AppContainer child to its own UI job,
            // so DevBridge separately reaps the unique AppContainer identity
            // after the executor exits.
            if (!CloseHandle(job)) ThrowLastError("CloseHandle(job) failed");
            job = IntPtr.Zero;
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
            if (args.Length == 2 && args[0] == "--terminate-appcontainer")
                return TerminateAppContainer(args[1]);

            if (args.Length != 4 || args[0] != "--executable" || args[2] != "--command-line-base64")
            {
                Usage();
                return 64;
            }

            string executable = Path.GetFullPath(args[1]);
            if (!Path.IsPathRooted(executable) || !File.Exists(executable))
                throw new InvalidOperationException("launcher executable does not name an existing absolute file");

            string commandLine = Encoding.UTF8.GetString(Convert.FromBase64String(args[3]));
            if (commandLine.IndexOf('\0') >= 0)
                throw new InvalidOperationException("launcher command line contains NUL");

            return Run(executable, commandLine);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[devbridge-job-launcher] " + error.Message);
            return 70;
        }
    }
}
