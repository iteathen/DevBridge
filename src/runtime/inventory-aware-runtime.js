function inventoryReference(inventory) {
  if (!inventory) return null;
  return {
    protocol: inventory.protocol,
    digest: inventory.digest,
    generation: inventory.generation,
  };
}

export class InventoryAwareProcessRunner {
  #delegate;
  #inventory;

  constructor({ delegate, inventoryService }) {
    this.#delegate = delegate;
    this.#inventory = inventoryService;
  }

  async run(request) {
    const inventory = await this.#inventory.ensure();
    const context = {
      ...request.context,
      toolInventory: inventoryReference(inventory),
    };
    try {
      return await this.#delegate.run({ ...request, context });
    } catch (error) {
      try { await this.#inventory.refresh({ refreshCapabilities: true }); }
      catch { /* telemetry refresh must not replace the execution error */ }
      throw error;
    }
  }
}

export class InventoryAwareStatusReporter {
  #delegate;
  #inventory;
  #projector;

  constructor({ delegate, inventoryService, projector }) {
    this.#delegate = delegate;
    this.#inventory = inventoryService;
    this.#projector = projector;
  }

  async publish(request) {
    const inventory = await this.#inventory.ensure();
    const capsule = request.capsule ? structuredClone(request.capsule) : null;
    if (capsule) capsule.toolInventory = inventoryReference(inventory);
    if (this.#projector) {
      void this.#projector.project({ issueNumber: request.issueNumber, inventory }).catch(() => null);
    }
    return this.#delegate.publish({ ...request, capsule });
  }
}
