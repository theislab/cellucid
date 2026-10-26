/**
 * @fileoverview A gene route: one analysis run's direct line from the
 * dataset's reader worker to every analysis worker, so the genes the run
 * computes go from the reader to the workers and never cross this thread
 * (`data/gene-delivery.js`).
 *
 * Relaying a run's genes through the page cost it, beyond the messages: in
 * WebKit every array a worker sends here is counted as the page's own
 * allocation, so a run over every gene of a large dataset drove the page's
 * garbage collector -- whole-heap collections included -- while it ran,
 * each one holding the page's thread. Over a route the page sends only
 * which genes to read where, and hears back their bytes and the workers'
 * results.
 *
 * A route is one `MessageChannel` per worker of the pool: the reader takes
 * one end of each (`DataLayer.openGeneRoute`), each worker the other
 * (`GENE_ROUTE_OPEN`, kept by the pool for a worker it replaces). A worker
 * the pool replaced gets a new channel, one generation on; its genes still
 * on their way to the old one are read again by the run.
 *
 * A run delivers each batch of genes to the worker with the fewest genes
 * outstanding (`assign`), and hands that worker the batch's task.
 *
 * @module analysis/data/gene-route
 */

let nextRoute = 1;

/** Workers' kept state under a route's id (`WorkerPool.broadcast`'s `retainAs`). */
const ROUTE_OPEN = 'GENE_ROUTE_OPEN';
const ROUTE_CLOSE = 'GENE_ROUTE_CLOSE';

export class GeneRoute {
  /**
   * Open a route from the dataset's reader to every worker of `pool`, or
   * null when the dataset cannot deliver its genes (its reader is not a
   * worker): the run then reads its genes here.
   *
   * @param {{dataLayer: Object, pool: import('../compute/worker-pool.js').WorkerPool, signal?: AbortSignal|null}} options -
   *   `pool` ready
   * @returns {Promise<GeneRoute|null>}
   */
  static async open({ dataLayer, pool, signal = null }) {
    if (typeof dataLayer?.deliversGenes !== 'function' || !dataLayer.deliversGenes()) return null;
    const id = `gene-route-${nextRoute++}`;
    const workers = pool.getStats().poolSize;
    const channels = Array.from({ length: workers }, () => new MessageChannel());
    const generations = new Array(workers).fill(0);
    await dataLayer.openGeneRoute(id, channels.map(channel => channel.port1));
    const route = new GeneRoute({ id, dataLayer, pool, generations });
    const sent = new Array(workers).fill(false);
    try {
      await pool.broadcast(ROUTE_OPEN, worker => {
        if (!sent[worker]) {
          sent[worker] = true;
          return { route: id, generation: 0, port: channels[worker].port2 };
        }
        // The pool replaced this worker: a new channel, whose reader end
        // reaches the reader before any delivery made for it.
        const channel = new MessageChannel();
        const generation = ++generations[worker];
        route._replacing.add(dataLayer.replaceGeneRoutePort(id, worker, channel.port1, generation).catch(error => {
          route._failure ??= error;
        }));
        return { route: id, generation, port: channel.port2 };
      }, { timeout: 30000, signal, retainAs: id });
    } catch (error) {
      await dataLayer.closeGeneRoute(id).catch(() => {});
      throw error;
    }
    return route;
  }

  /** @private */
  constructor({ id, dataLayer, pool, generations }) {
    this.id = id;
    this._dataLayer = dataLayer;
    this._pool = pool;
    this._generations = generations;
    /** Genes delivered to each worker and not yet answered. */
    this._outstanding = new Array(generations.length).fill(0);
    this._replacing = new Set();
    this._failure = null;
    this._closed = false;
    this._nextDelivery = 0;
  }

  /** A new delivery id: each delivery of the route has its own. */
  nextDeliveryId() {
    return this._nextDelivery++;
  }

  /** The workers of the route. */
  get workerCount() {
    return this._generations.length;
  }

  /** The current generation of worker `worker`'s port. */
  generation(worker) {
    return this._generations[worker];
  }

  /** Every worker's current generation. */
  generations() {
    return this._generations.slice();
  }

  /**
   * The worker a batch of `genes` genes goes to: the one with the fewest
   * genes outstanding, so a slower worker is given fewer.
   *
   * @param {number} genes
   * @returns {number}
   */
  assign(genes) {
    if (this._failure !== null) throw this._failure;
    let best = 0;
    for (let worker = 1; worker < this._outstanding.length; worker++) {
      if (this._outstanding[worker] < this._outstanding[best]) best = worker;
    }
    this._outstanding[best] += genes;
    return best;
  }

  /** A batch of `genes` genes of worker `worker` was answered (or will not be). */
  settle(worker, genes) {
    this._outstanding[worker] = Math.max(0, this._outstanding[worker] - genes);
  }

  /**
   * Close the route: the workers let their inboxes go (and the pool stops
   * replaying the route to replaced ones), then the reader lets its ports go.
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    await Promise.allSettled(this._replacing);
    const errors = [];
    if (this._pool.isReady()) {
      await this._pool.broadcast(ROUTE_CLOSE, () => ({ route: this.id }), { releases: this.id })
        .catch(error => errors.push(error));
    }
    await this._dataLayer.closeGeneRoute(this.id).catch(error => errors.push(error));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Closing a gene route failed');
  }
}
