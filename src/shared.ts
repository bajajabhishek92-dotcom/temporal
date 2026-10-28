import 'dotenv/config';

export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'showcase';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill in Temporal Cloud settings.`,
    );
  }
  return value;
}

export function temporalCloudConfig() {
  const address = requireEnv('TEMPORAL_ADDRESS');
  const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || 'quickstart-abhishek-b8746e8b.jftpi';
  const apiKey = requireEnv('TEMPORAL_API_KEY');

  return {
    address,
    namespace,
    apiKey,
    connectionOptions: {
      address,
      tls: true,
      apiKey,
      metadata: {
        'temporal-namespace': namespace,
      },
    },
  };
}
