import { INSTALLER_EVIDENCE_PROTOCOL } from '../construction-install-evidence.js';

const ROOT = '/run/devbridge-installer-evidence';
const AGENT = `${ROOT}/agent`;
// The live installer's /run may be mounted noexec. Invoke its shell explicitly.
const SHELL = '/bin/sh';

// This program runs only in the live installer. Its socket entry accepts one
// fixed selector, never a command, path, executable or publication destination.
const SCRIPT = String.raw`#!/bin/sh
set -eu
command_path_set=\${PATH+x}
command_path=\${PATH-}
command_umask=$(umask)
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
root=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)

load_record() {
  sequence=0 phase=installing stage=installer-start exit_code=null extra=
  if [ -e "$root/record" ]; then
    [ -f "$root/record" ] && [ ! -L "$root/record" ] || exit 65
    [ "$(wc -c <"$root/record")" -le 160 ] || exit 65
    IFS=' ' read -r sequence phase stage exit_code extra <"$root/record" || exit 65
    case "$sequence" in ''|*[!0-9]*) exit 65;; esac
    [ "$sequence" -ge 1 ] && [ "$sequence" -le 1000000 ] || exit 65
    case "$phase" in installing|failed|finished) ;; *) exit 65;; esac
    case "$stage" in installer-start|installation-basis|apt-update|apt-upgrade|apt-install|installer-finish) ;; *) exit 65;; esac
    case "$exit_code" in null) ;; ''|*[!0-9]*) exit 65;; *) [ "$exit_code" -le 255 ] || exit 65;; esac
    [ -z "$extra" ] || exit 65
  fi
}

record() {
  next_phase=$1 next_stage=$2 next_exit=$3
  load_record
  # Error hooks and later invocations cannot replace the first failure.
  [ "$phase" != failed ] || return 0
  sequence=$((sequence + 1))
  printf '%s %s %s %s\n' "$sequence" "$next_phase" "$next_stage" "$next_exit" >"$root/record.next"
  mv -f -- "$root/record.next" "$root/record"
}

emit() {
  printf '{"protocol":"@PROTOCOL@","identity":"@IDENTITY@","attempt":1,"sequence":%s,"phase":"%s","stage":"%s","exitCode":%s,"collection":"%s","truncated":%s,"stdoutBase64":"","stderrBase64":"%s"}\n' \
    "$sequence" "$phase" "$stage" "$exit_code" "$collection" "$truncated" "$diagnostics"
}

diagnostic_frame() {
  # Only this installer journal is selected. The autoinstall document and
  # server debug dump can contain access material and are never exported.
  link=$(readlink /var/log/installer/subiquity-server-info.log 2>/dev/null) || { emit; return; }
  case "$link" in subiquity-server-info.log.*) ;; *) emit; return;; esac
  pid=\${link#subiquity-server-info.log.}
  case "$pid" in ''|*[!0-9]*) emit; return;; esac
  [ "\${#pid}" -le 10 ] || { emit; return; }
  temporary=$(mktemp -d "$root/diagnostics.XXXXXXXX") || { emit; return; }
  trap 'rm -f -- "$temporary/output" "$temporary/exit"; rmdir -- "$temporary"' EXIT
  # Both guest storage and returned bytes are bounded, including a journal
  # entry with an arbitrarily large message. Newest entries come first.
  (
    if timeout --kill-after=1s 10s journalctl --identifier="subiquity_log.$pid" --reverse --lines=120 --output=cat --no-pager 2>/dev/null; then
      journal_exit=0
    else
      journal_exit=$?
    fi
    printf '%s\n' "$journal_exit" >"$temporary/exit"
  ) | head -c 16385 >"$temporary/output"
  count=$(wc -c <"$temporary/output")
  journal_exit=$(cat "$temporary/exit" 2>/dev/null) || journal_exit=1
  if [ "$count" -gt 0 ]; then
    collection=complete
    if [ "$count" -gt 16384 ]; then truncated=true; fi
    if [ "$journal_exit" -ne 0 ]; then collection=partial; fi
    diagnostics=$(head -c 16384 "$temporary/output" | base64 --wrap=0)
  fi
  emit
}

case "\${1-}" in
  initialize)
    [ "$#" -eq 1 ] || exit 64
    if [ ! -e "$root/record" ]; then record installing installer-start null; else load_record; fi
    ;;
  run)
    [ "$#" -ge 3 ] || exit 64
    selected_stage=$2
    case "$selected_stage" in installation-basis|apt-update|apt-upgrade|apt-install) ;; *) exit 64;; esac
    shift 2
    load_record
    [ "$phase" != failed ] || exit 1
    record installing "$selected_stage" null
    # Only the wrapped child inherits the caller's tool lookup and file mask.
    # Bookkeeping and socket reads keep the fixed diagnostic environment.
    if (
      if [ "$command_path_set" = x ]; then PATH=$command_path; export PATH; else unset PATH; fi
      umask "$command_umask"
      "$@"
    ); then
      exit 0
    else
      command_exit=$?
      record failed "$selected_stage" "$command_exit"
      exit "$command_exit"
    fi
    ;;
  error)
    [ "$#" -eq 1 ] || exit 64
    load_record
    record failed "$stage" null
    ;;
  finish)
    [ "$#" -eq 1 ] || exit 64
    load_record
    [ "$phase" != failed ] || exit 1
    record finished installer-finish 0
    ;;
  serve)
    [ "$#" -eq 1 ] || exit 64
    # The host half-closes after its single-byte request. Reading two bytes
    # rejects extra selectors while bounding parser memory.
    selector=$(dd bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')
    case "$selector" in 53|44) ;; *) exit 64;; esac
    load_record
    [ "$sequence" -gt 0 ] || exit 69
    collection=unavailable truncated=false diagnostics=
    if [ "$selector" = 44 ]; then diagnostic_frame; else emit; fi
    ;;
  *) exit 64;;
esac
`;

