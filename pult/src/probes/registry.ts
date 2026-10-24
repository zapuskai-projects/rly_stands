import { ASYNCAPI_EXECUTORS } from './asyncapi';
import { BANK_EXECUTORS } from './bank';
import { BANK_HTTP_EXECUTORS } from './bank-http';
import { BANK_RUN_EXECUTORS } from './bank-run';
import { CAMUNDA_EXECUTORS } from './camunda';
import { CLICKHOUSE_EXECUTORS } from './clickhouse';
import { DIAGRAM_EXECUTORS } from './diagrams';
import { ELASTICSEARCH_EXECUTORS } from './elasticsearch';
import { FILE_EXECUTORS } from './files';
import { GRPC_EXECUTORS } from './grpc';
import { JSONSCHEMA_EXECUTORS } from './jsonschema';
import { JUNIT_EXECUTORS } from './junit';
import { KAFKA_EXECUTORS } from './kafka';
import { KIT_EXECUTORS } from './kit';
import { LINUX_EXECUTORS } from './linux';
import { MONITORING_EXECUTORS } from './monitoring';
import { OPENAPI_EXECUTORS } from './openapi';
import { PLATFORM_EXECUTORS } from './platform';
import { POSTGRES_EXECUTORS } from './postgres';
import { RABBITMQ_EXECUTORS } from './rabbitmq';
import type { ExecutorTable } from './types';
import { WEBHOOK_RECEIVER_EXECUTORS } from './webhook-receiver';
import { XML_EXECUTORS } from './xml';

export const EXECUTORS: ExecutorTable = {
  ...RABBITMQ_EXECUTORS,
  ...KAFKA_EXECUTORS,
  ...CAMUNDA_EXECUTORS,
  ...ELASTICSEARCH_EXECUTORS,
  ...POSTGRES_EXECUTORS,
  ...CLICKHOUSE_EXECUTORS,
  ...OPENAPI_EXECUTORS,
  ...JSONSCHEMA_EXECUTORS,
  ...XML_EXECUTORS,
  ...ASYNCAPI_EXECUTORS,
  ...GRPC_EXECUTORS,
  ...DIAGRAM_EXECUTORS,
  ...MONITORING_EXECUTORS,
  ...LINUX_EXECUTORS,
  ...FILE_EXECUTORS,
  ...JUNIT_EXECUTORS,
  ...BANK_EXECUTORS,
  ...BANK_RUN_EXECUTORS,
  ...BANK_HTTP_EXECUTORS,
  ...WEBHOOK_RECEIVER_EXECUTORS,
  ...KIT_EXECUTORS,
  ...PLATFORM_EXECUTORS,
};

export function primitiveKeys(): string[] {
  return Object.keys(EXECUTORS).sort();
}
