import { createHash } from 'node:crypto';

// Guest-only SCM adapter. It accepts a fixed seed service identity, never a
// caller-supplied executable, script, command line, or host authority.
export const WINDOWS_SEED_SERVICE_HOST_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace DevBridge.Guest
{
    internal sealed class SeedJob : IDisposable
    {
        private IntPtr handle;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr value);
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcesses;
            public IntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        internal SeedJob(Process process)
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("seed process job could not be created");
            try
            {
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.Flags = 0x2000; // Kill descendants when the service's job closes.
                int size = Marshal.SizeOf(typeof(ExtendedLimits));
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(limits, buffer, false);
                    if (!SetInformationJobObject(handle, 9, buffer, (uint)size)) throw new InvalidOperationException("seed process job could not be constrained");
                }
                finally { Marshal.FreeHGlobal(buffer); }
                if (!AssignProcessToJobObject(handle, process.Handle)) throw new InvalidOperationException("seed process job could not be assigned");
            }
            catch { Dispose(); throw; }
        }
        public void Dispose()
        {
            IntPtr previous = Interlocked.Exchange(ref handle, IntPtr.Zero);
            if (previous != IntPtr.Zero) CloseHandle(previous);
        }
    }

    internal sealed class SeedService : ServiceBase
    {
        private readonly string script;
        private readonly object gate = new object();
        private Process child;
        private SeedJob job;
        private bool stopping;
        internal SeedService(string name, string selectedScript)
        {
            ServiceName = name;
            script = selectedScript;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }
        protected override void OnStart(string[] args)
        {
            lock (gate)
            {
                stopping = false;
                string root = @"C:\ProgramData\DevBridge";
                string node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe");
                if (!File.Exists(node) || !File.Exists(Path.Combine(root, script))) throw new InvalidOperationException("seed service files are absent");
                Process process = new Process();
                process.StartInfo = new ProcessStartInfo(node, "\"" + Path.Combine(root, script) + "\" --watch");
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = true;
                process.StartInfo.WorkingDirectory = root;
                process.StartInfo.EnvironmentVariables.Remove("NODE_OPTIONS");
                process.StartInfo.EnvironmentVariables.Remove("NODE_PATH");
                try
                {
                    if (!process.Start()) throw new InvalidOperationException("seed service process did not start");
                    job = new SeedJob(process);
                    child = process;
                    process.Exited += delegate { ThreadPool.QueueUserWorkItem(delegate { WorkerExited(process); }); };
                    process.EnableRaisingEvents = true;
                    if (process.HasExited) throw new InvalidOperationException("seed service process exited during startup");
                }
                catch
                {
                    if (job != null) { job.Dispose(); job = null; }
                    try { if (!process.HasExited) process.Kill(); } catch { }
                    process.Dispose();
                    child = null;
                    throw;
                }
            }
        }
        private void WorkerExited(Process process)
        {
            lock (gate)
            {
                if (stopping || child != process) return;
                ExitCode = 1;
            }
            Stop();
        }
        protected override void OnStop() { StopWorker(); }
        protected override void OnShutdown() { StopWorker(); base.OnShutdown(); }
        private void StopWorker()
        {
            lock (gate)
            {
                stopping = true;
                if (job != null) { job.Dispose(); job = null; }
                if (child != null)
                {
                    try { if (!child.HasExited) child.Kill(); child.WaitForExit(5000); } catch { }
                    child.Dispose();
                    child = null;
                }
            }
        }
        public static int Main(string[] args)
        {
            if (args.Length != 1) return 2;
            string script;
            switch (args[0])
            {
                case "DevBridgeAccessSeed": script = "windows-access-seed-agent.mjs"; break;
                case "DevBridgeNetworkSeed": script = "network-seed-agent.mjs"; break;
                default: return 2;
            }
            ServiceBase.Run(new SeedService(args[0], script));
            return 0;
        }
    }
}
`;

export function windowsSeedServiceHostMaterial() {
  return Object.freeze({
    sourceBase64: Buffer.from(WINDOWS_SEED_SERVICE_HOST_SOURCE, 'utf8').toString('base64'),
    sourceSha256: createHash('sha256').update(WINDOWS_SEED_SERVICE_HOST_SOURCE, 'utf8').digest('hex'),
  });
}