export function createUbuntuInstallerEvidence(identity) {
  if (typeof identity !== 'string' || !/^subject-[a-f0-9]{32}$/u.test(identity)) throw new TypeError('Ubuntu installer evidence identity is invalid');
  // Escaped template substitutions above are POSIX shell expansions.
  const content = SCRIPT.replaceAll('\\${', '${').replace('@PROTOCOL@', INSTALLER_EVIDENCE_PROTOCOL).replace('@IDENTITY@', identity);
  const encoded = Buffer.from(content).toString('base64');
  const initialize = [SHELL, '-c', `set -eu\numask 077\nmkdir -p ${ROOT}\n[ -d ${ROOT} ] && [ ! -L ${ROOT} ]\n[ ! -e ${AGENT} ] && [ ! -L ${AGENT} ]\nprintf '%s' '${encoded}' | base64 --decode >${AGENT}\nchmod 0700 ${AGENT}\n${SHELL} ${AGENT} initialize\n`];
  return Object.freeze({
    file: Object.freeze({ path: AGENT, content, permissions: '0700' }),
    initialize: Object.freeze(initialize),
    error: Object.freeze([SHELL, AGENT, 'error']),
    finish: Object.freeze([SHELL, AGENT, 'finish']),
    wrap(stage, command) {
      if (!['installation-basis', 'apt-update', 'apt-upgrade', 'apt-install'].includes(stage)
          || !Array.isArray(command) || command.length === 0
          || command.some(value => typeof value !== 'string' || value.length === 0 || value.includes('\0'))) throw new TypeError('Ubuntu installer observation command is invalid');
      return Object.freeze([SHELL, AGENT, 'run', stage, ...command]);
    },
  });
}

export function createUbuntuInstallerEvidenceActivation({ port }) {
  if (!Number.isSafeInteger(port) || port <= 1024 || port >= 0xffffffff) throw new TypeError('installer evidence socket port is invalid');
  const socket = 'devbridge-installer-evidence.socket';
  const service = 'devbridge-installer-evidence@.service';
  const files = Object.freeze([
    Object.freeze({
      path: `/run/systemd/system/${socket}`, permissions: '0644',
      content: `[Unit]\nDescription=DevBridge live installer evidence\n\n[Socket]\nListenStream=vsock::${port}\nAccept=yes\nBacklog=4\nMaxConnections=4\nTriggerLimitIntervalSec=30s\nTriggerLimitBurst=60\n`,
    }),
    Object.freeze({
      path: `/run/systemd/system/${service}`, permissions: '0644',
      content: `[Unit]\nDescription=DevBridge bounded installer evidence reader\n\n[Service]\nType=exec\nExecStart=/bin/sh ${AGENT} serve\nStandardInput=socket\nStandardOutput=socket\nStandardError=null\nRuntimeMaxSec=20s\nTimeoutStopSec=1s\nKillMode=control-group\nMemoryMax=64M\nCPUQuota=25%\nTasksMax=16\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nReadWritePaths=${ROOT}\nProtectHome=yes\nPrivateTmp=yes\nRestrictAddressFamilies=AF_UNIX AF_VSOCK\n`,
    }),
  ]);
  const commands = ['set -eu', 'umask 077', 'mkdir -p /run/systemd/system', '[ -d /run/systemd/system ] && [ ! -L /run/systemd/system ]'];
  for (const file of files) {
    commands.push(`[ ! -e ${file.path} ] && [ ! -L ${file.path} ]`,
      `printf '%s' '${Buffer.from(file.content).toString('base64')}' | base64 --decode >${file.path}`,
      `chmod ${file.permissions} ${file.path}`);
  }
  commands.push('systemctl daemon-reload');
  return Object.freeze({
    files,
    install: Object.freeze(['sh', '-c', `${commands.join('\n')}\n`]),
    start: Object.freeze(['systemctl', 'start', socket]),
  });
}
