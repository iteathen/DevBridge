using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Reflection;

[assembly: AssemblyTitle("DevBridge Protected Setup - reconcile lifecycle service and protected environment")]
[assembly: AssemblyDescription("Reconciles the DevBridge-owned lifecycle service and protected environment configuration")]
[assembly: AssemblyCompany("DevBridge")]
[assembly: AssemblyProduct("DevBridge Protected Setup")]
[assembly: AssemblyCopyright("DevBridge contributors")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace DevBridge.ProtectedSetup
{
    internal sealed class BoundedText
    {
        internal readonly string Value;
        internal readonly bool Truncated;

        internal BoundedText(string value, bool truncated)
        {
            Value = value;
            Truncated = truncated;
        }
    }

    internal sealed class LauncherInputException : Exception
    {
        internal readonly string Stage;

        internal LauncherInputException(string stage, Exception inner)
            : base("DevBridge elevation input was rejected", inner)
        {
            Stage = stage;
        }
    }

    [DataContract]
    internal sealed class BrokerResult
    {
        [DataMember(Name = "protocol", Order = 1)] internal string Protocol;
        [DataMember(Name = "requestedHead", Order = 2)] internal string RequestedHead;
        [DataMember(Name = "started", Order = 3)] internal bool Started;
        [DataMember(Name = "exitCode", Order = 4)] internal int ExitCode;
        [DataMember(Name = "stdout", Order = 5)] internal string Stdout;
        [DataMember(Name = "stderr", Order = 6)] internal string Stderr;
        [DataMember(Name = "error", Order = 7)] internal string Error;
        [DataMember(Name = "outputTruncated", Order = 8)] internal bool OutputTruncated;
    }

    internal static class LifecycleAuthorityElevationLauncher
    {
        private const string InputProtocol = "devbridge/windows-lifecycle-authority-elevation-input-v2";
        private const string ResultProtocol = "devbridge/windows-lifecycle-authority-elevation-broker-v1";
        private const string BindingProtocol = "devbridge/windows-lifecycle-authority-elevation-binding-v1";
        private const int OutputLimit = 32 * 1024;
        private const string ExactHeadPattern = "^[0-9a-f]{40}$";
        private const string DigestPattern = "^[0-9a-f]{64}$";
        private const string ChannelPattern = "^\\.lifecycle-authority-elevation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

        private static bool Matches(string value, string pattern)
        {
            return value != null && Regex.IsMatch(value, pattern, RegexOptions.CultureInvariant);
        }

        private static bool IsInputField(string key)
        {
            return key == "protocol" || key == "home" || key == "node" || key == "nodeSha256"
                || key == "launcher" || key == "launcherSha256" || key == "runnerHead" || key == "bindingDigest";
        }

        private static string Required(Dictionary<string, object> value, string key)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) throw new InvalidDataException("elevation input is missing " + key);
            string text = raw as string;
            if (String.IsNullOrEmpty(text) || text.IndexOf('\0') >= 0) throw new InvalidDataException("elevation input " + key + " is invalid");
            return text;
        }

        private static string FullPath(string value, string name)
        {
            if (!Path.IsPathRooted(value) || value.StartsWith("\\\\", StringComparison.Ordinal) || value.IndexOf('"') >= 0)
                throw new InvalidDataException(name + " is not an absolute local path");
            return Path.GetFullPath(value);
        }

        private static bool SamePath(string left, string right)
        {
            return String.Equals(Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
        }

        private static void RealPath(string value, string name, bool expectFile)
        {
            string full = Path.GetFullPath(value);
            string root = Path.GetPathRoot(full);
            if (String.IsNullOrEmpty(root)) throw new InvalidDataException(name + " has no local root");
            string[] segments = full.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            string current = root;
            for (int index = 0; index < segments.Length; index++)
            {
                current = Path.Combine(current, segments[index]);
                FileAttributes attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException(name + " used filesystem indirection");
                bool last = index == segments.Length - 1;
                bool directory = (attributes & FileAttributes.Directory) != 0;
                if ((!last || !expectFile) && !directory) throw new InvalidDataException(name + " traversed a non-directory");
                if (last && expectFile && directory) throw new InvalidDataException(name + " is not one real file");
            }
        }

        private static void RealFile(string file, string name)
        {
            RealPath(file, name, true);
        }

        private static void RealDirectory(string directory, string name)
        {
            RealPath(directory, name, false);
        }

        private static string Sha256File(string file)
        {
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(stream);
                StringBuilder value = new StringBuilder(digest.Length * 2);
                foreach (byte item in digest) value.Append(item.ToString("x2"));
                return value.ToString();
            }
        }

        private static string Sha256Text(string value)
        {
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(new UTF8Encoding(false).GetBytes(value));
                StringBuilder rendered = new StringBuilder(digest.Length * 2);
                foreach (byte item in digest) rendered.Append(item.ToString("x2"));
                return rendered.ToString();
            }
        }

        private static string BindingDigest(string home, string node, string nodeDigest, string launcher, string launcherDigest, string runnerHead)
        {
            return Sha256Text(BindingProtocol + "\0" + home + "\0" + node + "\0" + nodeDigest + "\0" + launcher + "\0" + launcherDigest + "\0" + runnerHead);
        }

        private static string Quote(string value)
        {
            if (value.IndexOf('"') >= 0)
            {
                throw new InvalidOperationException("elevation launcher argument contains a quote");
            }
            return "\"" + value + "\"";
        }

        private static BoundedText ReadBounded(StreamReader reader)
        {
            char[] buffer = new char[4096];
            StringBuilder kept = new StringBuilder();
            int keptBytes = 0;
            bool truncated = false;
            while (true)
            {
                int count = reader.Read(buffer, 0, buffer.Length);
                if (count == 0) break;
                string chunk = new string(buffer, 0, count);
                int chunkBytes = Encoding.UTF8.GetByteCount(chunk);
                if (!truncated && keptBytes + chunkBytes <= OutputLimit)
                {
                    kept.Append(chunk);
                    keptBytes += chunkBytes;
                }
                else
                {
                    truncated = true;
                }
            }
            return new BoundedText(truncated ? String.Empty : kept.ToString().Trim(), truncated);
        }

        private static Dictionary<string, object> LoadInput(string inputFile, string expectedHead)
        {
            string stage = "file-metadata";
            try
            {
                FileInfo inputInfo = new FileInfo(inputFile);
                if (!inputInfo.Exists || inputInfo.Length < 2 || inputInfo.Length > 16 * 1024 || (inputInfo.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("elevation input is not one bounded real file");
                stage = "file-read";
                string json = File.ReadAllText(inputFile, new UTF8Encoding(false, true));
                Dictionary<string, object> data;
                stage = "deserialize";
                DataContractJsonSerializerSettings settings = new DataContractJsonSerializerSettings();
                settings.UseSimpleDictionaryFormat = true;
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(Dictionary<string, object>), settings);
                using (MemoryStream stream = new MemoryStream(new UTF8Encoding(false, true).GetBytes(json), false))
                {
                    data = serializer.ReadObject(stream) as Dictionary<string, object>;
                    stage = "trailing-data";
                    if (stream.Position != stream.Length) throw new InvalidDataException("elevation input has trailing data");
                }
                stage = "protocol";
                if (data == null || Required(data, "protocol") != InputProtocol) throw new InvalidDataException("elevation input protocol is invalid");
                stage = "shape";
                if (data.Count != 8) throw new InvalidDataException("elevation input shape is invalid");
                foreach (string key in data.Keys) if (!IsInputField(key)) throw new InvalidDataException("elevation input shape is invalid");

                stage = "paths";
                string home = FullPath(Required(data, "home"), "elevation home");
                string node = FullPath(Required(data, "node"), "elevation Node executable");
                string launcher = FullPath(Required(data, "launcher"), "elevation runner launcher");
                string runnerHead = Required(data, "runnerHead");
                string nodeDigest = Required(data, "nodeSha256");
                string launcherDigest = Required(data, "launcherSha256");
                string bindingDigest = Required(data, "bindingDigest");
                stage = "identity";
                if (!Matches(runnerHead, ExactHeadPattern) || !Matches(nodeDigest, DigestPattern) || !Matches(launcherDigest, DigestPattern) || !Matches(bindingDigest, DigestPattern) || runnerHead != expectedHead)
                    throw new InvalidDataException("elevation input identity is invalid");

                string state = Path.Combine(home, "state");
                string channel = Path.GetDirectoryName(inputFile);
                stage = "channel";
                if (String.IsNullOrEmpty(channel) || !SamePath(Path.GetDirectoryName(channel), state) || !Matches(Path.GetFileName(channel), ChannelPattern) || !SamePath(inputFile, Path.Combine(channel, "input.json")))
                    throw new InvalidDataException("elevation input escaped the managed channel");
                stage = "home-path";
                RealDirectory(home, "elevation home");
                stage = "state-path";
                RealDirectory(state, "elevation state");
                stage = "channel-path";
                RealDirectory(channel, "elevation channel");
                stage = "input-path";
                RealFile(inputFile, "elevation input");
                stage = "node-path";
                RealFile(node, "elevation Node executable");
                stage = "launcher-path";
                RealFile(launcher, "elevation runner launcher");
                stage = "node-name";
                if (!String.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("elevation executable is not Node");
                stage = "launcher-name";
                if (!String.Equals(Path.GetFileName(launcher), "cli.js", StringComparison.OrdinalIgnoreCase) || !String.Equals(Path.GetFileName(Path.GetDirectoryName(launcher)), "src", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("elevation runner launcher is not the fixed CLI");

                string runnerRoot = Path.GetDirectoryName(Path.GetDirectoryName(launcher));
                string headFile = Path.Combine(runnerRoot, ".git", "HEAD");
                stage = "runner-root";
                RealDirectory(runnerRoot, "elevation runner root");
                stage = "runner-git";
                RealDirectory(Path.Combine(runnerRoot, ".git"), "elevation runner Git directory");
                stage = "runner-head-path";
                RealFile(headFile, "elevation runner head");
                stage = "runner-head";
                if (File.ReadAllText(headFile, Encoding.UTF8).Trim().ToLowerInvariant() != runnerHead) throw new InvalidDataException("elevation runner head changed");
                stage = "content-digests";
                if (Sha256File(node) != nodeDigest || Sha256File(launcher) != launcherDigest) throw new InvalidDataException("elevation executable bytes changed");
                stage = "binding-digest";
                if (BindingDigest(home, node, nodeDigest, launcher, launcherDigest, runnerHead) != bindingDigest) throw new InvalidDataException("elevation binding digest is invalid");
                return data;
            }
            catch (LauncherInputException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new LauncherInputException(stage, error);
            }
        }

        private static bool IsElevated()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }

        private static byte[] SerializeResult(BrokerResult record)
        {
            DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(BrokerResult));
            using (MemoryStream stream = new MemoryStream())
            {
                serializer.WriteObject(stream, record);
                stream.WriteByte((byte)'\n');
                return stream.ToArray();
            }
        }

        private static int Apply(string inputFile, string expectedHead)
        {
            Dictionary<string, object> data = LoadInput(inputFile, expectedHead);
            BrokerResult record = new BrokerResult();
            record.Protocol = ResultProtocol;
            record.RequestedHead = expectedHead;
            record.Started = false;
            record.ExitCode = 1;
            record.Stdout = String.Empty;
            record.Stderr = String.Empty;
            record.Error = null;
            record.OutputTruncated = false;
            SerializeResult(record);
            if (!IsElevated()) throw new UnauthorizedAccessException("DevBridge protected setup did not receive administrator authority");
            string resultFile = Path.Combine(Path.GetDirectoryName(inputFile), "result.json");
            int brokerExit = 1;
            try
            {
                string home = Required(data, "home");
                string node = Required(data, "node");
                string launcher = Required(data, "launcher");
                Environment.SetEnvironmentVariable("DEVBRIDGE_HOME", home);
                Environment.SetEnvironmentVariable("DEVBRIDGE_LIFECYCLE_AUTHORITY_ELEVATED_CHILD", "1");

                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = node;
                start.Arguments = Quote(launcher) + " setup --lifecycle-authority-child --no-update";
                start.WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(launcher));
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                using (Process child = new Process())
                {
                    child.StartInfo = start;
                    if (!child.Start()) throw new InvalidOperationException("lifecycle authority child did not start");
                    Task<BoundedText> stdout = Task.Factory.StartNew(() => ReadBounded(child.StandardOutput));
                    Task<BoundedText> stderr = Task.Factory.StartNew(() => ReadBounded(child.StandardError));
                    child.WaitForExit();
                    Task.WaitAll(stdout, stderr);
                    record.Started = true;
                    record.ExitCode = child.ExitCode;
                    record.Stdout = stdout.Result.Value;
                    record.Stderr = stderr.Result.Value;
                    record.OutputTruncated = stdout.Result.Truncated || stderr.Result.Truncated;
                    brokerExit = child.ExitCode;
                }
            }
            catch (Exception error)
            {
                string message = (error.Message ?? "elevation broker failed").Replace('\r', ' ').Replace('\n', ' ').Trim();
                record.ExitCode = brokerExit;
                record.Error = message.Length > 2048 ? message.Substring(0, 2048) : message;
            }
            finally
            {
                byte[] json = SerializeResult(record);
                using (FileStream stream = new FileStream(resultFile, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(json, 0, json.Length);
                }
            }
            return brokerExit;
        }

        private static int Identity()
        {
            const string value = "{\"protocol\":\"devbridge/windows-lifecycle-authority-elevation-launcher-v1\",\"fileDescription\":\"DevBridge Protected Setup - reconcile lifecycle service and protected environment\",\"purpose\":\"Reconcile the DevBridge-owned lifecycle service and protected environment configuration\",\"executionLevel\":\"asInvoker\",\"uiAccess\":false}";
            byte[] output = new UTF8Encoding(false).GetBytes(value + Environment.NewLine);
            using (Stream stream = Console.OpenStandardOutput()) stream.Write(output, 0, output.Length);
            return 0;
        }

        public static int Main(string[] args)
        {
            try
            {
                if (args.Length == 1 && args[0] == "--identity") return Identity();
                if (args.Length != 3 || args[0] != "--apply" || !Matches(args[2], ExactHeadPattern)) return 2;
                return Apply(FullPath(args[1], "elevation input"), args[2]);
            }
            catch (Exception error)
            {
                try
                {
                    StringBuilder types = new StringBuilder();
                    Exception current = error;
                    for (int depth = 0; current != null && depth < 4; depth += 1)
                    {
                        if (types.Length > 0) types.Append('>');
                        types.Append(current.GetType().Name);
                        current = current.InnerException;
                    }
                    LauncherInputException inputError = error as LauncherInputException;
                    string stage = inputError == null ? String.Empty : " stage=" + inputError.Stage;
                    Console.Error.WriteLine("DevBridge elevation launcher rejected input" + stage + ": " + types.ToString());
                }
                catch {}
                return 2;
            }
        }
    }
}
