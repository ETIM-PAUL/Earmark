import type { Order, OrderStatus } from "@earmark/shared";

/**
 * Where orders live. The order service owns the real database (Phase 8);
 * the executor only needs these three calls.
 *
 * `replace` is compare-and-set: it writes `next` only if the stored order
 * still has `prev`'s status and updatedAt. Two workers can't both move the
 * same order, so the step that calls VTpass runs once.
 */
export interface OrderStore {
  get(id: string): Promise<Order | null>;
  replace(prev: Order, next: Order): Promise<boolean>;
  listByStatus(statuses: readonly OrderStatus[]): Promise<Order[]>;
}

export class StaleOrderError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} changed under us; another worker has it`);
    this.name = "StaleOrderError";
  }
}

/** For tests, drills and local runs. Not durable. */
export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();

  /** Seed an order, e.g. one the order service marked paid. */
  put(order: Order): void {
    this.orders.set(order.id, structuredClone(order));
  }

  async get(id: string): Promise<Order | null> {
    const o = this.orders.get(id);
    return o ? structuredClone(o) : null;
  }

  async replace(prev: Order, next: Order): Promise<boolean> {
    const cur = this.orders.get(prev.id);
    if (!cur || cur.status !== prev.status || cur.updatedAt !== prev.updatedAt) return false;
    this.orders.set(next.id, structuredClone(next));
    return true;
  }

  async listByStatus(statuses: readonly OrderStatus[]): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((o) => statuses.includes(o.status))
      .map((o) => structuredClone(o));
  }
}
