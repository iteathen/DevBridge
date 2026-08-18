import { buildToolInventory } from './tool-inventory.js';
import { ToolDiscoveryService } from './tool-discovery.js';

export class ToolInventoryService {
  #discovery;
  #build;
  #current = null;

  constructor({ discoveryService = null, ...buildOptions }) {
    this.#discovery = discoveryService ?? new ToolDiscoveryService({ env: buildOptions.env });
    this.#build = buildOptions;
  }

  get current() { return this.#current ? structuredClone(this.#current) : null; }
  get discovery() { return this.#discovery; }

  async initialize() {
    const discoveredRegistry = await this.#discovery.discover();
    this.#current = await buildToolInventory({ ...this.#build, discoveredRegistry, refresh: false });
    return this.current;
  }

  async refresh({ probeVersions = false, refreshCapabilities = true } = {}) {
    let discoveredRegistry = await this.#discovery.discover();
    if (probeVersions) discoveredRegistry = await this.#discovery.probeVersions();
    this.#current = await buildToolInventory({
      ...this.#build,
      discoveredRegistry,
      refresh: refreshCapabilities,
    });
    return this.current;
  }

  async ensure() {
    if (!this.#current) return this.initialize();
    return this.current;
  }

  chooseCapability(capability) {
    return this.#discovery.chooseCapability(capability);
  }
}
