export function verifyEvmFinality(args: { client: any; chainId: number; row: { hash?: string | null }; confirmations: number }): Promise<{ final: boolean; hash?: string; success?: boolean }>;
