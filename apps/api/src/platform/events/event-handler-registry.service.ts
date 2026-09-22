import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export type EventHandler = (db: Kysely<Database>, organisationId: string, payload: Record<string, unknown>) => Promise<void>;

/**
 * In-process registry mapping a consumer's `handler_ref` (declared in its
 * manifest's `eventsConsumed` and recorded in `event_consumer_registrations`
 * at registration time) to the actual function to invoke. This exists
 * because P1 apps are still compiled into the same process (Architecture §3
 * v1 packaging) - the DB row says WHO should handle an event, this map says
 * WHAT CODE that resolves to right now, in this build.
 */
@Injectable()
export class EventHandlerRegistryService {
  private readonly handlers = new Map<string, EventHandler>();

  register(handlerRef: string, handler: EventHandler): void {
    this.handlers.set(handlerRef, handler);
  }

  get(handlerRef: string): EventHandler | undefined {
    return this.handlers.get(handlerRef);
  }
}
