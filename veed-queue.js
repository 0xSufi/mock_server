import crypto from 'crypto';
import { getVeedService, initVeedService } from './veed-service.js';

// Queue states
const OperationStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

class VeedQueue {
  constructor() {
    // Map of operationId -> operation details
    this.operations = new Map();

    // Queue of pending operation IDs
    this.queue = [];

    // Currently processing operation
    this.currentOperation = null;

    // Is the worker running
    this.isProcessing = false;

    // Service state
    this.serviceReady = false;
    this.serviceInitializing = false;

    // Max concurrent operations (limited to 1 due to single browser)
    this.maxConcurrent = 1;

    // Operation timeout (5 minutes)
    this.operationTimeout = 300000;

    // Max queue size
    this.maxQueueSize = 10;

    // Operation cleanup interval (clean up old completed/failed operations after 30 mins)
    this.cleanupInterval = setInterval(() => this.cleanupOldOperations(), 60000);
    this.operationTTL = 30 * 60 * 1000; // 30 minutes
  }

  // Initialize the Veed service
  async initializeService() {
    if (this.serviceInitializing) {
      // Wait for ongoing initialization
      while (this.serviceInitializing) {
        await new Promise(r => setTimeout(r, 100));
      }
      return this.serviceReady;
    }

    if (this.serviceReady) {
      return true;
    }

    this.serviceInitializing = true;

    try {
      console.log('[VeedQueue] Initializing Veed.io service...');
      this.serviceReady = await initVeedService();
      console.log('[VeedQueue] Veed.io service ready:', this.serviceReady);
    } catch (error) {
      console.error('[VeedQueue] Failed to initialize Veed.io service:', error.message);
      this.serviceReady = false;
    }

    this.serviceInitializing = false;
    return this.serviceReady;
  }

  // Enqueue a new video generation request
  async enqueue(imageUrl, prompt, options = {}) {
    // Check queue size limit
    const pendingCount = this.queue.length + (this.currentOperation ? 1 : 0);
    if (pendingCount >= this.maxQueueSize) {
      throw new Error(`Queue is full. Maximum ${this.maxQueueSize} pending operations allowed.`);
    }

    const operationId = crypto.randomUUID();
    const operation = {
      id: operationId,
      status: OperationStatus.QUEUED,
      imageUrl,
      prompt,
      options,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      position: this.queue.length + 1,
      result: null,
      error: null,
      progress: null,
    };

    this.operations.set(operationId, operation);
    this.queue.push(operationId);

    console.log(`[VeedQueue] Enqueued operation ${operationId}, queue position: ${operation.position}`);

    // Start processing if not already running
    this.processQueue();

    return {
      operationId,
      status: operation.status,
      position: operation.position,
      queueLength: this.queue.length,
    };
  }

  // Get operation status
  getStatus(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return null;
    }

    // Calculate current position if still queued
    let position = null;
    if (operation.status === OperationStatus.QUEUED) {
      position = this.queue.indexOf(operationId) + 1;
    }

    return {
      operationId: operation.id,
      status: operation.status,
      position,
      queueLength: this.queue.length,
      progress: operation.progress,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      result: operation.result,
      error: operation.error,
    };
  }

  // Get all operations status (for monitoring)
  getAllStatus() {
    const operations = [];
    for (const [id, op] of this.operations) {
      operations.push({
        operationId: id,
        status: op.status,
        createdAt: op.createdAt,
        updatedAt: op.updatedAt,
      });
    }

    return {
      queueLength: this.queue.length,
      processing: this.currentOperation !== null,
      currentOperationId: this.currentOperation,
      serviceReady: this.serviceReady,
      operations: operations.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20),
    };
  }

  // Cancel a queued operation
  cancel(operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return { success: false, error: 'Operation not found' };
    }

    if (operation.status !== OperationStatus.QUEUED) {
      return { success: false, error: `Cannot cancel operation in ${operation.status} status` };
    }

    // Remove from queue
    const index = this.queue.indexOf(operationId);
    if (index > -1) {
      this.queue.splice(index, 1);
    }

    operation.status = OperationStatus.FAILED;
    operation.error = 'Cancelled by user';
    operation.updatedAt = Date.now();

    console.log(`[VeedQueue] Cancelled operation ${operationId}`);

    return { success: true };
  }

  // Process the queue
  async processQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Ensure service is ready
      if (!this.serviceReady) {
        const ready = await this.initializeService();
        if (!ready) {
          console.error('[VeedQueue] Service not ready, pausing queue processing');
          // Mark all queued operations as failed
          for (const opId of this.queue) {
            const op = this.operations.get(opId);
            if (op) {
              op.status = OperationStatus.FAILED;
              op.error = 'Veed service not available';
              op.updatedAt = Date.now();
            }
          }
          this.queue = [];
          break;
        }
      }

      const operationId = this.queue.shift();
      const operation = this.operations.get(operationId);

      if (!operation) {
        continue;
      }

      this.currentOperation = operationId;
      operation.status = OperationStatus.PROCESSING;
      operation.updatedAt = Date.now();

      console.log(`[VeedQueue] Processing operation ${operationId}`);

      try {
        const result = await this.executeWithTimeout(operation);

        operation.status = OperationStatus.COMPLETED;
        operation.result = result;
        operation.updatedAt = Date.now();

        console.log(`[VeedQueue] Completed operation ${operationId}`);
      } catch (error) {
        operation.status = OperationStatus.FAILED;
        operation.error = error.message;
        operation.updatedAt = Date.now();

        console.error(`[VeedQueue] Failed operation ${operationId}:`, error.message);
      }

      this.currentOperation = null;
    }

    this.isProcessing = false;
  }

  // Execute operation with timeout
  async executeWithTimeout(operation) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Operation timed out')), this.operationTimeout);
    });

    const executePromise = this.executeOperation(operation);

    return Promise.race([executePromise, timeoutPromise]);
  }

  // Execute a single operation
  async executeOperation(operation) {
    const service = await getVeedService();

    // Update progress callback
    const updateProgress = (progress) => {
      operation.progress = progress;
      operation.updatedAt = Date.now();
    };

    updateProgress('Starting video generation...');

    const result = await service.generateVideo(
      operation.imageUrl,
      operation.prompt,
      operation.options
    );

    return result;
  }

  // Clean up old completed/failed operations
  cleanupOldOperations() {
    const now = Date.now();
    const toDelete = [];

    for (const [id, op] of this.operations) {
      if (
        (op.status === OperationStatus.COMPLETED || op.status === OperationStatus.FAILED) &&
        now - op.updatedAt > this.operationTTL
      ) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.operations.delete(id);
      console.log(`[VeedQueue] Cleaned up old operation ${id}`);
    }

    if (toDelete.length > 0) {
      console.log(`[VeedQueue] Cleaned up ${toDelete.length} old operations`);
    }
  }

  // Get service health status
  async getHealth() {
    try {
      const service = await getVeedService();
      const status = await service.getAuthStatus();

      return {
        available: this.serviceReady,
        authenticated: status.authenticated,
        browserConnected: status.browserConnected,
        initializing: this.serviceInitializing,
        queueLength: this.queue.length,
        processing: this.currentOperation !== null,
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        browserConnected: false,
        initializing: this.serviceInitializing,
        queueLength: this.queue.length,
        processing: false,
        error: error.message,
      };
    }
  }

  // Shutdown cleanup
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
let veedQueue = null;

export function getVeedQueue() {
  if (!veedQueue) {
    veedQueue = new VeedQueue();
  }
  return veedQueue;
}

export { OperationStatus };
export default VeedQueue;
