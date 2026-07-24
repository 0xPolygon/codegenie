export type Config = { url: string; retries: number };

export function connect(config: Config): boolean {
  return config.url.startsWith("https://") && config.retries >= 0;
}

export function useConfig(input: unknown): boolean {
  const config = input as Config;
  return connect(config);
}
