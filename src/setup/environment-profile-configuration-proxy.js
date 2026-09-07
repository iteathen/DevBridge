import { inspectEnvironmentProfileConfiguration } from '../runtime/environment-profile-configuration.js';

function result({ ready, changed = false, blocker = null }) {
  return Object.freeze({ ready, changed, blocker });
}

function functionPort(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'function') throw new TypeError(`${name} port is invalid`);
  return value;
}

function lifecycle(value) {
  if (!value || typeof value.list !== 'function') throw new TypeError('environment profile setup observation contract is incomplete');
  return value;
}

function configuration(value) {
  if (!value || typeof value.reconcile !== 'function') throw new TypeError('environment profile setup configuration contract is incomplete');
  return value;
}

function exactRecord(record, expected) {
  if (record == null || record.revision !== expected.revision || record.digest !== expected.digest) {
    throw new Error('accepted environment profile configuration subject changed');
  }
  return record;
}

function publication(value, expected) {
  if (value?.ready !== true || typeof value.changed !== 'boolean'
      || value.revision !== expected.revision || value.subject !== expected.digest) {
    throw new Error('accepted environment profile configuration publication evidence changed');
  }
  return value;
}

export function createEnvironmentProfileConfigurationProxy({
  readAccepted,
  createConfigurationClient,
  publishAccepted = async (record) => Object.freeze({
    ready: true,
    changed: false,
    revision: record.revision,
    subject: record.digest,
  }),
  createResourceObserver = null,
} = {}) {
  const accepted = functionPort(readAccepted, 'environment profile setup accepted-state');
  const clientFactory = functionPort(createConfigurationClient, 'environment profile setup configuration-client');
  const publisher = functionPort(publishAccepted, 'environment profile setup publication');
  const resourceFactory = functionPort(createResourceObserver, 'environment profile setup resource-observer', { nullable: true });

  return Object.freeze({
    async inspect({ client } = {}) {
      const selected = lifecycle(client);
      const record = await accepted();
      if (record == null || record.configuration.declarations.length === 0) return result({ ready: true });
      try {
        const declarations = await selected.list();
        const inspected = inspectEnvironmentProfileConfiguration(record, declarations);
        if (!inspected.ready) return result({ ready: false, blocker: inspected.blocker });
        if (resourceFactory != null) {
          const resources = await resourceFactory().inspect();
          if (resources?.ready !== true) return result({ ready: false, blocker: 'protected environment resources do not match accepted profile requirements' });
        }
        return result({ ready: true });
      } catch {
        return result({ ready: false, blocker: 'protected profile state could not be verified against accepted configuration' });
      }
    },

    async reconcile() {
      const record = await accepted();
      if (record == null || record.configuration.declarations.length === 0) return result({ ready: true });
      const published = publication(await publisher(record), record);
      exactRecord(await accepted(), record);
      const client = configuration(clientFactory());
      const reconciled = await client.reconcile({ revision: record.revision, subject: record.digest });
      if (reconciled?.ready !== true || reconciled.revision !== record.revision || reconciled.subject !== record.digest
          || typeof reconciled.changed !== 'boolean') {
        throw new Error('protected environment configuration evidence changed');
      }
      exactRecord(await accepted(), record);
      return result({ ready: true, changed: published.changed || reconciled.changed });
    },
  });
}
