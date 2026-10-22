export interface TopicNames {
  paymentsCreated: string;
  statusChanged: string;
  antifraudDecisions: string;
  notificationsExchange: string;
  notificationsQueue: string;
  notificationsDlx: string;
  notificationsDlq: string;
}

export const NOTIFICATION_ROUTING_KEY = 'notification';
export const TOPIC_PARTITIONS = 3;

export function topicNames(prefix = ''): TopicNames {
  return {
    paymentsCreated: `${prefix}bank.payments.created`,
    statusChanged: `${prefix}bank.payments.status-changed`,
    antifraudDecisions: `${prefix}bank.antifraud.decisions`,
    notificationsExchange: `${prefix}bank.notifications`,
    notificationsQueue: `${prefix}bank.notifications`,
    notificationsDlx: `${prefix}bank.notifications.dlx`,
    notificationsDlq: `${prefix}bank.notifications.dlq`,
  };
}

let activeTopics: TopicNames = topicNames();

export function configureTopics(prefix: string): TopicNames {
  activeTopics = topicNames(prefix);
  return activeTopics;
}

export function getTopics(): TopicNames {
  return activeTopics;
}
