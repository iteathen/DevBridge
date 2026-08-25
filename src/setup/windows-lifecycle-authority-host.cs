using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace DevBridge.WindowsLifecycleAuthority
{
    internal sealed class HostOptions
    {
        private static readonly Regex ServiceNamePattern = new Regex("^DevBridgeLifecycle-[0-9a-f]{32}$", RegexOptions.CultureInvariant);
        private static readonly Regex PipeNamePattern = new Regex("^devbridge-environment-[0-9a-f]{32}-(read|mutation)-v1$", RegexOptions.CultureInvariant);

        internal string ServiceName;
        internal string ProtectedRoot;
        internal string NodeExecutable;
        internal string WorkerEntry;
        internal string StateDirectory;
        internal string AuthorityDirectory;
        internal string OperatorSid;
        internal string ReadPipe;
        internal string MutationPipe;

        private static string Required(IDictionary<string, string> values, string name)
        {
            string value;
            if (!values.TryGetValue(name, out value) || String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0)
                throw new ArgumentException("missing or invalid host argument");
            return value;
        }

        private static string AbsolutePath(string value)
        {
            if (value.IndexOf('"') >= 0 || !Path.IsPathRooted(value)) throw new ArgumentException("host path is invalid");
            return Path.GetFullPath(value);
        }

        private static bool IsUnder(string root, string target)
        {
            string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string normalizedTarget = Path.GetFullPath(target);
            return normalizedTarget.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
        }

        internal static HostOptions Parse(string[] args)
        {
            if (args == null || args.Length == 0 || (args.Length % 2) != 0) throw new ArgumentException("host arguments are invalid");
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 0; index < args.Length; index += 2)
            {
                string key = args[index];
                if (String.IsNullOrEmpty(key) || !key.StartsWith("--", StringComparison.Ordinal) || values.ContainsKey(key))
                    throw new ArgumentException("host arguments are invalid");
                values.Add(key, args[index + 1]);
            }
            string[] allowed = new string[] {
                "--service-name", "--protected-root", "--node", "--worker", "--state-directory",
                "--authority-directory", "--operator-sid", "--read-pipe", "--mutation-pipe"
            };
            if (values.Count != allowed.Length) throw new ArgumentException("host arguments are incomplete");
            foreach (string key in values.Keys)
            {
                if (Array.IndexOf(allowed, key) < 0) throw new ArgumentException("host argument is not allowed");
            }

            HostOptions options = new HostOptions();
            options.ServiceName = Required(values, "--service-name");
            options.ProtectedRoot = AbsolutePath(Required(values, "--protected-root"));
            options.NodeExecutable = AbsolutePath(Required(values, "--node"));
            options.WorkerEntry = AbsolutePath(Required(values, "--worker"));
            options.StateDirectory = AbsolutePath(Required(values, "--state-directory"));
            options.AuthorityDirectory = AbsolutePath(Required(values, "--authority-directory"));
            options.OperatorSid = Required(values, "--operator-sid");
            options.ReadPipe = Required(values, "--read-pipe");
            options.MutationPipe = Required(values, "--mutation-pipe");

            if (!ServiceNamePattern.IsMatch(options.ServiceName)) throw new ArgumentException("service name is invalid");
            if (!PipeNamePattern.IsMatch(options.ReadPipe) || !options.ReadPipe.EndsWith("-read-v1", StringComparison.Ordinal)) throw new ArgumentException("read pipe is invalid");
            if (!PipeNamePattern.IsMatch(options.MutationPipe) || !options.MutationPipe.EndsWith("-mutation-v1", StringComparison.Ordinal)) throw new ArgumentException("mutation pipe is invalid");
            if (String.Equals(options.ReadPipe, options.MutationPipe, StringComparison.Ordinal)) throw new ArgumentException("pipe capabilities must be distinct");
            new SecurityIdentifier(options.OperatorSid);
            if (!IsUnder(options.ProtectedRoot, options.NodeExecutable) ||
                !IsUnder(options.ProtectedRoot, options.WorkerEntry) ||
                !IsUnder(options.ProtectedRoot, options.AuthorityDirectory))
                throw new ArgumentException("protected runtime path escaped protected root");
            return options;
        }
    }

    internal sealed class WorkerJob : IDisposable
    {
        private IntPtr handle;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr value);

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public IntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        internal WorkerJob(Process process)
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("could not create worker job");
            try
            {
                ExtendedLimitInformation limits = new ExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(limits, buffer, false);
                    if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size))
                        throw new InvalidOperationException("could not constrain worker job");
                }
                finally { Marshal.FreeHGlobal(buffer); }
                if (!AssignProcessToJobObject(handle, process.Handle))
                    throw new InvalidOperationException("could not bind worker process tree");
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public void Dispose()
        {
            IntPtr current = Interlocked.Exchange(ref handle, IntPtr.Zero);
            if (current != IntPtr.Zero) CloseHandle(current);
        }
    }

    internal sealed class LifecycleAuthorityService : ServiceBase
    {
        private const int MaxWireBytes = 17408;
        private const int PreRequestTimeoutMs = 5000;
        private const int ExclusivePipeServerInstances = 1;
        private static readonly string[] ScrubbedWorkerEnvironment = new string[] {
            "NODE_OPTIONS",
            "NODE_PATH",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "DEVBRIDGE_GITHUB_TOKEN",
            "GIT_ASKPASS",
            "SSH_ASKPASS",
            "SSH_AUTH_SOCK",
            "DEVBRIDGE_COORDINATION_PRIVATE_KEY",
            "DEVBRIDGE_RELEASE_PRIVATE_KEY",
            "DEVBRIDGE_SIGNING_KEY"
        };
        private readonly HostOptions options;
        private readonly object activeLock = new object();
        private readonly object workerLock = new object();
        private readonly SemaphoreSlim workerGate = new SemaphoreSlim(1, 1);
        private readonly List<NamedPipeServerStream> activePipes = new List<NamedPipeServerStream>();
        private volatile bool stopping;
        private Thread readThread;
        private Thread mutationThread;
        private Process activeWorker;
        private WorkerJob activeWorkerJob;

        internal LifecycleAuthorityService(HostOptions selected)
        {
            options = selected;
            ServiceName = selected.ServiceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            readThread = new Thread(delegate() { Serve(options.ReadPipe, "read"); });
            mutationThread = new Thread(delegate() { Serve(options.MutationPipe, "mutation"); });
            readThread.IsBackground = true;
            mutationThread.IsBackground = true;
            readThread.Name = "DevBridge lifecycle read endpoint";
            mutationThread.Name = "DevBridge lifecycle mutation endpoint";
            readThread.Start();
            mutationThread.Start();
        }

        protected override void OnStop()
        {
            StopAuthority();
        }

        protected override void OnShutdown()
        {
            StopAuthority();
            base.OnShutdown();
        }

        private void StopAuthority()
        {
            stopping = true;
            lock (activeLock)
            {
                foreach (NamedPipeServerStream pipe in activePipes.ToArray())
                {
                    try { pipe.Dispose(); } catch { }
                }
                activePipes.Clear();
            }
            lock (workerLock)
            {
                if (activeWorkerJob != null)
                {
                    activeWorkerJob.Dispose();
                    activeWorkerJob = null;
                }
                if (activeWorker != null)
                {
                    try { if (!activeWorker.HasExited) activeWorker.Kill(); } catch { }
                    activeWorker.Dispose();
                    activeWorker = null;
                }
            }
            if (readThread != null && readThread.IsAlive) readThread.Join(5000);
            if (mutationThread != null && mutationThread.IsAlive) mutationThread.Join(5000);
        }

        private PipeSecurity PipePolicy(string access)
        {
            SecurityIdentifier service = WindowsIdentity.GetCurrent().User;
            SecurityIdentifier system = new SecurityIdentifier("S-1-5-18");
            SecurityIdentifier administrators = new SecurityIdentifier("S-1-5-32-544");
            SecurityIdentifier operatorIdentity = new SecurityIdentifier(options.OperatorSid);
            PipeSecurity policy = new PipeSecurity();
            policy.SetAccessRuleProtection(true, false);
            policy.SetOwner(service);
            policy.AddAccessRule(new PipeAccessRule(service, PipeAccessRights.FullControl, AccessControlType.Allow));
            policy.AddAccessRule(new PipeAccessRule(system, PipeAccessRights.FullControl, AccessControlType.Allow));
            policy.AddAccessRule(new PipeAccessRule(administrators, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            if (String.Equals(access, "read", StringComparison.Ordinal))
                policy.AddAccessRule(new PipeAccessRule(operatorIdentity, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            return policy;
        }

        private NamedPipeServerStream CreatePipe(string name, string access)
        {
            // On the legacy .NET Framework surface, one server instance is the supported way
            // NamedPipeServerStream requests FILE_FLAG_FIRST_PIPE_INSTANCE. Keep this count
            // at one so another server cannot join an existing pipe namespace.
            return new NamedPipeServerStream(
                name,
                PipeDirection.InOut,
                ExclusivePipeServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                4096,
                MaxWireBytes,
                PipePolicy(access));
        }

        private void Serve(string name, string access)
        {
            NamedPipeServerStream pipe = null;
            try
            {
                pipe = CreatePipe(name, access);
                lock (activeLock) activePipes.Add(pipe);
                while (!stopping)
                {
                    pipe.WaitForConnection();
                    if (stopping) return;
                    try
                    {
                        byte[] request = ReadRequest(pipe);
                        if (request == null) continue;
                        byte[] response = InvokeWorker(access, request);
                        if (response == null || response.Length == 0 || response.Length > MaxWireBytes) continue;
                        pipe.Write(response, 0, response.Length);
                        pipe.Flush();
                    }
                    finally
                    {
                        if (!stopping && pipe.IsConnected) pipe.Disconnect();
                    }
                }
            }
            catch
            {
                if (!stopping) Environment.FailFast("DevBridge lifecycle authority endpoint failed closed");
            }
            finally
            {
                if (pipe != null)
                {
                    lock (activeLock) activePipes.Remove(pipe);
                    try { pipe.Dispose(); } catch { }
                }
            }
        }

        private byte[] ReadRequest(NamedPipeServerStream pipe)
        {
            Stopwatch elapsed = Stopwatch.StartNew();
            MemoryStream output = new MemoryStream();
            byte[] buffer = new byte[2048];
            try
            {
                while (output.Length <= MaxWireBytes)
                {
                    int remaining = PreRequestTimeoutMs - (int)elapsed.ElapsedMilliseconds;
                    if (remaining <= 0) throw new System.TimeoutException("lifecycle authority request timed out");
                    Task<int> read = pipe.ReadAsync(buffer, 0, buffer.Length);
                    if (!read.Wait(remaining)) throw new System.TimeoutException("lifecycle authority request timed out");
                    int count = read.Result;
                    if (count <= 0) return null;
                    output.Write(buffer, 0, count);
                    if (output.Length > MaxWireBytes) return null;
                    byte[] current = output.ToArray();
                    int newline = Array.IndexOf(current, (byte)'\n');
                    if (newline < 0) continue;
                    for (int index = newline + 1; index < current.Length; index += 1)
                    {
                        byte value = current[index];
                        if (value != (byte)' ' && value != (byte)'\t' && value != (byte)'\r' && value != (byte)'\n') return null;
                    }
                    byte[] result = new byte[newline + 1];
                    Buffer.BlockCopy(current, 0, result, 0, result.Length);
                    return result;
                }
                return null;
            }
            finally { output.Dispose(); }
        }

        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length == 0) return "\"\"";
            if (value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private byte[] InvokeWorker(string access, byte[] request)
        {
            workerGate.Wait();
            try
            {
                if (stopping) return null;
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = options.NodeExecutable;
                start.Arguments = String.Join(" ", new string[] {
                    QuoteArgument(options.WorkerEntry),
                    "--access", QuoteArgument(access),
                    "--state-directory", QuoteArgument(options.StateDirectory),
                    "--authority-directory", QuoteArgument(options.AuthorityDirectory)
                });
                start.WorkingDirectory = options.ProtectedRoot;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;
                foreach (string name in ScrubbedWorkerEnvironment) start.EnvironmentVariables.Remove(name);

                Process worker = new Process();
                worker.StartInfo = start;
                if (!worker.Start()) throw new InvalidOperationException("authority worker could not start");
                WorkerJob job = null;
                try
                {
                    job = new WorkerJob(worker);
                    lock (workerLock)
                    {
                        if (stopping)
                        {
                            job.Dispose();
                            worker.Kill();
                            return null;
                        }
                        activeWorker = worker;
                        activeWorkerJob = job;
                    }
                    worker.StandardInput.BaseStream.Write(request, 0, request.Length);
                    worker.StandardInput.BaseStream.Flush();
                    worker.StandardInput.Close();

                    MemoryStream stdout = new MemoryStream();
                    byte[] buffer = new byte[2048];
                    while (true)
                    {
                        int count = worker.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length);
                        if (count <= 0) break;
                        stdout.Write(buffer, 0, count);
                        if (stdout.Length > MaxWireBytes)
                        {
                            job.Dispose();
                            return null;
                        }
                    }
                    worker.WaitForExit();
                    if (worker.ExitCode != 0) return null;
                    byte[] response = stdout.ToArray();
                    stdout.Dispose();
                    int newline = Array.IndexOf(response, (byte)'\n');
                    if (newline < 0) return null;
                    for (int index = newline + 1; index < response.Length; index += 1)
                    {
                        byte value = response[index];
                        if (value != (byte)' ' && value != (byte)'\t' && value != (byte)'\r' && value != (byte)'\n') return null;
                    }
                    byte[] exact = new byte[newline + 1];
                    Buffer.BlockCopy(response, 0, exact, 0, exact.Length);
                    return exact;
                }
                finally
                {
                    lock (workerLock)
                    {
                        if (Object.ReferenceEquals(activeWorker, worker)) activeWorker = null;
                        if (Object.ReferenceEquals(activeWorkerJob, job)) activeWorkerJob = null;
                    }
                    if (job != null) job.Dispose();
                    worker.Dispose();
                }
            }
            finally { workerGate.Release(); }
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            try
            {
                HostOptions options = HostOptions.Parse(args);
                ServiceBase.Run(new LifecycleAuthorityService(options));
                return 0;
            }
            catch
            {
                return 1;
            }
        }
    }
}
