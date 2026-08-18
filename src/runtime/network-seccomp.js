import { PolicyError } from '../errors.js';

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;

const ARCHITECTURES = {
  x64: {
    auditArch: 0xc000003e,
    deniedSyscalls: [
      41,  // socket
      42,  // connect
      44,  // sendto
      46,  // sendmsg
      307, // sendmmsg
      425, // io_uring_setup - prevents async socket/connect bypass
    ],
  },
  arm64: {
    auditArch: 0xc00000b7,
    deniedSyscalls: [
      198, // socket
      203, // connect
      206, // sendto
      211, // sendmsg
      269, // sendmmsg
      425, // io_uring_setup - prevents async socket/connect bypass
    ],
  },
};

function instruction(code, jt, jf, k) {
  return { code, jt, jf, k: k >>> 0 };
}

function encodeClassicBpf(instructions) {
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach((entry, index) => {
    const offset = index * 8;
    buffer.writeUInt16LE(entry.code, offset);
    buffer.writeUInt8(entry.jt, offset + 2);
    buffer.writeUInt8(entry.jf, offset + 3);
    buffer.writeUInt32LE(entry.k, offset + 4);
  });
  return buffer;
}

export function networkSeccompDescriptor(arch = process.arch) {
  const descriptor = ARCHITECTURES[arch];
  if (!descriptor) throw new PolicyError(`kernel seccomp network-deny filter is unsupported on architecture ${arch}`);
  return {
    architecture: arch,
    auditArch: descriptor.auditArch,
    deniedSyscalls: [...descriptor.deniedSyscalls],
    effect: 'deny-network-syscalls-with-eperm',
  };
}

export function buildNetworkDenySeccompFilter(arch = process.arch) {
  const { auditArch, deniedSyscalls } = networkSeccompDescriptor(arch);
  const instructions = [
    instruction(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH_OFFSET),
    instruction(BPF_JMP_JEQ_K, 1, 0, auditArch),
    instruction(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instruction(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR_OFFSET),
  ];
  for (const syscall of deniedSyscalls) {
    instructions.push(instruction(BPF_JMP_JEQ_K, 0, 1, syscall));
    instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  }
  instructions.push(instruction(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  return encodeClassicBpf(instructions);
}
