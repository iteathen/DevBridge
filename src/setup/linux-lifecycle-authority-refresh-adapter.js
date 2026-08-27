import {
  createProtectedAuthorityRefreshPorts,
  reconcileProtectedAuthorityRefresh,
} from './protected-authority-refresh-adapter.js';

const DIAGNOSTIC_PROTOCOL = 'devbridge/linux-lifecycle-authority-migration-diagnostic-v1';

export function createLinuxLifecycleAuthorityRefreshPorts({ mechanics, onDiagnostic = null } = {}) {
  return createProtectedAuthorityRefreshPorts({ mechanics, onDiagnostic, diagnosticProtocol: DIAGNOSTIC_PROTOCOL });
}

export async function reconcileLinuxLifecycleAuthorityRefresh({ candidateGeneration, mechanics, onDiagnostic = null } = {}) {
  return await reconcileProtectedAuthorityRefresh({ candidateGeneration, mechanics, onDiagnostic, diagnosticProtocol: DIAGNOSTIC_PROTOCOL });
}
